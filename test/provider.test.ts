import { describe, expect, it } from 'vitest'
import type { ChangeRequestRef } from '@deepseek-ai/dsh-experimental-forge'
import { GitHubProvider } from '../src/github/provider.js'

const ref: ChangeRequestRef = {
  repository: { forge: 'github', host: 'github.com', owner: 'zhming0', name: 'dsh-workbench' },
  number: 175,
}

const limits = { maxOutputBytes: 1_024, maxReviewThreads: 100, maxCommits: 10, maxViewedFiles: 10 }

describe('GitHubProvider', () => {
  it('recognizes GitHub remotes and pull request URLs', () => {
    const provider = new GitHubProvider(async () => ({ exitCode: 0, stdout: '', stderr: '' }), ['github.com'], limits)
    expect(provider.repositoryFromRemote('git@github.com:zhming0/dsh-workbench.git')).toEqual(ref.repository)
    expect(provider.changeRequestFromUrl('https://github.com/zhming0/dsh-workbench/pull/175')).toEqual(ref)
    expect(provider.changeRequestUrl(ref)).toBe('https://github.com/zhming0/dsh-workbench/pull/175')
  })

  it('reports readiness from the auth command', async () => {
    const provider = new GitHubProvider(async () => ({ exitCode: 0, stdout: '', stderr: '' }), ['github.com'], limits)
    await expect(provider.readiness('github.com', new AbortController().signal)).resolves.toEqual({
      state: 'ready',
      message: null,
    })
  })

  it('reads a file at a commit through the contents API', async () => {
    const commit = 'a'.repeat(40)
    const provider = new GitHubProvider(async args => {
      expect(args).toEqual([
        'api', '--hostname', 'github.com', '-H', 'Accept: application/vnd.github.raw+json',
        `repos/zhming0/dsh-workbench/contents/README.md?ref=${commit}`,
      ])
      return { exitCode: 0, stdout: '# pr panel\n', stderr: '' }
    }, ['github.com'], limits)
    await expect(provider.fileText(ref, commit, 'README.md', new AbortController().signal)).resolves.toBe('# pr panel\n')
  })

  it('maps a missing pull request to not-found', async () => {
    const provider = new GitHubProvider(async () => ({
      exitCode: 404,
      stdout: JSON.stringify({ message: 'Not Found' }),
      stderr: 'request failed (HTTP 404): Not Found',
    }), ['github.com'], limits)
    await expect(provider.fileText(ref, 'b'.repeat(40), 'README.md', new AbortController().signal)).resolves.toEqual({
      code: 'not-found',
      message: 'Not Found',
    })
  })
})
