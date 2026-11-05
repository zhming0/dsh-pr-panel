/**
 * Token resolution for the GitHub provider.
 *
 * The provider asks this function for the credential of one host and optional
 * repository. A host that provides the optional `forgeCredentials` service
 * answers from its own secret store; otherwise the standard dsh credential
 * service and the process environment are the fallbacks. The plugin never
 * imports a deployment package, so a host without the service still works.
 */

import type { Context } from '@deepseek-ai/cordis'
import { credentialRef } from '@deepseek-ai/dsh-credentials'
import type { CredentialProvider } from '@deepseek-ai/dsh-credentials'

/** The host and repository a request addresses. */
export interface ForgeCredentialRequest {
  readonly host: string
  readonly repositoryUrl?: string
}

/** One host credential, already resolved by the deployment. */
export interface ForgeCredential {
  readonly username: string
  readonly password: string
}

/** Optional host service that resolves a credential from the deployment's store. */
export interface ForgeCredentials {
  resolve(request: ForgeCredentialRequest): Promise<ForgeCredential | undefined>
}

/** The configuration fields that choose a token source. */
export interface TokenConfig {
  readonly token?: string
  readonly tokenEnv: string
}

/**
 * Resolve one token, in order: explicit config, the optional host service,
 * dsh credentials, the process environment.
 * @param ctx - plugin context; the services are optional.
 * @param config - explicit token and credential name.
 * @param request - host and repository to resolve for.
 * @returns the token, or undefined when no source has one.
 */
export async function resolveToken(
  ctx: Context,
  config: TokenConfig,
  request: ForgeCredentialRequest,
): Promise<string | undefined> {
  if (config.token !== undefined && config.token.length > 0) return config.token

  const host = ctx.get('forgeCredentials') as ForgeCredentials | undefined
  if (host !== undefined) {
    try {
      const credential = await host.resolve(request)
      if (credential !== undefined && credential.password.length > 0) return credential.password
    } catch {
      // A deployment source that is unavailable falls through to the generic path.
    }
  }

  const credentials = ctx.get('credentials') as CredentialProvider | undefined
  if (credentials !== undefined) {
    try {
      const resolved = await credentials.resolve(credentialRef(config.tokenEnv))
      if (resolved !== undefined && resolved.value.length > 0) return resolved.value
    } catch {
      // A missing or malformed credential falls through to the environment.
    }
  }

  const ambient = process.env[config.tokenEnv]
  return ambient !== undefined && ambient.length > 0 ? ambient : undefined
}
