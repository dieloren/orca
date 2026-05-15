import type {
  LspCompletionResult,
  LspDocumentChange,
  LspDocumentContext,
  LspHover,
  LspLocation,
  LspRequestContext,
  LspServerStatus
} from '../shared/lsp-types'
import { resolveLanguageServerCommand } from '../main/lsp/language-server-registry'
import { LspProcessSession } from '../main/lsp/lsp-process-session'
import type { RelayDispatcher } from './dispatcher'

type ManagedSession = {
  key: string
  session: LspProcessSession
  idleTimer: ReturnType<typeof setTimeout> | null
}

const IDLE_SESSION_TTL_MS = 60_000

function sessionKey(args: { worktreePath: string; languageId: string }): string {
  return `${args.worktreePath}\0${args.languageId}`
}

export class LspHandler {
  private readonly dispatcher: RelayDispatcher
  private sessions = new Map<string, ManagedSession>()

  constructor(dispatcher: RelayDispatcher) {
    this.dispatcher = dispatcher
    dispatcher.onRequest('lsp.getStatus', (params) =>
      this.getStatus(params as unknown as LspDocumentChange)
    )
    dispatcher.onRequest('lsp.openDocument', (params) =>
      this.openDocument(params as unknown as LspDocumentContext)
    )
    dispatcher.onRequest('lsp.changeDocument', async (params) => {
      await this.changeDocument(params as unknown as LspDocumentChange)
      return { ok: true }
    })
    dispatcher.onRequest('lsp.closeDocument', async (params) => {
      await this.closeDocument(params as unknown as Omit<LspDocumentChange, 'content'>)
      return { ok: true }
    })
    dispatcher.onRequest('lsp.completion', (params) =>
      this.completion(params as unknown as LspRequestContext)
    )
    dispatcher.onRequest('lsp.hover', (params) =>
      this.hover(params as unknown as LspRequestContext)
    )
    dispatcher.onRequest('lsp.definition', (params) =>
      this.definition(params as unknown as LspRequestContext)
    )
    dispatcher.onRequest('lsp.getStats', async () => this.getStats())
  }

  async getStatus(args: LspDocumentChange): Promise<LspServerStatus> {
    const resolved = await resolveLanguageServerCommand(args.languageId)
    if (!resolved.ok) {
      return { state: 'unavailable', languageId: args.languageId, reason: resolved.reason }
    }
    return {
      state: 'available',
      languageId: args.languageId,
      command: [resolved.command.command, ...resolved.command.args].join(' ')
    }
  }

  async openDocument(args: LspDocumentContext): Promise<LspServerStatus> {
    const entry = await this.getOrCreateSession(args)
    try {
      await entry.session.openDocument(args.filePath, args.languageId, args.content)
    } catch (error) {
      await this.disposeBrokenSession(entry)
      throw error
    }
    return { state: 'available', languageId: args.languageId }
  }

  async changeDocument(args: LspDocumentChange): Promise<void> {
    const entry = this.sessions.get(sessionKey(args))
    if (!entry) {
      return
    }
    this.cancelIdleDispose(entry)
    try {
      await entry.session.changeDocument(args.filePath, args.content)
    } catch (error) {
      await this.disposeBrokenSession(entry)
      throw error
    }
  }

  async closeDocument(args: Omit<LspDocumentChange, 'content'>): Promise<void> {
    const entry = this.sessions.get(sessionKey(args))
    if (!entry) {
      return
    }
    try {
      await entry.session.closeDocument(args.filePath)
    } catch (error) {
      await this.disposeBrokenSession(entry)
      throw error
    }
    if (entry.session.getOpenDocumentCount() === 0) {
      this.scheduleIdleDispose(entry)
    }
  }

  async completion(args: LspRequestContext): Promise<LspCompletionResult | null> {
    const entry = await this.getOrCreateSession({ ...args, content: args.content ?? '' })
    try {
      return await entry.session.completion(args.filePath, args.position, args.content)
    } catch (error) {
      await this.disposeBrokenSession(entry)
      throw error
    }
  }

  async hover(args: LspRequestContext): Promise<LspHover | null> {
    const entry = await this.getOrCreateSession({ ...args, content: args.content ?? '' })
    try {
      return await entry.session.hover(args.filePath, args.position, args.content)
    } catch (error) {
      await this.disposeBrokenSession(entry)
      throw error
    }
  }

  async definition(args: LspRequestContext): Promise<LspLocation[]> {
    const entry = await this.getOrCreateSession({ ...args, content: args.content ?? '' })
    try {
      return await entry.session.definition(args.filePath, args.position, args.content)
    } catch (error) {
      await this.disposeBrokenSession(entry)
      throw error
    }
  }

  getStats(): {
    activeSessions: number
    sessions: { key: string; worktreePath: string; languageId: string }[]
  } {
    return {
      activeSessions: this.sessions.size,
      sessions: Array.from(this.sessions.entries()).map(([key, entry]) => ({
        key,
        worktreePath: key.split('\0')[0],
        languageId: key.split('\0')[1],
        ...entry.session.getStats()
      }))
    }
  }

  async dispose(): Promise<void> {
    const sessions = Array.from(this.sessions.values())
    this.sessions.clear()
    await Promise.all(
      sessions.map(async (entry) => {
        if (entry.idleTimer) {
          clearTimeout(entry.idleTimer)
        }
        await entry.session.dispose()
      })
    )
  }

  private async getOrCreateSession(args: LspDocumentContext): Promise<ManagedSession> {
    const key = sessionKey(args)
    const existing = this.sessions.get(key)
    if (existing) {
      this.cancelIdleDispose(existing)
      return existing
    }
    const resolved = await resolveLanguageServerCommand(args.languageId)
    if (!resolved.ok) {
      throw new Error(resolved.reason)
    }
    const entry: ManagedSession = {
      key,
      session: new LspProcessSession({
        rootPath: args.worktreePath,
        languageId: args.languageId,
        server: resolved.command,
        onDiagnostics: (event) => {
          this.dispatcher.notify('lsp.diagnostics', {
            worktreePath: args.worktreePath,
            filePath: event.filePath,
            languageId: event.languageId,
            diagnostics: event.diagnostics
          })
        }
      }),
      idleTimer: null
    }
    this.sessions.set(key, entry)
    return entry
  }

  private cancelIdleDispose(entry: ManagedSession): void {
    if (entry.idleTimer) {
      clearTimeout(entry.idleTimer)
      entry.idleTimer = null
    }
  }

  private scheduleIdleDispose(entry: ManagedSession): void {
    this.cancelIdleDispose(entry)
    entry.idleTimer = setTimeout(() => {
      if (entry.session.getOpenDocumentCount() > 0) {
        return
      }
      this.sessions.delete(entry.key)
      void entry.session.dispose()
    }, IDLE_SESSION_TTL_MS)
    entry.idleTimer.unref()
  }

  private async disposeBrokenSession(entry: ManagedSession): Promise<void> {
    this.sessions.delete(entry.key)
    if (entry.idleTimer) {
      clearTimeout(entry.idleTimer)
      entry.idleTimer = null
    }
    await entry.session.dispose().catch(() => undefined)
  }
}
