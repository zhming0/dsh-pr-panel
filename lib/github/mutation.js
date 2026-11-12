/** GitHub GraphQL mutations sent once through `gh`, with the document and variables as JSON on standard input. */
import { z } from 'zod';
import { GhUnavailableError } from './gh.js';
/** HTTP statuses that mean GitHub refused the request, so it changed nothing. */
const REFUSED = /\(HTTP (?:400|401|403|404|409|422)\)/;
/**
 * GraphQL error types that mean GitHub refused a mutation before applying it. An error without one of them, such as
 * GitHub's "Something went wrong … may be the result of a timeout", leaves the outcome unknown.
 */
const REFUSALS = new Set(['FORBIDDEN', 'INSUFFICIENT_SCOPES', 'NOT_FOUND', 'RATE_LIMITED', 'UNPROCESSABLE']);
const graphqlErrors = z.object({ errors: z.array(z.object({ message: z.string(), type: z.string().optional() })).min(1) });
/**
 * Send one mutation with its query and variables as JSON on stdin. The mutation is never retried.
 * @param gh - runs `gh` on the Host.
 * @param host - GitHub host the mutation goes to.
 * @param mutation - the document, its field, and its variables.
 * @param signal - cancellation of the request.
 * @returns the payload of `mutation.field`; `failed` when GitHub reports a refusal by its HTTP status or GraphQL error
 * type, or `gh` cannot start, else `unknown`.
 */
export async function sendMutation(gh, host, mutation, signal) {
    let output;
    try {
        output = await gh(['api', 'graphql', '--hostname', host, '--input', '-'], signal, JSON.stringify({ query: mutation.query, variables: mutation.variables }));
    }
    catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        return { ok: false, code: error instanceof GhUnavailableError ? 'failed' : 'unknown', message };
    }
    const body = parse(output.stdout);
    // A payload means GitHub applied the mutation, even beside errors about the fields it selects.
    const payload = z.object({ data: z.record(z.string(), z.unknown()) }).safeParse(body);
    const value = payload.success ? payload.data.data[mutation.field] : undefined;
    if (value !== undefined && value !== null)
        return { ok: true, payload: value };
    const errors = graphqlErrors.safeParse(body);
    if (errors.success) {
        const refused = errors.data.errors.every(error => error.type !== undefined && REFUSALS.has(error.type));
        return { ok: false, code: refused ? 'failed' : 'unknown', message: errors.data.errors.map(error => error.message).join('; ') };
    }
    if (output.exitCode !== 0) {
        const message = output.stderr.trim() || output.stdout.trim() || `gh exited with ${output.exitCode}`;
        return { ok: false, code: REFUSED.test(output.stderr) ? 'failed' : 'unknown', message };
    }
    return { ok: false, code: 'unknown', message: `unexpected GitHub response to ${mutation.field}` };
}
function parse(text) {
    let value;
    try {
        value = JSON.parse(text);
    }
    catch (error) {
        void error; // gh prints diagnostics instead of JSON when a request fails before GitHub answers.
        return undefined;
    }
    return value;
}
