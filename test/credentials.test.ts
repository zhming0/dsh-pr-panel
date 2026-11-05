import { Context } from '@deepseek-ai/cordis'
import { afterEach, describe, expect, it, vi } from 'vitest'

import { resolveToken } from '../src/credentials.js'

const request = { host: 'github.com', repositoryUrl: 'https://github.com/o/r' }

afterEach(() => {
  vi.unstubAllEnvs()
})

describe('resolveToken', () => {
  it('prefers an explicit token', async () => {
    const ctx = new Context()
    ctx.provide('forgeCredentials', {
      resolve: async () => ({ username: 'host', password: 'host-token' }),
    } as never)
    await expect(
      resolveToken(ctx, { token: 'explicit', tokenEnv: 'GITHUB_TOKEN' }, request),
    ).resolves.toBe('explicit')
  })

  it('uses the host credential service before dsh credentials', async () => {
    const ctx = new Context()
    ctx.provide('forgeCredentials', {
      resolve: async (asked: unknown) => {
        expect(asked).toEqual(request)
        return { username: 'x-access-token', password: 'host-token' }
      },
    } as never)
    ctx.provide('credentials', {
      resolve: async () => ({ value: 'dsh-token', source: 'env' }),
    } as never)
    await expect(
      resolveToken(ctx, { tokenEnv: 'GITHUB_TOKEN' }, request),
    ).resolves.toBe('host-token')
  })

  it('falls through a missing or failing host service to dsh credentials', async () => {
    const ctx = new Context()
    ctx.provide('forgeCredentials', {
      resolve: async () => {
        throw new Error('not this host')
      },
    } as never)
    ctx.provide('credentials', {
      resolve: async () => ({ value: 'dsh-token', source: 'env' }),
    } as never)
    await expect(
      resolveToken(ctx, { tokenEnv: 'GITHUB_TOKEN' }, request),
    ).resolves.toBe('dsh-token')
  })

  it('falls back to the process environment', async () => {
    const ctx = new Context()
    vi.stubEnv('GITHUB_TOKEN', 'env-token')
    await expect(
      resolveToken(ctx, { tokenEnv: 'GITHUB_TOKEN' }, request),
    ).resolves.toBe('env-token')
  })
})
