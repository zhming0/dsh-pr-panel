/**
 * A `gh`-compatible command runner backed by the GitHub HTTP API.
 *
 * The upstream forge provider is written against the GitHub CLI's argv and
 * output shapes. Keeping that interface lets this repository reuse the
 * provider, GraphQL documents, and review writer while replacing only the
 * process boundary: no `gh` binary and no host subprocess are involved.
 *
 * The runner understands the small command surface the provider uses:
 * `auth status`, `pr diff`, `pr ready`, and `api` (REST and GraphQL).
 */
/** Complete output of one request that reached an HTTP status. */
export interface GhOutput {
    readonly exitCode: number;
    readonly stdout: string;
    readonly stderr: string;
}
/** Runs one `gh`-shaped command; rejects when no HTTP status was reached. */
export type GhRunner = (args: readonly string[], signal: AbortSignal, input?: string, credential?: GitHubCredentialRequest) => Promise<GhOutput>;
/** One host and optional repository whose credential a request needs. */
export interface GitHubCredentialRequest {
    readonly host: string;
    readonly repositoryUrl?: string;
}
/** Token lookup and request limits for one runner. */
export interface GitHubRunnerConfig {
    /** Resolves the token for each request, so a rotated credential is used next time. */
    readonly token: (request: GitHubCredentialRequest) => Promise<string | undefined>;
    /** Deadline in milliseconds for one request. */
    readonly timeoutMs: number;
    /** Maximum captured bytes for one response body. */
    readonly maxOutputBytes: number;
    /** Injectable fetch for tests. */
    readonly fetch?: typeof fetch;
}
/** Thrown when the token is missing or the network cannot be reached. */
export declare class GhUnavailableError extends Error {
    name: string;
}
/** Thrown when one request outlives `timeoutMs`. */
export declare class GhTimeoutError extends Error {
    name: string;
}
/** Thrown when one response body exceeds `maxOutputBytes`. */
export declare class GhOutputLimitError extends Error {
    name: string;
}
/**
 * Build a runner that speaks the provider's `gh` argv but calls GitHub over HTTP.
 * @param config - token lookup, deadline, output limit, and optional fetch.
 * @returns the runner consumed by `GitHubProvider`.
 */
export declare function githubRunner(config: GitHubRunnerConfig): GhRunner;
