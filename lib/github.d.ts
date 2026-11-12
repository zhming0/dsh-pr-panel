/** Registers a GitHub forge provider that reads pull requests over the HTTP API. */
import type { Context } from '@deepseek-ai/cordis';
import z from '@deepseek-ai/schemastery';
export declare const name = "pr-panel-github";
export declare const inject: string[];
/** Token source, served hosts, and request limits. */
export interface Config {
    /** Token value, taking precedence over `tokenEnv`; prefer a credential reference. */
    token?: string;
    /** Environment or dsh credential name that holds the token. */
    tokenEnv?: string;
    /** Host names this provider serves; list GitHub Enterprise hosts explicitly. */
    hosts?: string[];
    /** Deadline in milliseconds for one request. */
    timeoutMs?: number;
    /** Maximum captured bytes for one response body and combined JSON bytes of one complete check, commit, or review read. */
    maxOutputBytes?: number;
    /** Most review threads counted in one status read and read in one review read. */
    maxReviewThreads?: number;
    /** Most commits one commit listing returns. */
    maxCommits?: number;
    /** Most files whose viewed marks one read lists. */
    maxViewedFiles?: number;
}
export declare const Config: z<Config>;
export declare function apply(ctx: Context, config: Config): void;
