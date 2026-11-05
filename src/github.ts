/** Registers a GitHub forge provider that reads pull requests over the HTTP API. */

import type { Context } from '@deepseek-ai/cordis'
import z from '@deepseek-ai/schemastery'
import type {} from '@deepseek-ai/dsh-experimental-forge'
import { MAX_TIMER_DELAY_MS } from '@deepseek-ai/dsh-timeout'
import { resolveToken } from './credentials.js'
import { githubRunner } from './github-runner.js'
import { GitHubProvider } from './provider.js'

export const name = 'pr-panel-github'
export const inject = ['forge']

/** Token source, served hosts, and request limits. */
export interface Config {
  /** Token value, taking precedence over `tokenEnv`; prefer a credential reference. */
  token?: string
  /** Environment or dsh credential name that holds the token. */
  tokenEnv?: string
  /** Host names this provider serves; list GitHub Enterprise hosts explicitly. */
  hosts?: string[]
  /** Deadline in milliseconds for one request. */
  timeoutMs?: number
  /** Maximum captured bytes for one response body and combined JSON bytes of one complete check read. */
  maxOutputBytes?: number
}

export const Config: z<Config> = z.object({
  token: z.string(),
  tokenEnv: z.string().default('GITHUB_TOKEN'),
  hosts: z.array(z.string()).default(['github.com']),
  timeoutMs: z.number().default(30_000),
  maxOutputBytes: z.number().default(8_388_608),
})

const HOST = /^[a-z0-9]([a-z0-9-]*[a-z0-9])?(\.[a-z0-9]([a-z0-9-]*[a-z0-9])?)*(:\d+)?$/i
const ENVIRONMENT_NAME = /^[A-Za-z_][A-Za-z0-9_]*$/

export function apply(ctx: Context, config: Config): void {
  const resolved = config as Required<Config>
  if (resolved.token !== undefined && resolved.token.trim().length === 0) throw new Error('dsh-pr-panel: token must not be empty')
  if (!ENVIRONMENT_NAME.test(resolved.tokenEnv)) throw new Error(`dsh-pr-panel: invalid tokenEnv ${JSON.stringify(resolved.tokenEnv)}`)
  if (resolved.hosts.length === 0) throw new Error('dsh-pr-panel: hosts must list at least one host')
  for (const host of resolved.hosts) {
    if (!HOST.test(host)) throw new Error(`dsh-pr-panel: invalid host ${JSON.stringify(host)}`)
  }
  if (!Number.isSafeInteger(resolved.timeoutMs) || resolved.timeoutMs <= 0 || resolved.timeoutMs > MAX_TIMER_DELAY_MS) {
    throw new Error('dsh-pr-panel: timeoutMs must be a positive integer no greater than the runtime timer limit')
  }
  if (!Number.isSafeInteger(resolved.maxOutputBytes) || resolved.maxOutputBytes <= 0) {
    throw new Error('dsh-pr-panel: maxOutputBytes must be a positive safe integer')
  }
  const runner = githubRunner({
    token: (request) => resolveToken(ctx, resolved, request),
    timeoutMs: resolved.timeoutMs,
    maxOutputBytes: resolved.maxOutputBytes,
  })
  ctx.forge.register(new GitHubProvider(runner, resolved.hosts, resolved.maxOutputBytes))
}
