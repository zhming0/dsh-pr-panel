import { describe, expect, it } from 'vitest'
import type { ChangeRequestRef } from '@deepseek-ai/dsh-experimental-forge'
import { GitHubProvider } from '../src/provider.js'

const ref: ChangeRequestRef = {
  repository: { forge: 'github', host: 'github.com', owner: 'zhming0', name: 'dsh-workbench' },
  number: 175,
}

describe('GitHubProvider', () => {
  it('recognizes GitHub remotes and pull request URLs', () => {
    const provider = new GitHubProvider(async () => ({ exitCode: 0, stdout: '', stderr: '' }), ['github.com'], 1_024)
    expect(provider.repositoryFromRemote('git@github.com:zhming0/dsh-workbench.git')).toEqual(ref.repository)
    expect(provider.changeRequestFromUrl('https://github.com/zhming0/dsh-workbench/pull/175')).toEqual(ref)
    expect(provider.changeRequestUrl(ref)).toBe('https://github.com/zhming0/dsh-workbench/pull/175')
  })

  it('reports readiness from the auth command', async () => {
    const provider = new GitHubProvider(async () => ({ exitCode: 0, stdout: '', stderr: '' }), ['github.com'], 1_024)
    await expect(provider.readiness('github.com', new AbortController().signal)).resolves.toEqual({
      state: 'ready',
      message: null,
    })
  })

  it('returns the patch from the diff command', async () => {
    const provider = new GitHubProvider(async args => {
      expect(args.slice(0, 2)).toEqual(['pr', 'diff'])
      return { exitCode: 0, stdout: 'diff --git a/a b/a\n', stderr: '' }
    }, ['github.com'], 1_024)
    await expect(provider.diff(ref, new AbortController().signal)).resolves.toBe('diff --git a/a b/a\n')
  })

  it('maps a missing pull request to not-found', async () => {
    const provider = new GitHubProvider(async () => ({
      exitCode: 404,
      stdout: JSON.stringify({ message: 'Not Found' }),
      stderr: 'request failed (HTTP 404): Not Found',
    }), ['github.com'], 1_024)
    await expect(provider.diff(ref, new AbortController().signal)).resolves.toEqual({
      code: 'not-found',
      message: 'Not Found',
    })
  })
})
