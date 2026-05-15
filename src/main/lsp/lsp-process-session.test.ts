import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { mkdtempSync, rmSync, writeFileSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'
import { LspProcessSession } from './lsp-process-session'
import type { LspDiagnostic } from '../../shared/lsp-types'

const FAKE_LSP_SERVER = String.raw`
const documents = new Map()
let buffer = Buffer.alloc(0)

function send(message) {
  const body = Buffer.from(JSON.stringify(message), 'utf8')
  process.stdout.write('Content-Length: ' + body.length + '\r\n\r\n')
  process.stdout.write(body)
}

function diagnostics(uri) {
  const text = documents.get(uri) || ''
  send({
    jsonrpc: '2.0',
    method: 'textDocument/publishDiagnostics',
    params: {
      uri,
      diagnostics: text.includes('bad')
        ? [{
            range: { start: { line: 0, character: 3 }, end: { line: 0, character: 6 } },
            severity: 1,
            source: 'fake-lsp',
            message: 'bad symbol'
          }]
        : []
    }
  })
}

function handle(message) {
  if (message.method === 'initialize') {
    send({
      jsonrpc: '2.0',
      id: message.id,
      result: {
        capabilities: {
          textDocumentSync: { openClose: true, change: 2 },
          completionProvider: { triggerCharacters: ['.'] },
          hoverProvider: true,
          definitionProvider: true
        }
      }
    })
    return
  }
  if (message.method === 'shutdown') {
    send({ jsonrpc: '2.0', id: message.id, result: null })
    return
  }
  if (message.method === 'exit') {
    process.exit(0)
  }
  if (message.method === 'textDocument/didOpen') {
    const doc = message.params.textDocument
    documents.set(doc.uri, doc.text)
    diagnostics(doc.uri)
    return
  }
  if (message.method === 'textDocument/didChange') {
    const uri = message.params.textDocument.uri
    const change = message.params.contentChanges[0]
    documents.set(uri, change.text)
    diagnostics(uri)
    return
  }
  if (message.method === 'textDocument/didClose') {
    documents.delete(message.params.textDocument.uri)
    return
  }
  if (message.method === 'textDocument/completion') {
    send({
      jsonrpc: '2.0',
      id: message.id,
      result: { isIncomplete: false, items: [{ label: 'completionItem', kind: 3 }] }
    })
    return
  }
  if (message.method === 'textDocument/hover') {
    send({
      jsonrpc: '2.0',
      id: message.id,
      result: { contents: { kind: 'markdown', value: '**hovered**' } }
    })
    return
  }
  if (message.method === 'textDocument/definition') {
    const uri = message.params.textDocument.uri
    send({
      jsonrpc: '2.0',
      id: message.id,
      result: {
        uri,
        range: { start: { line: 0, character: 0 }, end: { line: 0, character: 2 } }
      }
    })
    return
  }
  if (message.id !== undefined) {
    send({ jsonrpc: '2.0', id: message.id, result: null })
  }
}

process.stdin.on('data', chunk => {
  buffer = Buffer.concat([buffer, chunk])
  while (true) {
    const headerEnd = buffer.indexOf('\r\n\r\n')
    if (headerEnd === -1) break
    const header = buffer.subarray(0, headerEnd).toString('utf8')
    const match = /Content-Length:\s*(\d+)/i.exec(header)
    if (!match) {
      buffer = buffer.subarray(headerEnd + 4)
      continue
    }
    const length = Number(match[1])
    const start = headerEnd + 4
    const end = start + length
    if (buffer.length < end) break
    const message = JSON.parse(buffer.subarray(start, end).toString('utf8'))
    buffer = buffer.subarray(end)
    handle(message)
  }
})
`

async function waitForDiagnostics(
  events: { diagnostics: LspDiagnostic[] }[],
  count: number
): Promise<LspDiagnostic[]> {
  const startedAt = Date.now()
  while (Date.now() - startedAt < 2_000) {
    const last = events.at(-1)
    if (last && last.diagnostics.length === count) {
      return last.diagnostics
    }
    await new Promise((resolve) => setTimeout(resolve, 20))
  }
  throw new Error(`Timed out waiting for ${count} diagnostics`)
}

describe('LspProcessSession', () => {
  let dir: string
  let session: LspProcessSession | null = null

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'orca-lsp-session-'))
  })

  afterEach(async () => {
    await session?.dispose()
    session = null
    rmSync(dir, { recursive: true, force: true })
  })

  it('handles initialize, document sync, diagnostics, completion, hover, and definition', async () => {
    const serverPath = join(dir, 'fake-lsp.cjs')
    const filePath = join(dir, 'main.rs')
    const diagnostics: { diagnostics: LspDiagnostic[] }[] = []
    writeFileSync(serverPath, FAKE_LSP_SERVER)
    writeFileSync(filePath, 'fn bad() {}')

    session = new LspProcessSession({
      rootPath: dir,
      languageId: 'rust',
      server: { command: process.execPath, args: [serverPath] },
      onDiagnostics: (event) => diagnostics.push(event)
    })

    await session.openDocument(filePath, 'rust', 'fn bad() {}')
    expect(await waitForDiagnostics(diagnostics, 1)).toMatchObject([
      { message: 'bad symbol', source: 'fake-lsp' }
    ])

    const completion = await session.completion(filePath, { line: 0, character: 3 })
    expect(completion).toMatchObject({ items: [{ label: 'completionItem' }] })

    const hover = await session.hover(filePath, { line: 0, character: 3 })
    expect(hover).toEqual({ contents: { kind: 'markdown', value: '**hovered**' } })

    const definition = await session.definition(filePath, { line: 0, character: 3 })
    expect(definition).toHaveLength(1)
    expect(definition[0].range.start).toEqual({ line: 0, character: 0 })

    await session.changeDocument(filePath, 'fn ok() {}')
    expect(await waitForDiagnostics(diagnostics, 0)).toEqual([])

    await session.closeDocument(filePath)
    expect(session.getOpenDocumentCount()).toBe(0)
  })
})
