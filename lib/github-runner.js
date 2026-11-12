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
/** Thrown when the token is missing or the network cannot be reached. */
export class GhUnavailableError extends Error {
    name = 'GhUnavailableError';
}
/** Thrown when one request outlives `timeoutMs`. */
export class GhTimeoutError extends Error {
    name = 'GhTimeoutError';
}
/** Thrown when one response body exceeds `maxOutputBytes`. */
export class GhOutputLimitError extends Error {
    name = 'GhOutputLimitError';
}
const DEFAULT_HOST = 'github.com';
const USER_AGENT = 'dsh-pr-panel';
/**
 * Build a runner that speaks the provider's `gh` argv but calls GitHub over HTTP.
 * @param config - token lookup, deadline, output limit, and optional fetch.
 * @returns the runner consumed by `GitHubProvider`.
 */
export function githubRunner(config) {
    const fetchImpl = config.fetch ?? globalThis.fetch;
    if (fetchImpl === undefined)
        throw new Error('dsh-pr-panel: fetch is not available');
    const call = async (url, init, signal, token) => {
        const response = await fetchImpl(url, {
            ...init,
            headers: { Authorization: `Bearer ${token}`, 'User-Agent': USER_AGENT, ...init.headers },
            signal,
        });
        const text = await readBody(response, config.maxOutputBytes);
        if (!response.ok) {
            return { exitCode: response.status, stdout: text, stderr: `request failed (HTTP ${response.status}): ${messageFromBody(text)}` };
        }
        return { exitCode: 0, stdout: text, stderr: '' };
    };
    const graphql = async (args, signal, token, input) => {
        let body;
        if (input !== undefined) {
            body = input;
        }
        else {
            const query = args.fields.query;
            if (query === undefined)
                throw new GhUnavailableError('gh api graphql requires a query field');
            const variables = Object.fromEntries(Object.entries(args.fields)
                .filter(([key]) => key !== 'query')
                .map(([key, value]) => [
                key,
                args.typedFields[key] === undefined ? value : typedValue(args.typedFields[key]),
            ]));
            body = JSON.stringify({ query, variables });
        }
        return await call(graphqlUrl(args.host), {
            method: 'POST',
            headers: accept('application/vnd.github+json'),
            body,
        }, signal, token);
    };
    const rest = async (args, signal, token, input) => {
        const method = args.method.toUpperCase();
        const headers = { ...accept('application/vnd.github+json'), ...args.headers };
        const url = new URL(`${restBase(args.host)}/${args.endpoint.replace(/^\/+/, '')}`);
        let body;
        if (method === 'GET') {
            for (const [key, value] of Object.entries(args.fields))
                url.searchParams.set(key, value);
        }
        else if (input !== undefined) {
            body = input;
            headers['Content-Type'] = headers['Content-Type'] ?? 'application/json';
        }
        else if (Object.keys(args.fields).length > 0) {
            body = JSON.stringify(args.fields);
            headers['Content-Type'] = 'application/json';
        }
        return await call(url.toString(), { method, headers, ...(body === undefined ? {} : { body }) }, signal, token);
    };
    const ready = async (repository, number, signal, token) => {
        const read = await graphql({
            host: repository.host,
            method: 'POST',
            endpoint: 'graphql',
            headers: {},
            fields: {
                query: `query($owner: String!, $name: String!, $number: Int!) {
          repository(owner: $owner, name: $name) { pullRequest(number: $number) { id isDraft } }
        }`,
                owner: repository.owner,
                name: repository.name,
                number: String(number),
            },
            typedFields: { number: String(number) },
            input: undefined,
        }, signal, token, undefined);
        if (read.exitCode !== 0)
            return read;
        const body = JSON.parse(read.stdout);
        const pull = body.data?.repository?.pullRequest;
        if (pull?.id === undefined)
            return { exitCode: 1, stdout: read.stdout, stderr: 'pull request not found' };
        if (pull.isDraft !== true)
            return { exitCode: 0, stdout: '', stderr: '' };
        return await graphql({
            host: repository.host,
            method: 'POST',
            endpoint: 'graphql',
            headers: {},
            fields: {
                query: `mutation($id: ID!) {
          markPullRequestReadyForReview(input: { pullRequestId: $id }) { pullRequest { isDraft } }
        }`,
                id: pull.id,
            },
            typedFields: {},
            input: undefined,
        }, signal, token, undefined);
    };
    const request = async (credential, signal, run) => {
        signal.throwIfAborted();
        const token = await config.token(credential);
        if (token === undefined || token.length === 0)
            throw new GhUnavailableError('GITHUB_TOKEN is not set');
        return await withDeadline(signal, config.timeoutMs, async (deadline) => {
            try {
                return await run(token, deadline);
            }
            catch (error) {
                if (deadline.aborted && !signal.aborted)
                    throw new GhTimeoutError(`GitHub request timed out after ${config.timeoutMs}ms`);
                signal.throwIfAborted();
                if (error instanceof GhUnavailableError || error instanceof GhTimeoutError || error instanceof GhOutputLimitError)
                    throw error;
                throw new GhUnavailableError(`GitHub request failed: ${messageOf(error)}`, { cause: error });
            }
        });
    };
    return async (args, signal, input, explicitCredential) => {
        const credential = explicitCredential ?? credentialFromArgs(args);
        const [command, subcommand] = args;
        if (command === 'auth' && subcommand === 'status') {
            return await request(credential, signal, async (token, deadline) => {
                const host = hostOf(args);
                return await call(`${restBase(host)}/user`, { method: 'GET', headers: accept('application/vnd.github+json') }, deadline, token);
            });
        }
        if (command === 'pr' && subcommand === 'diff') {
            return await request(credential, signal, async (token, deadline) => {
                const repository = repositoryOf(args);
                const number = numberOf(args);
                return await call(`${restBase(repository.host)}/repos/${repository.owner}/${repository.name}/pulls/${number}`, { method: 'GET', headers: accept('application/vnd.github.v3.diff') }, deadline, token);
            });
        }
        if (command === 'pr' && subcommand === 'ready') {
            return await request(credential, signal, async (token, deadline) => await ready(repositoryOf(args), numberOf(args), deadline, token));
        }
        if (command === 'api') {
            return await request(credential, signal, async (token, deadline) => {
                const parsed = parseApiArgs(args);
                if (parsed.endpoint === 'graphql')
                    return await graphql(parsed, deadline, token, input);
                return await rest(parsed, deadline, token, input);
            });
        }
        throw new GhUnavailableError(`unsupported gh command: ${args.join(' ')}`);
    };
}
function parseApiArgs(args) {
    let host = DEFAULT_HOST;
    let method = 'GET';
    let endpoint = '';
    const headers = {};
    const fields = {};
    const typedFields = {};
    let input;
    for (let index = 1; index < args.length; index++) {
        const arg = args[index];
        if (arg === '--hostname') {
            host = requireValue(args, ++index, arg);
            continue;
        }
        if (arg === '--method') {
            method = requireValue(args, ++index, arg);
            continue;
        }
        if (arg === '-H' || arg === '--header') {
            const header = requireValue(args, ++index, arg);
            const separator = header.indexOf(':');
            if (separator <= 0)
                throw new GhUnavailableError(`invalid header: ${header}`);
            headers[header.slice(0, separator).trim()] = header.slice(separator + 1).trim();
            continue;
        }
        if (arg === '-f' || arg === '--raw-field') {
            const field = requireValue(args, ++index, arg);
            const separator = field.indexOf('=');
            if (separator <= 0)
                throw new GhUnavailableError(`invalid field: ${field}`);
            fields[field.slice(0, separator)] = field.slice(separator + 1);
            continue;
        }
        if (arg === '-F' || arg === '--field') {
            const field = requireValue(args, ++index, arg);
            const separator = field.indexOf('=');
            if (separator <= 0)
                throw new GhUnavailableError(`invalid field: ${field}`);
            const name = field.slice(0, separator);
            fields[name] = field.slice(separator + 1);
            typedFields[name] = field.slice(separator + 1);
            continue;
        }
        if (arg === '--input') {
            input = requireValue(args, ++index, arg);
            continue;
        }
        // Upstream adds this when a diff contains control escapes; the HTTP
        // response is already unescaped, so the flag has nothing to change.
        if (arg === '--allow-escape-sequences')
            continue;
        if (arg.startsWith('-'))
            throw new GhUnavailableError(`unsupported gh api option: ${arg}`);
        if (endpoint.length > 0)
            throw new GhUnavailableError(`unexpected gh api argument: ${arg}`);
        endpoint = arg;
    }
    return { host, method, endpoint, headers, fields, typedFields, input };
}
/** Parse a `-F` value the way `gh` does for a GraphQL variable. */
function typedValue(value) {
    if (/^-?\d+$/.test(value))
        return Number(value);
    if (value === 'true')
        return true;
    if (value === 'false')
        return false;
    if (value === 'null')
        return null;
    return value;
}
function hostOf(args) {
    const index = args.indexOf('--hostname');
    return index >= 0 && args[index + 1] !== undefined ? args[index + 1] : DEFAULT_HOST;
}
function credentialFromArgs(args) {
    if (args[0] === 'pr' && (args[1] === 'diff' || args[1] === 'ready')) {
        return repositoryCredential(repositoryOf(args));
    }
    if (args[0] === 'api') {
        const parsed = parseApiArgs(args);
        const repository = repositoryOfApi(parsed);
        return repository === undefined ? { host: parsed.host } : repositoryCredential(repository);
    }
    return { host: hostOf(args) };
}
/** The repository a token resolves for, so a workspace secret can override the global one. */
function repositoryCredential(repository) {
    return {
        host: repository.host,
        repositoryUrl: `https://${repository.host}/${repository.owner}/${repository.name}`,
    };
}
/**
 * Recover the repository an `api` call targets. The provider no longer passes
 * one with each call, and the credential broker needs it to apply a
 * workspace-scoped secret. GraphQL calls carry `owner` and `name` as
 * variables; REST calls name the repository in the endpoint.
 */
