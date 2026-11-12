import { describe, expect, it, vi } from 'vitest'
import { GhOutputLimitError, GhUnavailableError, githubRunner } from '../src/github-runner.js'

function runner(fetch: typeof globalThis.fetch, overrides: { token?: string; maxOutputBytes?: number } = {}) {
  return githubRunner({
    token: async () => overrides.token ?? 'token',
    timeoutMs: 1_000,
    maxOutputBytes: overrides.maxOutputBytes ?? 1_024,
    fetch,
  })
}

const signal = new AbortController().signal

describe('githubRunner', () => {
  it('checks authentication through the REST /user route', async () => {
    const calls: Array<{ url: string; init: RequestInit | undefined }> = []
    const fetch = vi.fn(async (url: string | URL | Request, init?: RequestInit) => {
      calls.push({ url: String(url), init })
      return new Response('{}', { status: 200 })
    }) as unknown as typeof globalThis.fetch
    const output = await runner(fetch)(['auth', 'status', '--hostname', 'github.com'], signal)
    expect(output).toEqual({ exitCode: 0, stdout: '{}', stderr: '' })
    expect(calls[0]?.url).toBe('https://api.github.com/user')
    expect(new Headers(calls[0]?.init?.headers).get('authorization')).toBe('Bearer token')
  })

  it('passes the host and repository URL to token resolution', async () => {
    const requests: Array<{ host: string; repositoryUrl?: string }> = []
    const fetch = vi.fn(async () => new Response('diff --git a/a b/a\n', { status: 200 })) as unknown as typeof globalThis.fetch
    const run = githubRunner({
      token: async (request) => {
        requests.push(request)
        return 'token'
      },
      timeoutMs: 1_000,
      maxOutputBytes: 1_024,
      fetch,
    })
    await run(['pr', 'diff', '1', '--repo', 'ghe.example.com/owner/repo'], signal)
    await run(['auth', 'status', '--hostname', 'ghe.example.com'], signal)
    expect(requests).toEqual([
      {
        host: 'ghe.example.com',
        repositoryUrl: 'https://ghe.example.com/owner/repo',
      },
      { host: 'ghe.example.com' },
    ])
  })

  it('turns a GraphQL request into the API body', async () => {
    let body: unknown
    const fetch = vi.fn(async (_url: string | URL | Request, init?: RequestInit) => {
      body = JSON.parse(String(init?.body))
      return new Response(JSON.stringify({ data: {} }), { status: 200 })
    }) as unknown as typeof globalThis.fetch
    const output = await runner(fetch)([
      'api', 'graphql', '--hostname', 'github.com',
      '-f', 'query=query ($owner: String!) { viewer { login } }',
      '-f', 'owner=zhming0',
    ], signal)
    expect(output.exitCode).toBe(0)
    expect(body).toEqual({
      query: 'query ($owner: String!) { viewer { login } }',
      variables: { owner: 'zhming0' },
    })
  })

  it('resolves a repository credential for GraphQL and REST api calls', async () => {
    const requests: Array<{ host: string; repositoryUrl?: string }> = []
    const fetch = vi.fn(async () => new Response(JSON.stringify({ data: {} }), { status: 200 })) as unknown as typeof globalThis.fetch
    const run = githubRunner({
      token: async (request) => {
        requests.push(request)
        return 'token'
      },
      timeoutMs: 1_000,
      maxOutputBytes: 1_024,
      fetch,
    })
    await run([
      'api', 'graphql', '--hostname', 'github.com',
      '-f', 'query=query { viewer { login } }',
      '-f', 'owner=zhming0', '-f', 'name=dsh-workbench',
    ], signal)
    await run(['api', '--hostname', 'github.com', 'repos/zhming0/dsh-workbench/pulls/191'], signal)
    await run(['api', '--hostname', 'github.com', 'user'], signal)
    expect(requests).toEqual([
      { host: 'github.com', repositoryUrl: 'https://github.com/zhming0/dsh-workbench' },
      { host: 'github.com', repositoryUrl: 'https://github.com/zhming0/dsh-workbench' },
      { host: 'github.com' },
    ])
  })

  it('sends typed GraphQL fields as numbers', async () => {
    let body: unknown
    const fetch = vi.fn(async (_url: string | URL | Request, init?: RequestInit) => {
      body = JSON.parse(String(init?.body))
      return new Response(JSON.stringify({ data: {} }), { status: 200 })
    }) as unknown as typeof globalThis.fetch
    await runner(fetch)([
      'api', 'graphql', '--hostname', 'github.com',
      '-f', 'query=query ($number: Int!) { viewer { login } }',
      '-F', 'number=12',
      '-f', 'search=alice',
    ], signal)
    expect(body).toMatchObject({ variables: { number: 12, search: 'alice' } })
  })

  it('passes a GraphQL mutation body straight through stdin', async () => {
    let body: unknown
    const fetch = vi.fn(async (_url: string | URL | Request, init?: RequestInit) => {
      body = JSON.parse(String(init?.body))
      return new Response(JSON.stringify({ data: {} }), { status: 200 })
    }) as unknown as typeof globalThis.fetch
    const mutation = JSON.stringify({ query: 'mutation { __typename }', variables: { id: 'PR_1' } })
    await runner(fetch)([
      'api', 'graphql', '--hostname', 'github.com', '--input', '-',
    ], signal, mutation)
    expect(body).toEqual({ query: 'mutation { __typename }', variables: { id: 'PR_1' } })
  })

  it('accepts the escape-sequence flag on a compare read', async () => {
    const fetch = vi.fn(async () => new Response('diff --git a/a b/a\n', { status: 200 })) as unknown as typeof globalThis.fetch
    const output = await runner(fetch)([
      'api', '--hostname', 'github.com', '--allow-escape-sequences',
      'repos/zhming0/dsh-workbench/compare/main...head',
    ], signal)
    expect(output.exitCode).toBe(0)
  })

  it('reads a pull request diff with the diff media type', async () => {
    let accept = ''
    const fetch = vi.fn(async (_url: string | URL | Request, init?: RequestInit) => {
      accept = new Headers(init?.headers).get('accept') ?? ''
      return new Response('diff --git a/a b/a\n', { status: 200 })
    }) as unknown as typeof globalThis.fetch
    const output = await runner(fetch)([
      'pr', 'diff', '12', '--repo', 'github.com/zhming0/dsh-workbench', '--color', 'never',
    ], signal)
    expect(output.stdout).toContain('diff --git')
    expect(accept).toBe('application/vnd.github.v3.diff')
  })

  it('keeps the HTTP status and message for the provider failure mapping', async () => {
    const fetch = vi.fn(async () => new Response(JSON.stringify({ message: 'Bad credentials' }), { status: 401 })) as unknown as typeof globalThis.fetch
    const output = await runner(fetch)(['auth', 'status', '--hostname', 'github.com'], signal)
    expect(output.exitCode).toBe(401)
    expect(output.stderr).toContain('(HTTP 401)')
    expect(output.stderr).toContain('Bad credentials')
  })

  it('fails loudly without a token', async () => {
    const fetch = vi.fn() as unknown as typeof globalThis.fetch
    await expect(runner(fetch, { token: '' })(['auth', 'status'], signal)).rejects.toBeInstanceOf(GhUnavailableError)
  })

  it('caps a response body', async () => {
    const fetch = vi.fn(async () => new Response('x'.repeat(64), { status: 200 })) as unknown as typeof globalThis.fetch
    await expect(runner(fetch, { maxOutputBytes: 8 })(['auth', 'status'], signal)).rejects.toBeInstanceOf(GhOutputLimitError)
  })
})
