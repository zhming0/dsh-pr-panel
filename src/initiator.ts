/**
 * Runs the upstream forge panel's per-Session work under that Session's Agent.
 *
 * The panel service is written for a host-local checkout: its methods receive a
 * `Session` and call `ctx.fs` / `ctx.subprocess`, which in this deployment find
 * their sandbox through the ambient Agent initiator. UI requests and polling
 * have no initiator, so this thin wrapper supplies it for each panel call.
 * The panel itself stays upstream; only the execution boundary is added here.
 */

import { symbols, type Context } from '@deepseek-ai/cordis'
import type { Agent } from '@deepseek-ai/dsh-agent'
import type { ForgePanelController } from '@deepseek-ai/dsh-experimental-client-ui-forge'
import type { Session } from '@deepseek-ai/dsh-session'

/** Methods whose first argument is a Session and whose work touches the sandbox. */
const SESSION_METHODS = [
  'branches',
  'diffBases',
  'track',
  'dismiss',
  'refresh',
  'localDiff',
  'localCommits',
  'localText',
  'changeRequestChecks',
  'changeRequestCommits',
  'changeRequestDiff',
  'changeRequestText',
  'changeRequestViewed',
  'setFileViewed',
  'changeRequestReview',
  'changeRequestReviewWrite',
  'submitReview',
  'markReady',
  'merge',
  'rerunChecks',
  'requestReviews',
  'reviewerCandidates',
  'updateBranch',
  'worktreeCleanup',
  'requestWorktree',
  'cancelWorktree',
  'stopCreation',
  'retryWorktree',
  'restoreWorktree',
  'continueInProject',
] as const

type SessionMethod = (session: Session, ...args: never[]) => unknown
type Agents = Pick<Context['agents'], 'get' | 'withInitiator'>

/**
 * Run a panel call under the Session's Agent, or unchanged when the Agent is
 * not loaded (a listed but unopened Session).
 * @param panel - live panel service instance.
 * @param agents - agent registry.
 * @param name - method name.
 * @returns the wrapped method.
 */
function wrapMethod(panel: ForgePanelController, agents: Agents, name: string): SessionMethod {
  const original = Reflect.get(panel, name) as SessionMethod
  return function (session: Session, ...args: never[]): unknown {
    const agent = agents.get(session.id)
    if (agent === undefined) return original.call(panel, session, ...args)
    return agents.withInitiator(agent, () => original.call(panel, session, ...args))
  }
}

/**
 * Wrap `follow` so each pull from the async generator, including the first one
 * that constructs the panel and starts its inspection, runs under the Agent.
 * @param panel - live panel service instance.
 * @param agents - agent registry.
 * @returns the wrapped stream method.
 */
function wrapFollow(panel: ForgePanelController, agents: Agents): ForgePanelController['follow'] {
  const original = panel.follow.bind(panel)
  return async function* follow(session: Session, signal: AbortSignal) {
    const agent = agents.get(session.id)
    if (agent === undefined) {
      yield* original(session, signal)
      return
    }
    const iterator = original(session, signal)[Symbol.asyncIterator]()
    try {
      while (true) {
        const next = await agents.withInitiator(agent, () => iterator.next())
        if (next.done === true) return
        yield next.value
      }
    } finally {
      await agents.withInitiator(agent, () => iterator.return?.(undefined))?.catch(() => {})
    }
  }
}

export const name = 'pr-panel-initiator'
export const inject = ['forgePanel', 'agents']

export function apply(ctx: Context): void {
  ctx.inject(['forgePanel', 'agents'], (scope) => {
    const panel = (Reflect.get(scope.forgePanel, symbols.original) as ForgePanelController | undefined) ?? scope.forgePanel
    const agents = scope.agents as Agents
    const wrapped: string[] = []
    for (const method of SESSION_METHODS) {
      if (typeof Reflect.get(panel, method) !== 'function') continue
      Object.defineProperty(panel, method, {
        configurable: true,
        writable: true,
        value: wrapMethod(panel, agents, method),
      })
      wrapped.push(method)
    }
    Object.defineProperty(panel, 'follow', {
      configurable: true,
      writable: true,
      value: wrapFollow(panel, agents),
    })
    wrapped.push('follow')
    scope.effect(() => () => {
      for (const method of wrapped) Reflect.deleteProperty(panel, method)
    })
  })
}