function repositoryOfApi(args) {
    if (args.endpoint === 'graphql') {
        const owner = args.fields.owner;
        const name = args.fields.name;
        if (owner === undefined || name === undefined || !isSegment(owner) || !isSegment(name))
            return undefined;
        return { host: args.host, owner, name };
    }
    const match = /^repos\/([^/]+)\/([^/?#]+)/.exec(args.endpoint);
    if (match === null)
        return undefined;
    const [, owner, name] = match;
    if (owner === undefined || name === undefined || !isSegment(owner) || !isSegment(name))
        return undefined;
    return { host: args.host, owner, name };
}
function isSegment(value) {
    return /^[A-Za-z0-9_.-]+$/.test(value);
}
function repositoryOf(args) {
    const index = args.indexOf('--repo');
    const value = index >= 0 ? args[index + 1] : undefined;
    if (value === undefined)
        throw new GhUnavailableError('pr command requires --repo');
    const parts = value.split('/');
    const [host, owner, name] = parts;
    if (parts.length !== 3 || host === undefined || owner === undefined || name === undefined) {
        throw new GhUnavailableError(`invalid repository: ${value}`);
    }
    return { host, owner, name };
}
function numberOf(args) {
    const value = Number(args[2]);
    if (!Number.isSafeInteger(value) || value <= 0)
        throw new GhUnavailableError(`invalid pull request number: ${args[2]}`);
    return value;
}
function requireValue(args, index, flag) {
    const value = args[index];
    if (value === undefined)
        throw new GhUnavailableError(`${flag} requires a value`);
    return value;
}
function restBase(host) {
    return host === DEFAULT_HOST ? 'https://api.github.com' : `https://${host}/api/v3`;
}
function graphqlUrl(host) {
    return host === DEFAULT_HOST ? 'https://api.github.com/graphql' : `https://${host}/api/graphql`;
}
function accept(value) {
    return { Accept: value };
}
async function readBody(response, maxBytes) {
    const declared = Number(response.headers.get('content-length'));
    if (Number.isFinite(declared) && declared > maxBytes) {
        throw new GhOutputLimitError(`GitHub response exceeds maxOutputBytes (${maxBytes})`);
    }
    if (response.body === null) {
        const text = await response.text();
        if (byteLength(text) > maxBytes)
            throw new GhOutputLimitError(`GitHub response exceeds maxOutputBytes (${maxBytes})`);
        return text;
    }
    const reader = response.body.getReader();
    const decoder = new TextDecoder();
    let bytes = 0;
    let text = '';
    try {
        while (true) {
            const { done, value } = await reader.read();
            if (done)
                break;
            bytes += value.byteLength;
            if (bytes > maxBytes)
                throw new GhOutputLimitError(`GitHub response exceeds maxOutputBytes (${maxBytes})`);
            text += decoder.decode(value, { stream: true });
        }
        return text + decoder.decode();
    }
    finally {
        reader.releaseLock();
    }
}
function byteLength(value) {
    return Buffer.byteLength(value, 'utf8');
}
function messageFromBody(body) {
    try {
        const parsed = JSON.parse(body);
        if (typeof parsed.message === 'string' && parsed.message.length > 0)
            return parsed.message;
        const first = parsed.errors?.[0]?.message;
        if (typeof first === 'string' && first.length > 0)
            return first;
    }
    catch {
        // The body is not JSON; use its first line.
    }
    return body.split(/\r?\n/).map(line => line.trim()).find(line => line.length > 0) ?? 'no diagnostic';
}
function messageOf(error) {
    return error instanceof Error ? error.message : String(error);
}
async function withDeadline(signal, timeoutMs, run) {
    const timeout = new AbortController();
    const timer = setTimeout(() => timeout.abort(new GhTimeoutError(`GitHub request timed out after ${timeoutMs}ms`)), timeoutMs);
    timer.unref?.();
    const deadline = AbortSignal.any([signal, timeout.signal]);
    try {
        return await run(deadline);
    }
    finally {
        clearTimeout(timer);
    }
}
