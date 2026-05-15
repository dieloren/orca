export type LspPosition = {
  line: number
  character: number
}

export type LspRange = {
  start: LspPosition
  end: LspPosition
}

export type LspLocation = {
  uri: string
  range: LspRange
}

export type LspDiagnostic = {
  range: LspRange
  severity?: number
  code?: string | number
  source?: string
  message: string
}

export type LspCompletionItem = {
  label: string
  kind?: number
  detail?: string
  documentation?: string | { kind: string; value: string }
  insertText?: string
  insertTextFormat?: number
  sortText?: string
  filterText?: string
}

export type LspCompletionResult =
  | LspCompletionItem[]
  | {
      isIncomplete?: boolean
      items: LspCompletionItem[]
    }

export type LspHover = {
  contents:
    | string
    | { kind: string; value: string }
    | { language: string; value: string }
    | (string | { kind: string; value: string } | { language: string; value: string })[]
  range?: LspRange
}

export type LspServerState = 'available' | 'unavailable'

export type LspServerStatus = {
  state: LspServerState
  languageId: string
  command?: string
  reason?: string
}

export type LspDocumentContext = {
  worktreeId: string
  worktreePath: string
  filePath: string
  languageId: string
  content: string
  connectionId?: string
  runtimeEnvironmentId?: string
}

export type LspDocumentChange = Omit<LspDocumentContext, 'worktreeId'> & {
  worktreeId?: string
}

export type LspRequestContext = Omit<LspDocumentContext, 'content'> & {
  content?: string
  position: LspPosition
}

export type LspDiagnosticsEvent = {
  worktreePath: string
  filePath: string
  languageId: string
  connectionId?: string
  diagnostics: LspDiagnostic[]
}
