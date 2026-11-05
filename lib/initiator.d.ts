/**
 * Runs the upstream forge panel's per-Session work under that Session's Agent.
 *
 * The panel service is written for a host-local checkout: its methods receive a
 * `Session` and call `ctx.fs` / `ctx.subprocess`, which in this deployment find
 * their sandbox through the ambient Agent initiator. UI requests and polling
 * have no initiator, so this thin wrapper supplies it for each panel call.
 * The panel itself stays upstream; only the execution boundary is added here.
 */
import { type Context } from '@deepseek-ai/cordis';
export declare const name = "pr-panel-initiator";
export declare const inject: string[];
export declare function apply(ctx: Context): void;
