import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { chmodSync, mkdtempSync, writeFileSync, rmSync } from 'fs'
import { tmpdir } from 'os'
import { delimiter, join } from 'path'
import {
  resetLanguageServerDiscoveryCache,
  resolveLanguageServerCommand
} from './language-server-registry'

function createFakeCommand(dir: string, name: string, exitCode = 0): string {
  const isWindows = process.platform === 'win32'
  const commandPath = join(dir, isWindows ? `${name}.cmd` : name)
  writeFileSync(
    commandPath,
    isWindows ? `@echo off\r\nexit /b ${exitCode}\r\n` : `#!/bin/sh\nexit ${exitCode}\n`
  )
  if (!isWindows) {
    chmodSync(commandPath, 0o755)
  }
  return commandPath
}

describe('language-server-registry', () => {
  let originalPath: string | undefined
  let dir: string

  beforeEach(() => {
    originalPath = process.env.PATH
    dir = mkdtempSync(join(tmpdir(), 'orca-lsp-registry-'))
    process.env.PATH = originalPath ? `${dir}${delimiter}${originalPath}` : dir
    resetLanguageServerDiscoveryCache()
  })

  afterEach(() => {
    process.env.PATH = originalPath
    resetLanguageServerDiscoveryCache()
    rmSync(dir, { recursive: true, force: true })
  })

  it('discovers configured language servers from PATH', async () => {
    const commandPath = createFakeCommand(dir, 'rust-analyzer')

    await expect(resolveLanguageServerCommand('rust')).resolves.toEqual({
      ok: true,
      command: { command: commandPath, args: [] }
    })
  })

  it('rejects configured language servers that fail their startup probe', async () => {
    createFakeCommand(dir, 'rust-analyzer', 1)

    const result = await resolveLanguageServerCommand('rust')

    expect(result.ok).toBe(false)
    if (result.ok) {
      throw new Error('expected rust-analyzer discovery to fail')
    }
    expect(result.reason).toContain('rust-analyzer')
  })

  it('does not fall back to the legacy TypeScript language server', async () => {
    createFakeCommand(dir, 'typescript-language-server')

    const result = await resolveLanguageServerCommand('typescript')

    expect(result.ok).toBe(false)
    if (result.ok) {
      throw new Error('expected TypeScript LSP discovery to fail')
    }
    expect(result.reason).not.toContain('typescript-language-server')
  })
})
