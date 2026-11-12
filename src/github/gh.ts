/**
 * The `gh` command surface the vendored provider was written against.
 *
 * Upstream runs the GitHub CLI on the host. This bundle supplies the same
 * types and errors from its HTTP runner, so the provider code stays a copy of
 * the release it came from. See `src/github-runner.ts` for the transport.
 */
export { GhOutputLimitError, GhTimeoutError, GhUnavailableError } from '../github-runner.js'
export type { GhOutput, GhRunner } from '../github-runner.js'
