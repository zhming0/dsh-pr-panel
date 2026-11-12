/** GitHub GraphQL documents and their mapping into provider-neutral results. */
import { changeRequestKey } from '@deepseek-ai/dsh-experimental-forge';
import { z } from 'zod';
import { checkedRepository, isCommit, isSegment } from './urls.js';
const CHECK_FIELDS = `pageInfo { hasNextPage endCursor }
  nodes {
    __typename
    ... on CheckRun {
      id databaseId name status conclusion detailsUrl startedAt completedAt
      checkSuite { app { id } workflowRun { databaseId event workflow { id name } } }
    }
    ... on StatusContext { context state targetUrl createdAt }
  }`;
/** Most nodes GitHub returns in one connection page. */
const PAGE_SIZE = 100;
const THREAD_FIELDS = 'pageInfo { hasNextPage endCursor } nodes { isResolved }';
/** Most review requests, reviews per kind, and closing issues one snapshot reads. */
const OVERVIEW_PAGE = 25;
const REVIEW_FIELDS = 'totalCount nodes { state commit { oid } author { __typename login avatarUrl } }';
/**
 * Pull request fields of one snapshot.
 * @param threads - review threads the first page holds, at most {@link PAGE_SIZE}.
 * @returns the selection of the snapshot fragment.
 */
