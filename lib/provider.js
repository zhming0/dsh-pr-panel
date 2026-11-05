/** GitHub implementation of the forge provider contract. */
import { changeRequestKey } from '@deepseek-ai/dsh-experimental-forge';
import { GhOutputLimitError, GhTimeoutError, GhUnavailableError } from './github-runner.js';
import { CHECKS_QUERY, hasGraphqlFields, HEAD_QUERY, mapCheckPageResponse, mapHeadResponse, mapSnapshotResponse, snapshotQuery } from './graphql.js';
import { checkedRepository, parsePullRequestUrl, parseRemoteUrl } from './urls.js';
import { submitGitHubReview } from './review.js';
const AUTHENTICATION = /gh auth login|authentication|bad credentials|HTTP 401/i;
/** Status code `gh api` appends to the message of a failed request. */
const HTTP_STATUS = /\(HTTP (\d{3})\)/;
/**
 * GitHub's error code for an answer over its size limits, such as a diff over
 * 300 files: `gh pr diff` prints it after the field, and `gh api` returns it in the JSON error body.
 */
const TOO_LARGE = /\btoo_large\b/;
/** A full SHA-1 or SHA-256 object name. */
const COMMIT = /^(?:[0-9a-f]{40}|[0-9a-f]{64})$/i;
/** Reads GitHub and GitHub Enterprise pull requests through a `gh` runner. */
export class GitHubProvider {
    gh;
    maxOutputBytes;
    forge = 'github';
    hosts;
    async submitReview(ref, request, signal) {
        const failure = this.hostFailure(ref.repository.host);
        if (failure !== undefined)
            return { ok: false, code: 'failed', message: failure.message };
        return await submitGitHubReview(this.gh, ref, request, signal, repositoryCredential(ref));
    }
    /**
     * @param gh - runner that executes `gh` on the host.
     * @param hosts - host names this provider serves, such as `github.com` and Enterprise hosts.
     * @param maxOutputBytes - maximum combined JSON bytes retained by an explicit check read.
     */
    constructor(gh, hosts, maxOutputBytes) {
        this.gh = gh;
        this.maxOutputBytes = maxOutputBytes;
        this.hosts = new Set(hosts.map(host => host.toLowerCase()));
    }
    repositoryFromRemote(url) {
        const location = parseRemoteUrl(url);
        if (location === undefined || !this.hosts.has(location.host))
            return undefined;
        return { forge: this.forge, ...location };
    }
    changeRequestFromUrl(url) {
        const parsed = parsePullRequestUrl(url);
        if (parsed === undefined || !this.hosts.has(parsed.host))
            return undefined;
        return { repository: { forge: this.forge, host: parsed.host, owner: parsed.owner, name: parsed.name }, number: parsed.number };
    }
    changeRequestUrl(ref) {
        const { host, owner, name } = ref.repository;
        return `https://${host}/${owner}/${name}/pull/${ref.number}`;
    }
    async fetch(refs, signal) {
        const byRepository = new Map();
        const results = new Map();
        for (const ref of refs) {
            const failure = this.hostFailure(ref.repository.host);
            if (failure !== undefined) {
                results.set(changeRequestKey(ref), failure);
                continue;
            }
            const key = `${ref.repository.host}/${ref.repository.owner}/${ref.repository.name}`;
            const group = byRepository.get(key);
            if (group === undefined)
                byRepository.set(key, [ref]);
            else
                group.push(ref);
        }
        for (const group of byRepository.values()) {
            const repository = group[0].repository;
            for (const [key, result] of await this.fetchRepository(repository, group, signal))
                results.set(key, result);
        }
        return results;
    }
    async fetchChecks(ref, signal) {
        const failure = this.hostFailure(ref.repository.host);
        if (failure !== undefined)
            return failure;
        try {
            const results = await this.fetchRepository(ref.repository, [ref], signal, true);
            // oxlint-disable-next-line typescript/no-non-null-assertion -- fetchHost returns one result for each requested ref.
            return results.get(changeRequestKey(ref));
        }
        catch (error) {
            if (signal.aborted)
                throw signal.reason;
            if (error instanceof GhUnavailableError || error instanceof GhTimeoutError || error instanceof GhOutputLimitError) {
                return { code: error instanceof GhOutputLimitError ? 'too-large' : 'unavailable', message: error.message };
            }
            throw error;
        }
    }
    async findByHead(repository, branch, signal) {
        const failure = this.hostFailure(repository.host);
        if (failure !== undefined)
            throw new Error(failure.message);
        const output = await this.gh([
            'api', 'graphql', '--hostname', repository.host,
            '-f', `query=${HEAD_QUERY}`, '-f', `owner=${repository.owner}`, '-f', `name=${repository.name}`, '-f', `branch=${branch}`,
        ], signal, undefined, repositoryCredential(repository));
        const body = parseJson(output.stdout);
        if (!hasGraphqlFields(body))
            throw new Error(`forge-github: head branch lookup failed: ${responseFailure(output, body).message}`);
        return mapHeadResponse(body, repository, branch);
    }
    /**
     * Mark a draft pull request ready for review with `gh pr ready`; one that
     * is already ready stays ready.
     */
    async markReady(ref, signal) {
        const { host, owner, name } = checkedRepository(ref);
        const failure = this.hostFailure(host);
        if (failure !== undefined)
            return { code: 'failed', message: failure.message };
        return await this.act(['pr', 'ready', String(ref.number), '--repo', `${host}/${owner}/${name}`], signal, repositoryCredential(ref));
    }
    /**
     * Merge a pull request through the REST merge endpoint with the expected
     * head commit, so GitHub refuses with 409 once new commits arrived. Unlike
     * `gh pr merge`, it never enables auto-merge, never joins a merge queue, and
     * never deletes the head branch.
     */
    async merge(ref, request, signal) {
        const { host, owner, name } = checkedRepository(ref);
        const failure = this.hostFailure(host);
        if (failure !== undefined)
            return { code: 'failed', message: failure.message };
        if (!COMMIT.test(request.headSha))
            throw new Error(`forge-github: invalid head commit ${JSON.stringify(request.headSha)}`);
        return await this.act([
            'api', '--hostname', host, '--method', 'PUT', `repos/${owner}/${name}/pulls/${ref.number}/merge`,
            '-f', `merge_method=${request.method}`, '-f', `sha=${request.headSha}`,
        ], signal, repositoryCredential(ref));
    }
    /** Read the pull request's diff with `gh pr diff`, which GitHub computes against the merge base. */
    async diff(ref, signal) {
        const { host, owner, name } = checkedRepository(ref);
        const failure = this.hostFailure(host);
        if (failure !== undefined)
            return failure;
        return await this.read(['pr', 'diff', String(ref.number), '--repo', `${host}/${owner}/${name}`, '--color', 'never'], signal, repositoryCredential(ref));
    }
    /** Read one file at a commit through the contents API in its raw form. */
    async fileText(ref, commit, path, signal) {
        const { host, owner, name } = checkedRepository(ref);
        const failure = this.hostFailure(host);
        if (failure !== undefined)
            return failure;
        if (!COMMIT.test(commit))
            throw new Error(`forge-github: invalid commit ${JSON.stringify(commit)}`);
        return await this.read([
            'api', '--hostname', host, '-H', 'Accept: application/vnd.github.raw+json',
            `repos/${owner}/${name}/contents/${encodedPath(path)}?ref=${commit}`,
        ], signal, repositoryCredential(ref));
    }
    fileUrl(ref, commit, path) {
        const { host, owner, name } = ref.repository;
        return `https://${host}/${owner}/${name}/blob/${commit}/${encodedPath(path)}`;
    }
    async readiness(host, signal) {
        const failure = this.hostFailure(host);
        if (failure !== undefined)
            return { state: 'unavailable', message: failure.message };
        try {
            const output = await this.gh(['auth', 'status', '--hostname', host], signal, undefined, { host });
            if (output.exitCode === 0)
                return { state: 'ready', message: null };
            return { state: 'unauthenticated', message: firstLine(output.stderr) ?? firstLine(output.stdout) ?? `gh is not signed in to ${host}` };
        }
        catch (error) {
            if (error instanceof GhUnavailableError)
                return { state: 'unavailable', message: error.message };
            throw error;
        }
    }
    /**
     * Run one reading `gh` command, returning its output. A refusal, a `gh` that
     * cannot start, output over `maxOutputBytes`, and a run past `timeoutMs` become failures.
     */
    async read(args, signal, credential) {
        let output;
        try {
            output = await this.attempt(args, signal, credential);
        }
        catch (error) {
            if (error instanceof GhOutputLimitError)
                return { code: 'too-large', message: error.message };
            if (error instanceof GhTimeoutError)
                return { code: 'unavailable', message: error.message };
            throw error;
        }
        if (output instanceof GhUnavailableError)
            return { code: 'unavailable', message: output.message };
        if (output.exitCode === 0)
            return output.stdout;
        const { message, status } = refusal(output);
        if (AUTHENTICATION.test(output.stderr))
            return { code: 'unauthenticated', message };
        if (TOO_LARGE.test(output.stderr) || TOO_LARGE.test(output.stdout))
            return { code: 'too-large', message };
        return { code: status === '404' || /could not resolve to a pullrequest/i.test(output.stderr) ? 'not-found' : 'unavailable', message };
    }
    /** Run one changing `gh` command; a refusal or a `gh` that cannot start becomes a failure. */
    async act(args, signal, credential) {
        const output = await this.attempt(args, signal, credential);
        if (output instanceof GhUnavailableError)
            return { code: 'failed', message: output.message };
        if (output.exitCode === 0)
            return undefined;
        const { message, status } = refusal(output);
        if (status === '409')
            return { code: 'stale', message };
        if (AUTHENTICATION.test(output.stderr))
            return { code: 'unauthenticated', message };
        return { code: 'failed', message };
    }
    /** Run one `gh` command; a `gh` that cannot start resolves to its error, and every other rejection passes on. */
    async attempt(args, signal, credential) {
        try {
            return await this.gh(args, signal, undefined, credential);
        }
        catch (error) {
            if (error instanceof GhUnavailableError)
                return error;
            throw error;
        }
    }
    hostFailure(host) {
        return this.hosts.has(host.toLowerCase()) ? undefined : {
            code: 'unavailable', message: `forge-github: host ${JSON.stringify(host)} is not configured`,
        };
    }
    async fetchRepository(repository, refs, signal, completeChecks = false) {
        const host = repository.host;
        const credential = repositoryCredential(repository);
        const query = snapshotQuery(refs);
        const output = await this.gh(['api', 'graphql', '--hostname', host, '-f', `query=${query.document}`], signal, undefined, credential);
        const body = parseJson(output.stdout);
        if (!completeChecks && hasGraphqlFields(body))
            return await mapSnapshotResponse(body, query);
        let bytes = Buffer.byteLength(output.stdout);
        const tooLarge = { code: 'too-large', message: 'GitHub check details exceed the output size limit' };
        if (bytes > this.maxOutputBytes)
            return new Map([...query.targets.values()].map(ref => [changeRequestKey(ref), tooLarge]));
        if (hasGraphqlFields(body))
            return await mapSnapshotResponse(body, query, async (id, cursor) => {
                signal.throwIfAborted();
                let page;
                try {
                    page = await this.gh(['api', 'graphql', '--hostname', host,
                        '-f', `query=${CHECKS_QUERY}`, '-f', `id=${id}`, '-f', `cursor=${cursor}`], signal, undefined, credential);
                }
                catch (error) {
                    if (signal.aborted)
                        throw signal.reason;
                    if (error instanceof GhUnavailableError || error instanceof GhTimeoutError || error instanceof GhOutputLimitError) {
                        return { ok: false, failure: { code: error instanceof GhOutputLimitError ? 'too-large' : 'unavailable', message: error.message } };
                    }
                    throw error;
                }
                bytes += Buffer.byteLength(page.stdout);
                if (bytes > this.maxOutputBytes)
                    return { ok: false, failure: tooLarge };
                const value = parseJson(page.stdout);
                return hasGraphqlFields(value) ? mapCheckPageResponse(value) : { ok: false, failure: responseFailure(page, value) };
            });
        const failure = responseFailure(output, body);
        return new Map([...query.targets.values()].map(ref => [changeRequestKey(ref), failure]));
    }
}
/** The credential context for one pull request's repository. */
function repositoryCredential(ref) {
    if ('repository' in ref) {
        const { host, owner, name } = ref.repository;
        return { host, repositoryUrl: `https://${host}/${owner}/${name}` };
    }
    return {
        host: ref.host,
        repositoryUrl: `https://${ref.host}/${ref.owner}/${ref.name}`,
    };
}
/** Why `gh` refused: GitHub's message, else its first diagnostic line, with the HTTP status it names. */
function refusal(output) {
    return {
        message: hostMessage(output.stdout) ?? firstLine(output.stderr) ?? `gh exited with ${output.exitCode}`,
        status: HTTP_STATUS.exec(output.stderr)?.[1],
    };
}
/** The `message` of the JSON error body `gh api` prints for a failed request. */
function hostMessage(stdout) {
    const body = parseJson(stdout);
    if (typeof body !== 'object' || body === null || !('message' in body) || typeof body.message !== 'string')
        return undefined;
    return body.message.trim().length > 0 ? body.message : undefined;
}
/** A repository path with each segment percent-encoded, for an API path or a web URL. */
function encodedPath(path) {
    return path.split('/').map(segment => encodeURIComponent(segment)).join('/');
}
function responseFailure(output, body) {
    const detail = typeof body === 'object' && body !== null && 'message' in body && typeof body.message === 'string'
        ? firstLine(body.message) : undefined;
    const message = firstLine(output.stderr) ?? detail
        ?? (output.exitCode === 0 ? 'unexpected GitHub response' : `gh exited with ${output.exitCode}`);
    return { code: AUTHENTICATION.test(message) ? 'unauthenticated' : 'unavailable', message };
}
function parseJson(text) {
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
function firstLine(text) {
    return text.split('\n').map(line => line.trim()).find(line => line.length > 0);
}
