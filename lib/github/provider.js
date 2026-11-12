/** GitHub implementation of the forge provider contract. */
import { changeRequestKey } from '@deepseek-ai/dsh-experimental-forge';
import { listCommits } from './commits.js';
import { sendMutation } from './mutation.js';
import { GhOutputLimitError, GhTimeoutError, GhUnavailableError } from './gh.js';
import { readComparison } from './compare.js';
import { actionsRunOf, CHECKS_QUERY, hasGraphqlFields, HEAD_QUERY, mapCheckPageResponse, mapHeadResponse, mapPullRequestCommitsResponse, mapSnapshotResponse, mapThreadPageResponse, PULL_REQUEST_COMMITS_QUERY, snapshotQuery, THREADS_QUERY, } from './graphql.js';
import { checkedRepository, isCommit, parsePullRequestUrl, parseRemoteUrl } from './urls.js';
import { submitGitHubReview } from './review.js';
import { readViewed, writeViewed } from './viewed.js';
import { gitHubReviewerCandidates, requestGitHubReviews, updateGitHubBranch } from './overview.js';
import { writeGitHubReview } from './review-writes.js';
import { readReviewThreads } from './threads.js';
const AUTHENTICATION = /gh auth login|authentication|bad credentials|HTTP 401/i;
/** Status code `gh api` appends to the message of a failed request. */
const HTTP_STATUS = /\(HTTP (\d{3})\)/;
/**
 * GitHub's error code for an answer over its size limits, such as a file over
 * the contents API limit: `gh api` returns it in the JSON error body.
 */