function pullRequestFields(threads) {
    return `id number url title state isDraft updatedAt closedAt
  author { login }
  headRefName headRefOid baseRefName baseRefOid additions deletions mergeable mergeStateStatus reviewDecision viewerCanUpdateBranch
  canBeRebased
  reviewThreads(first: ${threads}) { ${THREAD_FIELDS} }
  reviewRequests(first: ${OVERVIEW_PAGE}) { totalCount nodes { asCodeOwner requestedReviewer {
    __typename ... on User { login avatarUrl } ... on Bot { login avatarUrl } ... on Team { combinedSlug avatarUrl }
  } } }
  latestReviews(first: ${OVERVIEW_PAGE}) { ${REVIEW_FIELDS} }
  latestOpinionatedReviews(first: ${OVERVIEW_PAGE}) { ${REVIEW_FIELDS} }
  closingIssuesReferences(first: ${OVERVIEW_PAGE}) { totalCount nodes { number title state url repository { name owner { login } } } }
  commits(last: 1) { nodes { commit { statusCheckRollup { id state contexts(first: ${PAGE_SIZE}) {
    ${CHECK_FIELDS}
  } } } } }`;
}
/** Continue reading the same commit's rollup even if the pull request head moves. */
export const CHECKS_QUERY = `query($id: ID!, $cursor: String!) {
  node(id: $id) { ... on StatusCheckRollup { contexts(first: ${PAGE_SIZE}, after: $cursor) { ${CHECK_FIELDS} } } }
}`;
/** Continue counting a pull request's review threads; variables `id`, `cursor`, and the integer `first`. */
export const THREADS_QUERY = `query($id: ID!, $cursor: String!, $first: Int!) {
  node(id: $id) { ... on PullRequest { reviewThreads(first: $first, after: $cursor) { ${THREAD_FIELDS} } } }
}`;
const REPOSITORY_FIELDS = 'squashMergeAllowed mergeCommitAllowed rebaseMergeAllowed viewerPermission viewerDefaultMergeMethod';
/** Head-branch lookup; variables `owner`, `name`, and `branch` are passed as strings. */
export const HEAD_QUERY = `query($owner: String!, $name: String!, $branch: String!) {
  repository(owner: $owner, name: $name) {
    nameWithOwner
    defaultBranchRef { name }
    pullRequests(headRefName: $branch, states: OPEN, first: 20, orderBy: { field: CREATED_AT, direction: DESC }) { nodes { number isCrossRepository } }
  }
}`;
/** Head and base commits of one pull request; variables `owner` and `name` are strings, `number` is an integer. */
export const PULL_REQUEST_COMMITS_QUERY = `query($owner: String!, $name: String!, $number: Int!) {
  repository(owner: $owner, name: $name) { pullRequest(number: $number) { headRefOid baseRefOid } }
}`;
const checkRunSchema = z.object({
    __typename: z.literal('CheckRun'),
    id: z.string(),
    databaseId: z.number().int().nonnegative().nullable(),
    name: z.string(),
    status: z.string(),
    conclusion: z.string().nullable(),
    detailsUrl: z.string().nullable(),
    startedAt: z.string().nullable(),
    completedAt: z.string().nullable(),
    checkSuite: z.object({
        app: z.object({ id: z.string() }).nullable(),
        workflowRun: z.object({
            databaseId: z.number().int().nonnegative().nullable(),
            event: z.string(),
            workflow: z.object({ id: z.string(), name: z.string() }),
        }).nullable(),
    }).nullable(),
});
const statusContextSchema = z.object({
    __typename: z.literal('StatusContext'),
    context: z.string(),
    createdAt: z.iso.datetime(),
    state: z.string(),
    targetUrl: z.string().nullable(),
});
const pageInfoSchema = z.object({ hasNextPage: z.boolean(), endCursor: z.string().nullable() });
const checkPageSchema = z.object({ pageInfo: pageInfoSchema, nodes: z.array(z.unknown()) });
const threadPageSchema = z.object({ pageInfo: pageInfoSchema, nodes: z.array(z.object({ isResolved: z.boolean() })) });
const actorSchema = z.object({ __typename: z.string(), login: z.string(), avatarUrl: z.string().nullable() });
const reviewsSchema = z.object({
    totalCount: z.number().int().nonnegative(),
    nodes: z.array(z.object({ state: z.string(), commit: z.object({ oid: z.string() }).nullable(), author: actorSchema.nullable() })),
});
const pullRequestSchema = z.object({
    id: z.string().transform(value => value),
    url: z.string(),
    title: z.string(),
    state: z.enum(['OPEN', 'CLOSED', 'MERGED']),
    isDraft: z.boolean(),
    updatedAt: z.string(),
    closedAt: z.string().nullable(),
    author: z.object({ login: z.string() }).nullable(),
    headRefName: z.string(),
    headRefOid: z.string(),
    baseRefName: z.string(),
    // Only the diff read's head start uses the base commit, so a missing or malformed one leaves the rest of the status intact.
    baseRefOid: z.unknown().transform(value => typeof value === 'string' && isCommit(value) ? value : undefined),
    additions: z.number().int().nonnegative(),
    deletions: z.number().int().nonnegative(),
    mergeable: z.string(),
    mergeStateStatus: z.string(),
    reviewDecision: z.string().nullable(),
    viewerCanUpdateBranch: z.boolean(),
    canBeRebased: z.boolean(),
    reviewThreads: threadPageSchema,
    reviewRequests: z.object({
        totalCount: z.number().int().nonnegative(),
        nodes: z.array(z.object({
            asCodeOwner: z.boolean(),
            requestedReviewer: z.object({
                __typename: z.string(),
                login: z.string().optional(),
                combinedSlug: z.string().optional(),
                avatarUrl: z.string().nullable().optional(),
            }).nullable(),
        })),
    }),
    latestReviews: reviewsSchema,
    latestOpinionatedReviews: reviewsSchema,
    closingIssuesReferences: z.object({
        totalCount: z.number().int().nonnegative(),
        nodes: z.array(z.object({
            number: z.number().int().positive(),
            title: z.string(),
            state: z.string(),
            url: z.string(),
            repository: z.object({ name: z.string(), owner: z.object({ login: z.string() }) }),
        })),
    }),
    commits: z.object({
        nodes: z.array(z.object({
            commit: z.object({
                statusCheckRollup: z.object({
                    id: z.string().transform(value => value),
                    state: z.string(),
                    contexts: checkPageSchema,
                }).nullable(),
            }),
        })),
    }),
});
const repositorySchema = z.object({
    squashMergeAllowed: z.boolean(),
    mergeCommitAllowed: z.boolean(),
    rebaseMergeAllowed: z.boolean(),
    viewerPermission: z.string().nullable(),
    viewerDefaultMergeMethod: z.string(),
});
const responseSchema = z.object({
    data: z.record(z.string(), z.record(z.string(), z.unknown()).nullable()).nullable().optional(),
    errors: z.array(z.object({
        type: z.string().optional(),
        path: z.array(z.union([z.string(), z.number()])).optional(),
        message: z.string(),
    })).optional(),
}).refine(hasGraphqlFields);
/**
 * Distinguish GraphQL response fields from HTTP error bodies.
 * @param body - parsed JSON returned by GitHub.
 * @returns whether the object carries GraphQL data or errors; field validation remains with the query mapper.
 */
