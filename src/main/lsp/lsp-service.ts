/* eslint-disable max-lines -- Why: this service owns the local/SSH routing
boundary for all LSP lifecycle methods; keeping the paired paths together makes
failure cleanup and diagnostics forwarding easier to audit. */
import { BrowserWindow } from 'electron'
import type {
  LspCompletionResult,
  LspDiagnosticsEvent,
  LspDocumentChange,
  LspDocumentContext,
  LspHover,
  LspLocation,
  LspRequestContext,
  LspServerStatus
} from '../../shared/lsp-types'
import { getActiveMultiplexer } from '../ipc/ssh'
import { resolveLanguageServerCommand } from './language-server-registry'
import { LspProcessSession, type LspProcessStats } from './lsp-process-session'

type SessionKey = string

type ManagedSession = {
  key: SessionKey
  worktreePath: string
  languageId: string
  connectionId?: string
  session: LspProcessSession
  idleTimer: ReturnType<typeof setTimeout> | null
}

export type LspServiceStats = {
  activeSessions: number
  sessions: ({
    key: string
    worktreePath: string
    languageId: string
    connectionId?: string
  } & LspProcessStats)[]
}

const IDLE_SESSION_TTL_MS = 60_000

function sessionKey(args: {
  worktreePath: string
  languageId: string
  connectionId?: string
}): string {
  return `${args.connectionId ?? 'local'}\0${args.worktreePath}\0${args.languageId}`
}

function assertRuntimeSupported(args: {
  runtimeEnvironmentId?: string
  connectionId?: string
}): void {
  if (args.runtimeEnvironmentId && !args.connectionId) {
    throw new Error('LSP is not available for hosted runtime environments yet')
  }
}

function publishDiagnostics(event: LspDiagnosticsEvent): void {
  for (const win of BrowserWindow.getAllWindows()) {
    if (!win.isDestroyed()) {
      win.webContents.send('lsp:diagnostics', event)
    }
  }
}

export class LspService {
  private sessions = new Map<SessionKey, ManagedSession>()
  private remoteDiagnosticsDisposers = new Map<string, () => void>()

  async getStatus(args: {
    worktreePath: string
    languageId: string
    connectionId?: string
    runtimeEnvironmentId?: string
  }): Promise<LspServerStatus> {
    if (args.runtimeEnvironmentId && !args.connectionId) {
      return {
        state: 'unavailable',
        languageId: args.languageId,
        reason: 'LSP is not available for hosted runtime environments yet'
      }
    }
    if (args.connectionId) {
      const mux = getActiveMultiplexer(args.connectionId)
      if (!mux || mux.isDisposed()) {
        return {
          state: 'unavailable',
          languageId: args.languageId,
          reason: `No active SSH connection for "${args.connectionId}"`
        }
      }
      return (await mux.request('lsp.getStatus', {
        worktreePath: args.worktreePath,
        languageId: args.languageId
      })) as LspServerStatus
    }
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
    assertRuntimeSupported(args)
    if (args.connectionId) {
      this.ensureRemoteDiagnosticsHandler(args.connectionId)
      return this.remoteRequest(args.connectionId, 'lsp.openDocument', args)
    }
    const session = await this.getOrCreateLocalSession(args)
    try {
      await session.session.openDocument(args.filePath, args.languageId, args.content)
    } catch (error) {
      await this.disposeBrokenSession(session)
      throw error
    }
    return {
      state: 'available',
      languageId: args.languageId
    }
  }

  async changeDocument(args: LspDocumentChange): Promise<void> {
    assertRuntimeSupported(args)
    if (args.connectionId) {
      await this.remoteRequest(args.connectionId, 'lsp.changeDocument', args)
      return
    }
    const existing = this.sessions.get(sessionKey(args))
    if (!existing) {
      return
    }
    this.cancelIdleDispose(existing)
    try {
      await existing.session.changeDocument(args.filePath, args.content)
    } catch (error) {
      await this.disposeBrokenSession(existing)
      throw error
    }
  }

  async closeDocument(args: Omit<LspDocumentChange, 'content'>): Promise<void> {
    assertRuntimeSupported(args)
    if (args.connectionId) {
      await this.remoteRequest(args.connectionId, 'lsp.closeDocument', args)
      return
    }
    const existing = this.sessions.get(sessionKey(args))
    if (!existing) {
      return
    }
    try {
      await existing.session.closeDocument(args.filePath)
    } catch (error) {
      await this.disposeBrokenSession(existing)
      throw error
    }
    if (existing.session.getOpenDocumentCount() === 0) {
      this.scheduleIdleDispose(existing)
    }
  }

