import { beforeEach, describe, expect, it, vi } from 'vitest'

const {
  ghExecFileAsyncMock,
  getOwnerRepoMock,
  getIssueOwnerRepoMock,
  getWorkItemMock,
  getPRChecksMock,
  getPRCommentsMock,
  acquireMock,
  releaseMock
} = vi.hoisted(() => ({
  ghExecFileAsyncMock: vi.fn(),
  getOwnerRepoMock: vi.fn(),
  getIssueOwnerRepoMock: vi.fn(),
  getWorkItemMock: vi.fn(),
  getPRChecksMock: vi.fn(),
  getPRCommentsMock: vi.fn(),
  acquireMock: vi.fn(),
  releaseMock: vi.fn()
}))

vi.mock('./gh-utils', () => ({
  ghExecFileAsync: ghExecFileAsyncMock,
  getOwnerRepo: getOwnerRepoMock,
  getIssueOwnerRepo: getIssueOwnerRepoMock,
  acquire: acquireMock,
  release: releaseMock
}))

vi.mock('./client', () => ({
  getWorkItem: getWorkItemMock,
  getPRChecks: getPRChecksMock,
  getPRComments: getPRCommentsMock
}))

import { getWorkItemDetails } from './work-item-details'

describe('getWorkItemDetails', () => {
  beforeEach(() => {
    ghExecFileAsyncMock.mockReset()
    getOwnerRepoMock.mockReset()
    getIssueOwnerRepoMock.mockReset()
    getWorkItemMock.mockReset()
    getPRChecksMock.mockReset()
    getPRCommentsMock.mockReset()
    acquireMock.mockReset()
    releaseMock.mockReset()
    acquireMock.mockResolvedValue(undefined)
  })

  it('uses the collapsed GraphQL issue query as the hot path', async () => {
    getWorkItemMock.mockResolvedValueOnce({
      id: 'issue:923',
      type: 'issue',
      number: 923,
      title: 'Use upstream issues',
      state: 'open',
      url: 'https://github.com/stablyai/orca/issues/923',
      labels: [],
      updatedAt: '2026-04-01T00:00:00Z',
      author: 'octocat'
    })
    getIssueOwnerRepoMock.mockResolvedValue({ owner: 'stablyai', repo: 'orca' })
    ghExecFileAsyncMock.mockResolvedValueOnce({
      stdout: JSON.stringify({
        data: {
          repository: {
            issue: {
              body: 'Issue body',
              assignees: { nodes: [{ login: 'jinjing' }] },
              participants: {
                nodes: [{ login: 'octocat', avatarUrl: 'https://x/y', name: 'Octo Cat' }]
              },
              comments: {
                nodes: [
                  {
                    databaseId: 7,
                    body: 'first',
                    createdAt: '2026-04-01T00:00:00Z',
                    url: 'https://github.com/stablyai/orca/issues/923#issuecomment-7',
                    author: { login: 'octocat', avatarUrl: 'https://x/y' }
                  }
                ]
              }
            }
          }
        }
      })
    })

    const details = await getWorkItemDetails('/repo-root', 923, 'issue')

    expect(getWorkItemMock).toHaveBeenCalledWith('/repo-root', 923, 'issue')
    // Why: a single gh subprocess call replaces the previous REST + REST + GraphQL fan-out.
    expect(ghExecFileAsyncMock).toHaveBeenCalledTimes(1)
    expect(ghExecFileAsyncMock.mock.calls[0][0][0]).toBe('api')
    expect(ghExecFileAsyncMock.mock.calls[0][0][1]).toBe('graphql')
    expect(details?.body).toBe('Issue body')
    expect(details?.assignees).toEqual(['jinjing'])
    expect(details?.comments).toHaveLength(1)
    expect(details?.comments[0].id).toBe(7)
    expect(details?.participants?.[0]?.login).toBe('octocat')
  })

  it('falls back to REST + GraphQL when the collapsed issue query fails', async () => {
    getWorkItemMock.mockResolvedValueOnce({
      id: 'issue:923',
      type: 'issue',
      number: 923,
      title: 'Use upstream issues',
      state: 'open',
      url: 'https://github.com/stablyai/orca/issues/923',
      labels: [],
      updatedAt: '2026-04-01T00:00:00Z',
      author: 'octocat'
    })
    getIssueOwnerRepoMock.mockResolvedValue({ owner: 'stablyai', repo: 'orca' })
    // Collapsed GraphQL throws → fallback path picks up.
    ghExecFileAsyncMock
      .mockRejectedValueOnce(new Error('GraphQL error'))
      .mockResolvedValueOnce({ stdout: JSON.stringify({ body: 'Issue body' }) })
      .mockResolvedValueOnce({ stdout: '[]' })
      .mockResolvedValueOnce({
        stdout: JSON.stringify({
          data: { repository: { issue: { participants: { nodes: [] } } } }
        })
      })
      .mockResolvedValueOnce({
        stdout: JSON.stringify({ data: {} })
      })

    const details = await getWorkItemDetails('/repo-root', 923, 'issue')

    expect(ghExecFileAsyncMock).toHaveBeenNthCalledWith(
      2,
      ['api', '--cache', '60s', 'repos/stablyai/orca/issues/923'],
      { cwd: '/repo-root' }
    )
    expect(ghExecFileAsyncMock).toHaveBeenNthCalledWith(
      3,
      ['api', '--cache', '60s', 'repos/stablyai/orca/issues/923/comments?per_page=100'],
      { cwd: '/repo-root' }
    )
    expect(details?.body).toBe('Issue body')
  })

  it('merges GitHub viewer viewed state into PR files', async () => {
    getWorkItemMock.mockResolvedValueOnce({
      id: 'pr:42',
      type: 'pr',
      number: 42,
      title: 'Review files',
      state: 'open',
      url: 'https://github.com/stablyai/orca/pull/42',
      labels: [],
      updatedAt: '2026-04-01T00:00:00Z',
      author: null
    })
    getOwnerRepoMock.mockResolvedValue({ owner: 'stablyai', repo: 'orca' })
    getPRCommentsMock.mockResolvedValue([])
    getPRChecksMock.mockResolvedValue([])
    ghExecFileAsyncMock.mockImplementation((args: string[]) => {
      const query = args.find((arg) => arg.startsWith('query=')) ?? ''
      if (query.includes('viewerViewedState')) {
        return Promise.resolve({
          stdout: JSON.stringify({
            data: {
              repository: {
                pullRequest: {
                  id: 'PR_kwDO123',
                  files: {
                    pageInfo: { hasNextPage: false, endCursor: null },
                    nodes: [
                      { path: 'src/viewed.ts', viewerViewedState: 'VIEWED' },
                      { path: 'src/changed.ts', viewerViewedState: 'DISMISSED' }
                    ]
                  }
                }
              }
            }
          })
        })
      }
      if (query.includes('participants')) {
        return Promise.resolve({
          stdout: JSON.stringify({
            data: { repository: { pullRequest: { participants: { nodes: [] } } } }
          })
        })
      }
      const endpoint = args.find((arg) => arg.startsWith('repos/')) ?? ''
      if (endpoint === 'repos/stablyai/orca/pulls/42') {
        return Promise.resolve({
          stdout: JSON.stringify({
            body: 'PR body',
            head: { sha: 'head-sha' },
            base: { sha: 'base-sha' }
          })
        })
      }
      if (endpoint === 'repos/stablyai/orca/pulls/42/files?per_page=100') {
        return Promise.resolve({
          stdout: JSON.stringify([
            {
              filename: 'src/viewed.ts',
              status: 'modified',
              additions: 3,
              deletions: 1,
              changes: 4,
              patch: '@@'
            },
            {
              filename: 'src/changed.ts',
              status: 'modified',
              additions: 1,
              deletions: 0,
              changes: 1,
              patch: '@@'
            }
          ])
        })
      }
      return Promise.reject(new Error(`unexpected gh call: ${args.join(' ')}`))
    })

    const details = await getWorkItemDetails('/repo-root', 42, 'pr')

    expect(details?.pullRequestId).toBe('PR_kwDO123')
    expect(details?.headSha).toBe('head-sha')
    expect(details?.baseSha).toBe('base-sha')
    expect(details?.files?.map((file) => [file.path, file.viewerViewedState])).toEqual([
      ['src/viewed.ts', 'VIEWED'],
      ['src/changed.ts', 'DISMISSED']
    ])
    expect(getPRChecksMock).toHaveBeenCalledWith('/repo-root', 42, 'head-sha')
  })
})