export function hasGraphqlFields(body) {
    return typeof body === 'object' && body !== null && ('data' in body || 'errors' in body);
}
const headSchema = z.object({
    data: z.object({
        repository: z.object({
            nameWithOwner: z.string(),
            defaultBranchRef: z.object({ name: z.string() }).nullable(),
            pullRequests: z.object({ nodes: z.array(z.object({ number: z.number(), isCrossRepository: z.boolean() })) }),
        }).nullable(),
    }),
});
const pullRequestCommitsSchema = z.object({ data: z.object({ repository: z.object({ pullRequest: z.object({
                headRefOid: z.string().refine(isCommit),
                baseRefOid: z.string().refine(isCommit),
            }) }) }) });
/** GitHub merge states in which the merge button works: mergeable, with passing or non-required failing checks. */
const MERGEABLE_NOW = new Set(['CLEAN', 'HAS_HOOKS', 'UNSTABLE']);
/** Repository permissions that may merge and rerun workflow jobs. */
const MERGERS = new Set(['ADMIN', 'MAINTAIN', 'WRITE']);
/** Repository permissions that may request reviews. */
const TRIAGERS = new Set(['ADMIN', 'MAINTAIN', 'WRITE', 'TRIAGE']);
/** Outcome of a submitted review by GitHub state; a pending review is not submitted. */
const VERDICTS = {
    APPROVED: 'approved', CHANGES_REQUESTED: 'changes-requested', COMMENTED: 'commented', DISMISSED: 'dismissed',
};
/** Merge methods in menu order, with the repository setting that allows each and GitHub's name for it. */
const METHODS = [
    { method: 'squash', allowed: 'squashMergeAllowed', name: 'SQUASH' },
    { method: 'merge', allowed: 'mergeCommitAllowed', name: 'MERGE' },
    { method: 'rebase', allowed: 'rebaseMergeAllowed', name: 'REBASE' },
];
/**
 * Build one query that reads every change request in `refs`, grouping them by
 * repository. Owners, names, and numbers are validated before they are inlined.
 * @param refs - change requests on one host.
 * @param maxReviewThreads - positive integer bound on the review threads counted per change request.
 * @returns the document and its alias targets.
 * @throws when an owner, name, or number cannot be inlined safely.
 */
export function snapshotQuery(refs, maxReviewThreads) {
    const repositories = new Map();
    for (const ref of refs) {
        const { owner, name } = checkedRepository(ref);
        const id = `${owner}/${name}`.toLowerCase();
        let entry = repositories.get(id);
        if (entry === undefined) {
            entry = { repository: ref.repository, numbers: new Map() };
            repositories.set(id, entry);
        }
        if (!entry.numbers.has(ref.number))
            entry.numbers.set(ref.number, ref);
    }
    const targets = new Map();
    const fields = [];
    for (const [r, { repository, numbers }] of [...repositories.values()].entries()) {
        const pulls = [];
        for (const [p, [number, ref]] of [...numbers].entries()) {
            pulls.push(`p${p}: pullRequest(number: ${number}) { ...ChangeRequestFields }`);
            targets.set(`r${r}.p${p}`, ref);
        }
        const owner = JSON.stringify(repository.owner);
        fields.push(`r${r}: repository(owner: ${owner}, name: ${JSON.stringify(repository.name)}) { ${REPOSITORY_FIELDS} ${pulls.join(' ')} }`);
    }
    const document = `query { ${fields.join(' ')} }
fragment ChangeRequestFields on PullRequest { ${pullRequestFields(Math.min(PAGE_SIZE, maxReviewThreads))} }`;
    return { document, targets, maxReviewThreads };
}
/**
 * Map a snapshot response, including GitHub's partial-error form, into one
 * result per alias target. Path-scoped errors apply to their repository or
 * pull request; errors without a path apply to every unresolved target. A
 * repository without readable merge settings offers no merge. Review threads
 * are counted across pages up to `query.maxReviewThreads`. Polling returns
 * the first check page; an explicit detail read can complete its pagination.
 * A continuation page that fails or does not advance fails its target.
 * @param body - parsed JSON printed by `gh api graphql`.
 * @param query - the query that produced the response.
 * @param pages - continuation reads of review threads and, for a detail read, of checks on the same commit.
 * @returns a snapshot with its check and thread truncation flags, or a failure, for every target.
 */