  async completion(args: LspRequestContext): Promise<LspCompletionResult | null> {
    assertRuntimeSupported(args)
    if (args.connectionId) {
      return this.remoteRequest(args.connectionId, 'lsp.completion', args)
    }
    const session = await this.getOrCreateLocalSession({
      ...args,
      worktreeId: args.worktreeId,
      content: args.content ?? ''
    })
    try {
      return await session.session.completion(args.filePath, args.position, args.content)
    } catch (error) {
      await this.disposeBrokenSession(session)
      throw error
    }
  }

  async hover(args: LspRequestContext): Promise<LspHover | null> {
    assertRuntimeSupported(args)
    if (args.connectionId) {
      return this.remoteRequest(args.connectionId, 'lsp.hover', args)
    }
    const session = await this.getOrCreateLocalSession({
      ...args,
      worktreeId: args.worktreeId,
      content: args.content ?? ''
    })
    try {
      return await session.session.hover(args.filePath, args.position, args.content)
    } catch (error) {
      await this.disposeBrokenSession(session)
      throw error
    }
  }

  async definition(args: LspRequestContext): Promise<LspLocation[]> {
    assertRuntimeSupported(args)
    if (args.connectionId) {
      return this.remoteRequest(args.connectionId, 'lsp.definition', args)
    }
    const session = await this.getOrCreateLocalSession({
      ...args,
      worktreeId: args.worktreeId,
      content: args.content ?? ''
    })
    try {
      return await session.session.definition(args.filePath, args.position, args.content)
    } catch (error) {
      await this.disposeBrokenSession(session)
      throw error
    }
  }

  getStats(): LspServiceStats {
    return {
      activeSessions: this.sessions.size,
      sessions: Array.from(this.sessions.values()).map((entry) => ({
        key: entry.key,
        worktreePath: entry.worktreePath,
        languageId: entry.languageId,
        connectionId: entry.connectionId,
        ...entry.session.getStats()
      }))
    }
  }

  async disposeAll(): Promise<void> {
    const sessions = Array.from(this.sessions.values())
    this.sessions.clear()
    for (const dispose of this.remoteDiagnosticsDisposers.values()) {
      dispose()
    }
    this.remoteDiagnosticsDisposers.clear()
    await Promise.all(
      sessions.map(async (entry) => {
        if (entry.idleTimer) {
          clearTimeout(entry.idleTimer)
        }
        await entry.session.dispose()
      })
    )
  }

  private async remoteRequest<T>(connectionId: string, method: string, args: unknown): Promise<T> {
    const mux = getActiveMultiplexer(connectionId)
    if (!mux || mux.isDisposed()) {
      throw new Error(`No active SSH connection for "${connectionId}"`)
    }
    return (await mux.request(method, args as Record<string, unknown>)) as T
  }

  private ensureRemoteDiagnosticsHandler(connectionId: string): void {
    if (this.remoteDiagnosticsDisposers.has(connectionId)) {
      return
    }
    const mux = getActiveMultiplexer(connectionId)
    if (!mux || mux.isDisposed()) {
      return
    }
    const disposeDiagnostics = mux.onNotificationByMethod('lsp.diagnostics', (params) => {
      const event = params as unknown as Omit<LspDiagnosticsEvent, 'connectionId'>
      publishDiagnostics({ ...event, connectionId })
    })
    const disposeMux = mux.onDispose(() => {
      this.remoteDiagnosticsDisposers.delete(connectionId)
    })
    this.remoteDiagnosticsDisposers.set(connectionId, () => {
      disposeDiagnostics()
      disposeMux()
    })
  }

  private async getOrCreateLocalSession(args: LspDocumentContext): Promise<ManagedSession> {
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
      worktreePath: args.worktreePath,
      languageId: args.languageId,
      connectionId: args.connectionId,
      session: new LspProcessSession({
        rootPath: args.worktreePath,
        languageId: args.languageId,
        server: resolved.command,
        connectionId: args.connectionId,
        onDiagnostics: (event) => {
          publishDiagnostics({
            worktreePath: args.worktreePath,
            filePath: event.filePath,
            languageId: event.languageId,
            connectionId: args.connectionId,
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
    // Why: language servers hold project indexes and file handles. Keep the
    // server warm for quick tab switches, then tear it down once Orca has no
    // open documents for that worktree/language.
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

export const lspService = new LspService()
