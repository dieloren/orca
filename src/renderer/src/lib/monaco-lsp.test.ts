import { afterEach, describe, expect, it, vi } from 'vitest'
import type {
  LspCompletionResult,
  LspDiagnosticsEvent,
  LspDocumentChange,
  LspDocumentContext,
  LspHover,
  LspLocation,
  LspRequestContext,
  LspServerStatus
} from '../../../shared/lsp-types'

type CompletionProvider = {
  provideCompletionItems: (
    model: ModelMock,
    position: { lineNumber: number; column: number }
  ) => Promise<{ suggestions: Record<string, unknown>[] }>
}

type ModelMock = {
  uri: { toString: () => string }
  getValue: () => string
  getWordUntilPosition: () => { startColumn: number; endColumn: number }
}

function deferred<T>(): {
  promise: Promise<T>
  resolve: (value: T) => void
} {
  let resolve!: (value: T) => void
  const promise = new Promise<T>((resolvePromise) => {
    resolve = resolvePromise
  })
  return { promise, resolve }
}

async function waitForAssertion(assertion: () => void): Promise<void> {
  const startedAt = Date.now()
  let lastError: unknown
  while (Date.now() - startedAt < 1_000) {
    try {
      assertion()
      return
    } catch (error) {
      lastError = error
      await new Promise((resolve) => setTimeout(resolve, 10))
    }
  }
  throw lastError
}

function installWindowApi(lsp: unknown): void {
  Object.defineProperty(globalThis, 'window', {
    value: { api: { lsp } },
    configurable: true
  })
}

function createLspApi(
  overrides: Partial<{
    getStatus: (args: LspDocumentChange) => Promise<LspServerStatus>
    openDocument: (args: LspDocumentContext) => Promise<LspServerStatus>
    changeDocument: (args: LspDocumentChange) => Promise<void>
    closeDocument: (args: Omit<LspDocumentChange, 'content'>) => Promise<void>
    completion: (args: LspRequestContext) => Promise<LspCompletionResult | null>
    hover: (args: LspRequestContext) => Promise<LspHover | null>
    definition: (args: LspRequestContext) => Promise<LspLocation[]>
    getStats: () => Promise<{ activeSessions: number; sessions: Record<string, unknown>[] }>
    onDiagnostics: (callback: (event: LspDiagnosticsEvent) => void) => () => void
  }> = {}
) {
  const api = {
    getStatus: vi.fn(async (args: LspDocumentChange) => ({
      state: 'available' as const,
      languageId: args.languageId
    })),
    openDocument: vi.fn(async (args: LspDocumentContext) => ({
      state: 'available' as const,
      languageId: args.languageId
    })),
    changeDocument: vi.fn(async () => undefined),
    closeDocument: vi.fn(async () => undefined),
    completion: vi.fn(async () => null),
    hover: vi.fn(async () => null),
    definition: vi.fn(async () => []),
    getStats: vi.fn(async () => ({ activeSessions: 0, sessions: [] })),
    onDiagnostics: vi.fn((_callback: (event: LspDiagnosticsEvent) => void) => () => {})
  }
  return { ...api, ...overrides }
}

function createMonacoMock(
  modelUri = 'file:///tmp/project/main.c',
  content = 'struct Foo foo;'
): {
  monaco: never
  model: ModelMock
  completionProviders: Map<string, CompletionProvider>
  setModelContent: (value: string) => void
} {
  let modelContent = content
  const model: ModelMock = {
    uri: { toString: () => modelUri },
    getValue: () => modelContent,
    getWordUntilPosition: () => ({ startColumn: 4, endColumn: 7 })
  }
  const models = new Map([[modelUri, model]])
  const completionProviders = new Map<string, CompletionProvider>()
  class Range {
    constructor(
      readonly startLineNumber: number,
      readonly startColumn: number,
      readonly endLineNumber: number,
      readonly endColumn: number
    ) {}
  }
  const monaco = {
    Range,
    Uri: {
      parse: (value: string) => ({ toString: () => value })
    },
    MarkerSeverity: {
      Error: 8,
      Warning: 4,
      Info: 2,
      Hint: 1
    },
    languages: {
      CompletionItemKind: {
        Text: 1,
        Method: 2,
        Function: 3,
        Constructor: 4,
        Field: 5,
        Variable: 6,
        Class: 7,
        Interface: 8,
        Module: 9,
        Property: 10,
        Value: 11,
        Enum: 12,
        Keyword: 13,
        Snippet: 14,
        File: 15,
        Reference: 16,
        Event: 17,
        Operator: 18,
        TypeParameter: 19
      },
      CompletionItemInsertTextRule: {
        InsertAsSnippet: 4
      },
      registerCompletionItemProvider: vi.fn((language: string, provider: CompletionProvider) => {
        completionProviders.set(language, provider)
        return { dispose: vi.fn() }
      }),
      registerHoverProvider: vi.fn(() => ({ dispose: vi.fn() })),
      registerDefinitionProvider: vi.fn(() => ({ dispose: vi.fn() }))
    },
    editor: {
      getModel: vi.fn((uri: { toString: () => string }) => models.get(uri.toString()) ?? null),
      setModelMarkers: vi.fn()
    }
  }
  return {
    monaco: monaco as never,
    model,
    completionProviders,
    setModelContent: (value: string) => {
      modelContent = value
    }
  }
}