export async function mapSnapshotResponse(body, query, pages) {
    const results = new Map();
    const parsed = responseSchema.safeParse(body);
    const repositories = new Set([...query.targets.keys()].map(alias => alias.split('.')[0]));
    for (const [alias, ref] of query.targets) {
        const key = changeRequestKey(ref);
        if (!parsed.success) {
            results.set(key, { code: 'unavailable', message: 'unexpected GitHub response' });
            continue;
        }
        const [repositoryAlias = '', pullAlias = ''] = alias.split('.');
        const errors = parsed.data.errors ?? [];
        const error = errors.find(entry => entry.path?.[0] === repositoryAlias && (entry.path.length === 1 || entry.path[1] === pullAlias))
            ?? errors.find(entry => entry.path === undefined || !repositories.has(String(entry.path[0])));
        const raw = parsed.data.data?.[repositoryAlias]?.[pullAlias];
        const node = pullRequestSchema.safeParse(raw);
        const settings = repositorySchema.safeParse(parsed.data.data?.[repositoryAlias]);
        if (node.success) {
            const { id, reviewThreads } = node.data;
            const rollup = node.data.commits.nodes[0]?.commit.statusCheckRollup;
            const { checks } = pages;
            const failure = await readPages(reviewThreads, query.maxReviewThreads, 'review thread', async (cursor, first) => await pages.threads(id, cursor, first))
                ?? (rollup === undefined || rollup === null || checks === undefined ? undefined
                    : await readPages(rollup.contexts, Number.POSITIVE_INFINITY, 'check', async (cursor) => await checks(rollup.id, cursor)));
            results.set(key, failure ?? toSnapshot(ref, node.data, settings.success ? settings.data : undefined));
        }
        else if (error !== undefined)
            results.set(key, { code: error.type === 'NOT_FOUND' ? 'not-found' : 'unavailable', message: error.message });
        else if (raw === null || raw === undefined)
            results.set(key, { code: 'not-found', message: 'pull request not found' });
        else
            results.set(key, { code: 'unavailable', message: 'unexpected pull request fields' });
    }
    return results;
}
/**
 * Append the following pages of a connection until it ends or holds `limit` nodes.
 * @param connection - first page, extended in place.
 * @param limit - most nodes to hold.
 * @param label - what the connection lists, for failure messages.
 * @param read - reads the page after `cursor`, holding at most `first` nodes.
 * @returns a failure that prevents publishing the partial connection, or undefined once it ended or is full.
 */
async function readPages(connection, limit, label, read) {
    const cursors = new Set();
    while (connection.pageInfo.hasNextPage && connection.nodes.length < limit) {
        const cursor = connection.pageInfo.endCursor;
        if (cursor === null || cursors.has(cursor))
            return { code: 'unavailable', message: `GitHub ${label} pagination did not advance` };
        cursors.add(cursor);
        const next = await read(cursor, Math.min(PAGE_SIZE, limit - connection.nodes.length));
        if (!next.ok)
            return next.failure;
        connection.nodes.push(...next.page.nodes);
        connection.pageInfo = next.page.pageInfo;
    }
    return undefined;
}
/**
 * Validate a continuation response before adding its checks to the snapshot.
 * @param body - parsed GraphQL response for a rollup node.
 * @returns the complete page or a failure; partial-error pages are not accepted.
 */
export function mapCheckPageResponse(body) {
    return mapPageResponse(body, z.object({ contexts: checkPageSchema }).transform(node => node.contexts), 'check');
}
/**
 * Validate a continuation response of {@link THREADS_QUERY} before counting its review threads.
 * @param body - parsed GraphQL response for a pull request node.
 * @returns the complete page or a failure; partial-error pages are not accepted.
 */