const TOO_LARGE = /\btoo_large\b/;
/** HTTP status GitHub answers when it refuses to render a diff over its limits. */
const NOT_ACCEPTABLE = '406';
/** Reads GitHub and GitHub Enterprise pull requests through a `gh` runner. */
export class GitHubProvider {
    gh;
    limits;
    forge = 'github';
    hosts;
    async submitReview(ref, request, signal) {
        const failure = this.hostFailure(ref.repository.host);
        if (failure !== undefined)
            return { ok: false, code: 'failed', message: failure.message };
        return await submitGitHubReview(this.gh, ref, request, signal);
    }
    /**
     * Read the review threads of a pull request at `headSha` through GraphQL, each page naming the head it was read at.
     * @see readReviewThreads
     */
    async readReview(ref, headSha, signal) {
        const failure = this.hostFailure(ref.repository.host);
        if (failure !== undefined)
            return failure;
        if (!isCommit(headSha))
            throw new Error(`forge-github: invalid head commit ${JSON.stringify(headSha)}`);
        return await readReviewThreads(this.graphql, ref, headSha, this.limits, signal);
    }
    /**
     * Write to the review threads or the pending review of a pull request through GraphQL mutations after a check of its head.
     * @see writeGitHubReview
     */
    async writeReview(ref, write, signal) {
        const failure = this.hostFailure(ref.repository.host);
        if (failure !== undefined)
            return { ok: false, code: 'failed', message: failure.message };
        if (!isCommit(write.headSha))
            throw new Error(`forge-github: invalid head commit ${JSON.stringify(write.headSha)}`);
        return await writeGitHubReview(this.graphql, this.gh, ref, write, signal);
    }
    /**
     * @param gh - runner that executes `gh` on the host.
     * @param hosts - host names this provider serves, such as `github.com` and Enterprise hosts.
     * @param limits - bounds on retained check and review bytes, counted and read review threads, listed commits, and listed
     * viewed files.
     */
    constructor(gh, hosts, limits) {
        this.gh = gh;
        this.limits = limits;
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
        const byHost = new Map();
        const results = new Map();
        for (const ref of refs) {
            const failure = this.hostFailure(ref.repository.host);
            if (failure !== undefined) {
                results.set(changeRequestKey(ref), failure);
                continue;
            }
            const group = byHost.get(ref.repository.host);
            if (group === undefined)
                byHost.set(ref.repository.host, [ref]);
            else
                group.push(ref);
        }
        for (const [host, group] of byHost) {
            for (const [key, result] of await this.fetchHost(host, group, signal))
                results.set(key, result);
        }
        return results;
    }
    async fetchChecks(ref, signal) {
        const failure = this.hostFailure(ref.repository.host);
        if (failure !== undefined)
            return failure;
        try {
            const results = await this.fetchHost(ref.repository.host, [ref], signal, true);
            // oxlint-disable-next-line typescript/no-non-null-assertion -- fetchHost returns one result for each requested ref.
            return results.get(changeRequestKey(ref));
        }
        catch (error) {
            if (signal.aborted)
                throw signal.reason;
            return processFailure(error);
        }
    }
    async findByHead(repository, branch, signal) {
        const failure = this.hostFailure(repository.host);
        if (failure !== undefined)
            throw new Error(failure.message);
        const output = await this.gh([
            'api', 'graphql', '--hostname', repository.host,
            '-f', `query=${HEAD_QUERY}`, '-f', `owner=${repository.owner}`, '-f', `name=${repository.name}`, '-f', `branch=${branch}`,
        ], signal);
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
        return await this.act(['pr', 'ready', String(ref.number), '--repo', `${host}/${owner}/${name}`], signal);
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
        if (!isCommit(request.headSha))
            throw new Error(`forge-github: invalid head commit ${JSON.stringify(request.headSha)}`);
        return await this.act([
            'api', '--hostname', host, '--method', 'PUT', `repos/${owner}/${name}/pulls/${ref.number}/merge`,
            '-f', `merge_method=${request.method}`, '-f', `sha=${request.headSha}`,
        ], signal);
    }
    /**
     * Read the pull request's diff at `headSha`. One GraphQL read names the
     * current head and the base commit GitHub recorded with it; a head other
     * than `headSha` returns `stale`. Otherwise the compare endpoint reads the
     * patch from the merge base of that base commit and `headSha`, as the pull
     * request's own diff does, with both ends fixed. Given the `base` the latest
     * status recorded with `headSha`, the comparison from it runs while the
     * GraphQL read confirms the head; a stale head or another base commit
     * cancels that comparison and waits for it to end before the read returns.
     */
    async diff(ref, headSha, signal, base) {
        const { host, owner, name } = checkedRepository(ref);
        const failure = this.hostFailure(host);
        if (failure !== undefined)
            return failure;
        if (!isCommit(headSha))
            throw new Error(`forge-github: invalid head commit ${JSON.stringify(headSha)}`);
        if (base !== undefined && !isCommit(base))
            throw new Error(`forge-github: invalid base commit ${JSON.stringify(base)}`);
        const compare = async (from, operation) => await readComparison(async (args, inner) => await this.read(args, inner), ref.repository, from, headSha, operation);
        const speculation = new AbortController();
        const early = base === undefined ? undefined : { base, patch: compare(base, AbortSignal.any([signal, speculation.signal])) };
        // The early comparison is observed here, so a cancelled or unused one never rejects unhandled.
        const settled = early?.patch.then(() => undefined, () => undefined);
        const discard = async () => {
            speculation.abort();
            await settled;
        };
        try {
            const output = await this.read([
                'api', 'graphql', '--hostname', host,
                '-f', `query=${PULL_REQUEST_COMMITS_QUERY}`, '-f', `owner=${owner}`, '-f', `name=${name}`, '-F', `number=${ref.number}`,
            ], signal);
            if (typeof output !== 'string')
                return output;
            const commits = mapPullRequestCommitsResponse(parseJson(output));
            if (commits === undefined)
                return { code: 'unavailable', message: 'unexpected GitHub response to the pull request commit read' };
            if (commits.head.toLowerCase() !== headSha.toLowerCase()) {
                return { code: 'stale', message: `the pull request head moved from ${headSha} to ${commits.head}` };
            }
            if (early?.base.toLowerCase() === commits.base.toLowerCase())
                return await early.patch;
            await discard();
            return await compare(commits.base, signal);
        }
        finally {
            await discard();
        }
    }
    /** Read one file at a commit through the contents API in its raw form. */
    async fileText(ref, commit, path, signal) {
        const { host, owner, name } = checkedRepository(ref);
        const failure = this.hostFailure(host);
        if (failure !== undefined)
            return failure;
        if (!isCommit(commit))
            throw new Error(`forge-github: invalid commit ${JSON.stringify(commit)}`);
        return await this.read([
            'api', '--hostname', host, '-H', 'Accept: application/vnd.github.raw+json',
            `repos/${owner}/${name}/contents/${encodedPath(path)}?ref=${commit}`,
        ], signal);
    }
    /** List the pull request's commits through GraphQL, at most `maxCommits`, all read at one head. */
    async commits(ref, signal) {
        const { host } = checkedRepository(ref);
        const failure = this.hostFailure(host);
        if (failure !== undefined)
            return failure;
        return await listCommits(this.graphql, ref, this.limits.maxCommits, signal);
    }
    /** Read the changes between two commits through the compare API in its diff form. */
    async compare(ref, base, head, signal) {
        const failure = this.hostFailure(checkedRepository(ref).host);
        if (failure !== undefined)
            return failure;
        return await readComparison(async (args, operation) => await this.read(args, operation), ref.repository, base, head, signal);
    }
    /** Read the viewer's viewed marks through GraphQL, at most `maxViewedFiles`, every page at `headSha`. */
    async viewedFiles(ref, headSha, signal) {
        const failure = this.hostFailure(checkedRepository(ref).host);
        if (failure !== undefined)
            return failure;
        return await readViewed(this.graphql, ref, headSha, this.limits.maxViewedFiles, signal);
    }
    /** Set or clear the viewer's mark with `markFileAsViewed` or `unmarkFileAsViewed` after confirming the head. */
    async setViewed(ref, request, signal) {
        const failure = this.hostFailure(checkedRepository(ref).host);
        if (failure !== undefined)
            return { code: 'failed', message: failure.message };
        return await writeViewed(this.graphql, this.mutate, ref, request, signal);
    }
    /**
     * Rerun every finished workflow run with a failed GitHub Actions job on the head commit through the REST API; GitHub
     * reruns its failed jobs with the jobs that depend on them. A run with a check still pending waits, as GitHub offers
     * no rerun of a run in progress. Every eligible run is tried, and a refusal of one is reported with the others' outcome.
     * Other checks name no rerun.
     */
    async rerunChecks(ref, request, signal) {
        const { host, owner, name } = checkedRepository(ref);
        const failure = this.hostFailure(host);
        if (failure !== undefined)
            return { code: 'failed', message: failure.message };
        if (!isCommit(request.headSha))
            throw new Error(`forge-github: invalid head commit ${JSON.stringify(request.headSha)}`);
        const snapshot = await this.fetchChecks(ref, signal);
        if ('code' in snapshot)
            return { code: snapshot.code === 'unauthenticated' ? 'unauthenticated' : 'failed', message: snapshot.message };
        if (snapshot.headSha.toLowerCase() !== request.headSha.toLowerCase()) {
            return { code: 'stale', message: `the pull request head moved from ${request.headSha} to ${snapshot.headSha}` };
        }
        const endpoint = `repos/${owner}/${name}/actions`;
        const failed = new Set();
        const running = new Set();
        for (const check of snapshot.checks) {
            const run = check.rerun === null ? undefined : actionsRunOf(check.rerun);
            if (run === undefined)
                continue;
            if (check.state === 'failure')
                failed.add(run);
            else if (check.state === 'pending')
                running.add(run);
        }
        const runs = [...failed].filter(run => !running.has(run));
        if (runs.length === 0) {
            return { code: 'failed', message: failed.size === 0 ? 'No failed GitHub Actions job of the head commit can be rerun'
                    : 'Every workflow run with a failed job is still running; rerun it once it finishes' };
        }
        const refusals = [];
        for (const run of runs) {
            const refused = await this.act(['api', '--hostname', host, '--method', 'POST', `${endpoint}/runs/${run}/rerun-failed-jobs`], signal);
            if (refused === undefined)
                continue;
            if (refused.code === 'unauthenticated')
                return refused;
            // The head was checked before the first request, so a conflict here names no new commit.
            refusals.push(`run ${run}: ${refused.message}`);
        }
        return refusals.length === 0 ? undefined
            : { code: 'failed', message: `GitHub refused to rerun ${refusals.length} of ${runs.length} workflow runs: ${refusals.join('; ')}` };
    }
    async requestReviews(ref, request, signal) {
        const failure = this.hostFailure(checkedRepository(ref).host);
        if (failure !== undefined)
            return { code: 'failed', message: failure.message };
        return await requestGitHubReviews(this.graphql, this.mutate, ref, request, signal);
    }
    async reviewerCandidates(ref, query, signal) {
        const failure = this.hostFailure(checkedRepository(ref).host);
        if (failure !== undefined)
            return failure;
        return await gitHubReviewerCandidates(this.graphql, ref, query, signal);
    }
    async updateBranch(ref, request, signal) {
        const failure = this.hostFailure(checkedRepository(ref).host);
        if (failure !== undefined)
            return { code: 'failed', message: failure.message };
        return await updateGitHubBranch(this.graphql, this.mutate, ref, request, signal);
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
            const output = await this.gh(['auth', 'status', '--hostname', host], signal);
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
    async read(args, signal) {
        let output;
        try {
            output = await this.attempt(args, signal);
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
        if (status === NOT_ACCEPTABLE || TOO_LARGE.test(output.stderr) || TOO_LARGE.test(output.stdout))
            return { code: 'too-large', message };
        return { code: status === '404' || /could not resolve to a pullrequest/i.test(output.stderr) ? 'not-found' : 'unavailable', message };
    }
    /** Run one GraphQL request; a refusal, a body that is not GraphQL, and GraphQL errors become failures. */
    graphql = async (args, signal) => {
        const output = await this.read(args, signal);
        if (typeof output !== 'string')
            return { ok: false, failure: output };
        const body = parseJson(output);
        if (!hasGraphqlFields(body))
            return { ok: false, failure: { code: 'unavailable', message: 'unexpected GitHub response' } };
        const errors = typeof body === 'object' && body !== null && 'errors' in body && Array.isArray(body.errors) ? body.errors : [];
        if (errors.length > 0)
            return { ok: false, failure: responseFailure({ exitCode: 0, stdout: output, stderr: '' }, errors[0]) };
        return { ok: true, body };
    };
    /**
     * Run one GraphQL mutation through {@link sendMutation}, which never retries it: a refusal or a `gh` that cannot
     * start is `failed`, and an answer that does not confirm the outcome is `unknown`.
     */
    mutate = async (host, mutation, signal) => {
        const sent = await sendMutation(this.gh, host, mutation, signal);
        return sent.ok ? undefined : { code: sent.code, message: sent.message };
    };
    /** Run one changing `gh` command; a refusal or a `gh` that cannot start becomes a failure. */
    async act(args, signal) {
        const output = await this.attempt(args, signal);
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
    async attempt(args, signal) {
        try {
            return await this.gh(args, signal);
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
    async fetchHost(host, refs, signal, completeChecks = false) {
        const query = snapshotQuery(refs, this.limits.maxReviewThreads);
        const output = await this.gh(['api', 'graphql', '--hostname', host, '-f', `query=${query.document}`], signal);
        const body = parseJson(output.stdout);
        // A complete check read retains every response it reads, so all of them share one byte budget.
        let bytes = Buffer.byteLength(output.stdout);
        const tooLarge = { code: 'too-large', message: 'GitHub check details exceed the output size limit' };
        const overBudget = (page) => {
            if (!completeChecks)
                return false;
            bytes += Buffer.byteLength(page.stdout);
            return bytes > this.limits.maxOutputBytes;
        };
        const continuation = async (variables, map) => {
            const page = await this.continuation(host, variables, signal);
            if (!('stdout' in page))
                return { ok: false, failure: page };
            if (overBudget(page))
                return { ok: false, failure: tooLarge };
            const value = parseJson(page.stdout);
            return hasGraphqlFields(value) ? map(value) : { ok: false, failure: responseFailure(page, value) };
        };
        const threads = async (id, cursor, first) => await continuation(['-f', `query=${THREADS_QUERY}`, '-f', `id=${id}`, '-f', `cursor=${cursor}`, '-F', `first=${first}`], mapThreadPageResponse);
        if (!completeChecks && hasGraphqlFields(body))
            return await mapSnapshotResponse(body, query, { threads });
        if (bytes > this.limits.maxOutputBytes)
            return new Map([...query.targets.values()].map(ref => [changeRequestKey(ref), tooLarge]));
        if (hasGraphqlFields(body)) {
            return await mapSnapshotResponse(body, query, { threads, checks: async (id, cursor) => await continuation(['-f', `query=${CHECKS_QUERY}`, '-f', `id=${id}`, '-f', `cursor=${cursor}`], mapCheckPageResponse) });
        }
        const failure = responseFailure(output, body);
        return new Map([...query.targets.values()].map(ref => [changeRequestKey(ref), failure]));
    }
    /**
     * Run one continuation query of a snapshot read.
     * @param host - host the snapshot was read from.
     * @param variables - `gh api graphql` field flags, the query first.
     * @param signal - cancellation of the snapshot read.
     * @returns the output, or the failure of a `gh` that cannot start, times out, or prints over its limit.
     * @throws with `signal.reason` when the read is cancelled.
     */
    async continuation(host, variables, signal) {
        signal.throwIfAborted();
        try {
            return await this.gh(['api', 'graphql', '--hostname', host, ...variables], signal);
        }
        catch (error) {
            if (signal.aborted)
                throw signal.reason;
            return processFailure(error);
        }
    }
}
/**
 * Report a `gh` invocation that did not run to an exit code.
 * @param error - what the runner threw.
 * @returns `too-large` for output over its limit, `unavailable` for a `gh` that cannot start or times out.
 * @throws `error` when it is any other failure.
 */
function processFailure(error) {
    if (error instanceof GhOutputLimitError)
        return { code: 'too-large', message: error.message };
    if (error instanceof GhUnavailableError || error instanceof GhTimeoutError)
        return { code: 'unavailable', message: error.message };
    throw error;
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