function documentArgs(content = 'struct Foo foo;'): LspDocumentContext & { modelUri: string } {
  return {
    modelUri: 'file:///tmp/project/main.c',
    worktreeId: 'repo::/tmp/project',
    worktreePath: '/tmp/project',
    filePath: '/tmp/project/main.c',
    languageId: 'c',
    content
  }
}

afterEach(() => {
  vi.restoreAllMocks()
  Reflect.deleteProperty(globalThis, 'window')
})

describe('monaco-lsp', () => {
  it('keeps the LSP document open while split panes share the same Monaco model', async () => {
    vi.resetModules()
    const api = createLspApi()
    installWindowApi(api)
    const { monaco } = createMonacoMock()
    const { registerMonacoLspDocument } = await import('./monaco-lsp')

    const disposeFirst = registerMonacoLspDocument(monaco, documentArgs())
    await waitForAssertion(() => expect(api.openDocument).toHaveBeenCalledTimes(1))
    const disposeSecond = registerMonacoLspDocument(monaco, documentArgs())

    disposeSecond()
    expect(api.closeDocument).not.toHaveBeenCalled()

    disposeFirst()
    await waitForAssertion(() => expect(api.closeDocument).toHaveBeenCalledTimes(1))
  })

  it('closes a document that finishes opening after its editor unmounts', async () => {
    vi.resetModules()
    const openDeferred = deferred<LspServerStatus>()
    const api = createLspApi({
      openDocument: vi.fn((args: LspDocumentContext) => {
        return openDeferred.promise.then(() => ({
          state: 'available' as const,
          languageId: args.languageId
        }))
      })
    })
    installWindowApi(api)
    const { monaco } = createMonacoMock()
    const { registerMonacoLspDocument } = await import('./monaco-lsp')

    const dispose = registerMonacoLspDocument(monaco, documentArgs())
    await waitForAssertion(() => expect(api.openDocument).toHaveBeenCalledTimes(1))

    dispose()
    expect(api.closeDocument).not.toHaveBeenCalled()
    openDeferred.resolve({ state: 'available', languageId: 'c' })

    await waitForAssertion(() => expect(api.closeDocument).toHaveBeenCalledTimes(1))
  })

  it('uses completion text edits without resending full document content per request', async () => {
    vi.resetModules()
    const api = createLspApi({
      completion: vi.fn(async () => ({
        isIncomplete: false,
        items: [
          {
            label: 'alpha',
            insertText: 'ignored',
            textEdit: {
              range: { start: { line: 0, character: 1 }, end: { line: 0, character: 4 } },
              newText: 'alpha()'
            },
            additionalTextEdits: [
              {
                range: { start: { line: 0, character: 0 }, end: { line: 0, character: 0 } },
                newText: '#include <alpha.h>\n'
              }
            ]
          }
        ]
      }))
    })
    installWindowApi(api)
    const { monaco, model, completionProviders } = createMonacoMock()
    const { registerMonacoLspDocument } = await import('./monaco-lsp')

    const dispose = registerMonacoLspDocument(monaco, documentArgs())
    await waitForAssertion(() => expect(api.openDocument).toHaveBeenCalledTimes(1))

    const provider = completionProviders.get('c')
    if (!provider) {
      throw new Error('expected C completion provider to be registered')
    }
    const result = await provider.provideCompletionItems(model, { lineNumber: 1, column: 7 })

    expect(api.completion).toHaveBeenCalledWith(
      expect.not.objectContaining({ content: expect.any(String) })
    )
    expect(result.suggestions[0]).toMatchObject({
      label: 'alpha',
      insertText: 'alpha()',
      range: {
        startLineNumber: 1,
        startColumn: 2,
        endLineNumber: 1,
        endColumn: 5
      },
      additionalTextEdits: [
        {
          text: '#include <alpha.h>\n',
          range: {
            startLineNumber: 1,
            startColumn: 1,
            endLineNumber: 1,
            endColumn: 1
          }
        }
      ]
    })

    dispose()
  })
})