export function mapThreadPageResponse(body) {
    return mapPageResponse(body, z.object({ reviewThreads: threadPageSchema }).transform(node => node.reviewThreads), 'review thread');
}
/**
 * Validate one continuation response of a `node(id:)` query.
 * @param body - parsed GraphQL response.
 * @param page - schema that maps the node to its connection page.
 * @param label - what the connection lists, for failure messages.
 * @returns the page, or a failure for an error, a missing node, or unexpected fields.
 */
function mapPageResponse(body, page, label) {
    const parsed = z.object({
        data: z.object({ node: page.nullable() }).nullable().optional(),
        errors: z.array(z.object({ message: z.string() })).optional(),
    }).safeParse(body);
    if (parsed.success && !parsed.data.errors?.length && parsed.data.data?.node != null)
        return { ok: true, page: parsed.data.data.node };
    return { ok: false, failure: { code: 'unavailable',
            message: parsed.success ? parsed.data.errors?.[0]?.message ?? `GitHub ${label} page is unavailable` : `unexpected GitHub ${label} page` } };
}
/**
 * Map a read of {@link PULL_REQUEST_COMMITS_QUERY}.
 * @param body - parsed JSON printed by `gh api graphql`.
 * @returns both commits, or undefined when the response does not name them as full commit object names.
 */
export function mapPullRequestCommitsResponse(body) {
    const parsed = pullRequestCommitsSchema.safeParse(body);
    if (!parsed.success)
        return undefined;
    const { headRefOid, baseRefOid } = parsed.data.data.repository.pullRequest;
    return { head: headRefOid, base: baseRefOid };
}
/**
 * Map a head-branch lookup of {@link HEAD_QUERY}, which selects open pull requests, into change requests.
 * @param body - parsed JSON printed by `gh api graphql`.
 * @param repository - repository that was queried.
 * @param branch - head branch that was queried.
 * @returns open non-fork change requests for `branch`, or none when it is the default branch.
 * @throws when the response is malformed or the repository is not visible.
 */
