/** Registers a GitHub forge provider that reads pull requests over the HTTP API. */
import z from '@deepseek-ai/schemastery';
import { credentialRef } from '@deepseek-ai/dsh-credentials';
import { MAX_TIMER_DELAY_MS } from '@deepseek-ai/dsh-timeout';
import { githubRunner } from './github-runner.js';
import { GitHubProvider } from './provider.js';
export const name = 'pr-panel-github';
export const inject = ['forge'];
export const Config = z.object({
    token: z.string(),
    tokenEnv: z.string().default('GITHUB_TOKEN'),
    hosts: z.array(z.string()).default(['github.com']),
    timeoutMs: z.number().default(30_000),
    maxOutputBytes: z.number().default(8_388_608),
});
const HOST = /^[a-z0-9]([a-z0-9-]*[a-z0-9])?(\.[a-z0-9]([a-z0-9-]*[a-z0-9])?)*(:\d+)?$/i;
const ENVIRONMENT_NAME = /^[A-Za-z_][A-Za-z0-9_]*$/;
/**
 * Resolve the token for one request. A dsh credential with the configured name
 * wins over the process environment, so the Web credential store can hold it.
 * @param ctx - plugin context, which may provide the credentials service.
 * @param config - resolved plugin config.
 * @returns the current token, or undefined when neither source has one.
 */
async function resolveToken(ctx, config) {
    if (config.token !== undefined && config.token.length > 0)
        return config.token;
    const credentials = ctx.get('credentials');
    if (credentials !== undefined) {
        try {
            const resolved = await credentials.resolve(credentialRef(config.tokenEnv));
            if (resolved !== undefined && resolved.value.length > 0)
                return resolved.value;
        }
        catch {
            // A missing or malformed credential falls back to the process environment.
        }
    }
    const ambient = process.env[config.tokenEnv];
    return ambient !== undefined && ambient.length > 0 ? ambient : undefined;
}
export function apply(ctx, config) {
    const resolved = config;
    if (resolved.token !== undefined && resolved.token.trim().length === 0)
        throw new Error('dsh-pr-panel: token must not be empty');
    if (!ENVIRONMENT_NAME.test(resolved.tokenEnv))
        throw new Error(`dsh-pr-panel: invalid tokenEnv ${JSON.stringify(resolved.tokenEnv)}`);
    if (resolved.hosts.length === 0)
        throw new Error('dsh-pr-panel: hosts must list at least one host');
    for (const host of resolved.hosts) {
        if (!HOST.test(host))
            throw new Error(`dsh-pr-panel: invalid host ${JSON.stringify(host)}`);
    }
    if (!Number.isSafeInteger(resolved.timeoutMs) || resolved.timeoutMs <= 0 || resolved.timeoutMs > MAX_TIMER_DELAY_MS) {
        throw new Error('dsh-pr-panel: timeoutMs must be a positive integer no greater than the runtime timer limit');
    }
    if (!Number.isSafeInteger(resolved.maxOutputBytes) || resolved.maxOutputBytes <= 0) {
        throw new Error('dsh-pr-panel: maxOutputBytes must be a positive safe integer');
    }
    const runner = githubRunner({
        token: () => resolveToken(ctx, resolved),
        timeoutMs: resolved.timeoutMs,
        maxOutputBytes: resolved.maxOutputBytes,
    });
    ctx.forge.register(new GitHubProvider(runner, resolved.hosts, resolved.maxOutputBytes));
}
