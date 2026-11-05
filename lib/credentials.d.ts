/**
 * Token resolution for the GitHub provider.
 *
 * The provider asks this function for the credential of one host and optional
 * repository. A host that provides the optional `forgeCredentials` service
 * answers from its own secret store; otherwise the standard dsh credential
 * service and the process environment are the fallbacks. The plugin never
 * imports a deployment package, so a host without the service still works.
 */
import type { Context } from '@deepseek-ai/cordis';
/** The host and repository a request addresses. */
export interface ForgeCredentialRequest {
    readonly host: string;
    readonly repositoryUrl?: string;
}
/** One host credential, already resolved by the deployment. */
export interface ForgeCredential {
    readonly username: string;
    readonly password: string;
}
/** Optional host service that resolves a credential from the deployment's store. */
export interface ForgeCredentials {
    resolve(request: ForgeCredentialRequest): Promise<ForgeCredential | undefined>;
}
/** The configuration fields that choose a token source. */
export interface TokenConfig {
    readonly token?: string;
    readonly tokenEnv: string;
}
/**
 * Resolve one token, in order: explicit config, the optional host service,
 * dsh credentials, the process environment.
 * @param ctx - plugin context; the services are optional.
 * @param config - explicit token and credential name.
 * @param request - host and repository to resolve for.
 * @returns the token, or undefined when no source has one.
 */
export declare function resolveToken(ctx: Context, config: TokenConfig, request: ForgeCredentialRequest): Promise<string | undefined>;