export function mapHeadResponse(body, repository, branch) {
    const parsed = headSchema.safeParse(body);
    if (!parsed.success)
        throw new Error('forge-github: unexpected GitHub response to the head branch lookup');
    const found = parsed.data.data.repository;
    if (found === null)
        throw new Error(`forge-github: repository ${repository.owner}/${repository.name} is not visible`);
    if (found.defaultBranchRef?.name === branch)
        return [];
    // GitHub answers with the canonical name after a rename or transfer. The
    // Session remote may still use the old one, and binding by it would show
    // the same change request twice.
    const [owner, name, extra] = found.nameWithOwner.split('/');
    if (owner === undefined || name === undefined || extra !== undefined || !isSegment(owner) || !isSegment(name)) {
        throw new Error(`forge-github: unexpected repository name ${JSON.stringify(found.nameWithOwner)}`);
    }
    const canonical = { ...repository, owner, name };
    return found.pullRequests.nodes.filter(node => !node.isCrossRepository).map(node => ({ repository: canonical, number: node.number }));
}
function toSnapshot(ref, node, settings) {
    const rollup = node.commits.nodes[0]?.commit.statusCheckRollup ?? null;
    const latest = new Map();
    let unknownContext = false;
    const retain = (key, order, check) => {
        const previous = latest.get(key);
        if (previous === undefined || order > previous.order) {
            latest.set(key, { order, check });
        }
    };
    for (const context of rollup?.contexts.nodes ?? []) {
        const run = checkRunSchema.safeParse(context);
        if (run.success) {
            const suite = run.data.checkSuite;
            const workflow = suite?.workflowRun;
            // A queued run may have neither a database id nor timestamps. Retain such runs by node id rather than guessing their age.
            const key = run.data.databaseId === null ? JSON.stringify(['unranked-run', run.data.id])
                : JSON.stringify(['run', run.data.name, suite?.app?.id, workflow?.workflow.id, workflow?.event]);
            retain(key, run.data.databaseId ?? 0, {
                name: run.data.name,
                state: checkRunState(run.data.status, run.data.conclusion),
                url: run.data.detailsUrl,
                workflow: run.data.checkSuite?.workflowRun?.workflow.name ?? null,
                startedAt: run.data.startedAt,
                completedAt: run.data.completedAt,
                rerun: workflow?.databaseId == null ? null : actionsRun(workflow.databaseId),
            });
            continue;
        }
        const status = statusContextSchema.safeParse(context);
        if (status.success) {
            retain(JSON.stringify(['status', status.data.context]), Date.parse(status.data.createdAt), {
                name: status.data.context,
                state: statusContextState(status.data.state),
                url: status.data.targetUrl,
                workflow: null,
                startedAt: null,
                completedAt: null,
                rerun: null,
            });
        }
        else if (typeof context === 'object' && context !== null && '__typename' in context
            && (context.__typename === 'CheckRun' || context.__typename === 'StatusContext')) {
            return { code: 'unavailable', message: 'unexpected GitHub check fields' };
        }
        else {
            unknownContext = true;
        }
    }
    const checks = [...latest.values()].map(value => value.check);
    // An incomplete list cannot determine the overall outcome.
    const summary = rollup?.contexts.pageInfo.hasNextPage || unknownContext || checks.length === 0 ? checksRollup(rollup?.state)
        : checks.some(check => check.state === 'failure' || check.state === 'cancelled') ? 'failure'
            : checks.some(check => check.state === 'pending') ? 'pending' : 'success';
    const permission = settings?.viewerPermission ?? '';
    const open = node.state === 'OPEN';
    return {
        ref,
        url: node.url,
        title: node.title,
        state: changeRequestState(node.state),
        draft: node.isDraft,
        author: node.author?.login ?? null,
        headBranch: node.headRefName,
        headSha: node.headRefOid,
        baseBranch: node.baseRefName,
        ...node.baseRefOid === undefined ? {} : { baseSha: node.baseRefOid },
        additions: node.additions,
        deletions: node.deletions,
        mergeability: mergeability(node.mergeable),
        mergeReady: settings !== undefined && MERGERS.has(settings.viewerPermission ?? '') && node.state === 'OPEN' && !node.isDraft
            && MERGEABLE_NOW.has(node.mergeStateStatus),
        mergeMethods: settings === undefined ? [] : mergeMethods(settings),
        // GitHub's `viewerCanUpdateBranch` is false while the head is up to date as well as when the viewer may not update
        // it; `mergeStateStatus` cannot tell a head behind its base, as BLOCKED and the other states take precedence over
        // BEHIND. `canBeRebased` reports whether the pull request can be rebase merged, which follows the repository's rebase
        // merge setting, so rebase is offered only where a rebase merge is allowed.
        branchUpdates: !open || !node.viewerCanUpdateBranch || node.mergeable === 'CONFLICTING' ? []
            : node.canBeRebased ? ['merge', 'rebase'] : ['merge'],
        reviewDecision: reviewDecision(node.reviewDecision),
        reviewers: reviewersOf(node),
        reviewersTruncated: [node.reviewRequests, node.latestReviews, node.latestOpinionatedReviews]
            .some(connection => connection.totalCount > connection.nodes.length),
        canRequestReviews: open && TRIAGERS.has(permission),
        checks,
        checksRollup: summary,
        checksTruncated: rollup?.contexts.pageInfo.hasNextPage ?? false,
        canRerunChecks: MERGERS.has(permission),
        unresolvedThreads: node.reviewThreads.nodes.filter(thread => !thread.isResolved).length,
        threadsTruncated: node.reviewThreads.pageInfo.hasNextPage,
        closingIssues: node.closingIssuesReferences.nodes.map(issue => ({
            repository: {
                forge: ref.repository.forge, host: ref.repository.host, owner: issue.repository.owner.login, name: issue.repository.name,
            },
            number: issue.number,
            title: issue.title,
            state: issue.state === 'OPEN' ? 'open' : 'closed',
            url: issue.url,
        })),
        closingIssuesTruncated: node.closingIssuesReferences.totalCount > node.closingIssuesReferences.nodes.length,
        updatedAt: node.updatedAt,
        closedAt: node.closedAt,
    };
}
/**
 * The requested reviewers in host order, then the other accounts that submitted a review, each with their latest
 * outcome. An approval or change request outlasts later comments, as GitHub's reviewer list shows it; the author and
 * accounts GitHub does not name are left out.
 */
function reviewersOf(node) {
    const reviewers = new Map();
    const keyOf = (kind, login) => `${kind}:${login.toLowerCase()}`;
    for (const request of node.reviewRequests.nodes) {
        const reviewer = request.requestedReviewer;
        const kind = reviewer?.__typename === 'User' ? 'user' : reviewer?.__typename === 'Bot' ? 'bot' : reviewer?.__typename === 'Team' ? 'team' : undefined;
        const login = kind === 'team' ? reviewer?.combinedSlug : reviewer?.login;
        if (kind === undefined || login === undefined)
            continue;
        reviewers.set(keyOf(kind, login), {
            kind, login, avatarUrl: reviewer?.avatarUrl ?? null, requested: true, codeOwner: request.asCodeOwner,
            verdict: null, reviewedSha: null,
        });
    }
    const author = node.author?.login.toLowerCase();
    for (const review of [...node.latestReviews.nodes, ...node.latestOpinionatedReviews.nodes]) {
        const verdict = VERDICTS[review.state];
        const account = review.author;
        if (verdict === undefined || account === null || account.login.toLowerCase() === author)
            continue;
        const kind = account.__typename === 'Bot' ? 'bot' : 'user';
        const key = keyOf(kind, account.login);
        const known = reviewers.get(key);
        reviewers.set(key, {
            kind, login: account.login, avatarUrl: known?.avatarUrl ?? account.avatarUrl, requested: known?.requested ?? false,
            codeOwner: known?.codeOwner ?? false, verdict, reviewedSha: review.commit?.oid ?? null,
        });
    }
    return [...reviewers.values()];
}
/** The rerun identity of a GitHub Actions job: the database id of its workflow run, which reruns its failed jobs. */
function actionsRun(run) {
    return `actions:${run}`;
}
/**
 * Read the workflow run database id from a check's rerun identity.
 * @param id - identity a snapshot of this provider named.
 * @returns the workflow run id, or undefined for an identity this provider did not build.
 */
export function actionsRunOf(id) {
    const match = /^actions:(\d{1,15})$/.exec(id);
    return match === null ? undefined : Number(match[1]);
}
/** The methods the repository allows, the viewer's default first. */
function mergeMethods(settings) {
    const allowed = METHODS.filter(entry => settings[entry.allowed]);
    const usual = allowed.filter(entry => entry.name === settings.viewerDefaultMergeMethod);
    return [...usual, ...allowed.filter(entry => !usual.includes(entry))].map(entry => entry.method);
}
function changeRequestState(state) {
    switch (state) {
        case 'OPEN': return 'open';
        case 'CLOSED': return 'closed';
        case 'MERGED': return 'merged';
    }
}
/** GitHub enum values outside the documented set read as the most conservative state. */
function checkRunState(status, conclusion) {
    if (status !== 'COMPLETED')
        return 'pending';
    switch (conclusion) {
        case 'SUCCESS': return 'success';
        case 'ACTION_REQUIRED':
        case 'FAILURE':
        case 'TIMED_OUT':
        case 'STARTUP_FAILURE': return 'failure';
        case 'CANCELLED': return 'cancelled';
        case 'SKIPPED': return 'skipped';
        case 'NEUTRAL': return 'neutral';
        default: return 'pending';
    }
}
function statusContextState(state) {
    switch (state) {
        case 'SUCCESS': return 'success';
        case 'FAILURE':
        case 'ERROR': return 'failure';
        default: return 'pending';
    }
}
function checksRollup(state) {
    switch (state) {
        case undefined: return 'none';
        case 'SUCCESS': return 'success';
        case 'FAILURE':
        case 'ERROR': return 'failure';
        default: return 'pending';
    }
}
function mergeability(value) {
    switch (value) {
        case 'MERGEABLE': return 'mergeable';
        case 'CONFLICTING': return 'conflicting';
        default: return 'unknown';
    }
}
function reviewDecision(value) {
    switch (value) {
        case 'APPROVED': return 'approved';
        case 'CHANGES_REQUESTED': return 'changes-requested';
        case 'REVIEW_REQUIRED': return 'review-required';
        default: return 'none';
    }
}
