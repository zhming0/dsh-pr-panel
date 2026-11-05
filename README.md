# dsh-pr-panel

A pull request panel for DSH Web. It shows the GitHub pull requests bound to a
Session, with their status, checks, review threads, and diffs, and lets you
review and merge from the same panel.

This is a compatibility bundle, not a fork of the whole upstream feature. It
mounts the upstream `@deepseek-ai/dsh-experimental-client-ui-forge` panel and
Session bindings, and supplies two small pieces:

- a GitHub provider that uses the GitHub HTTP API and a token instead of the
  host `gh` CLI;
- an execution-boundary wrapper that runs the panel's per-Session Git work
  under that Session's Agent, so it reaches the sandbox in a remote deployment.

It deliberately does **not** mount the worktree feature. No worktree rows are
active, so the panel hides the worktree controls and nothing creates an extra
checkout.

## Requirements

- DSH `0.2.2-rc.1` (the version this package was built against)
- The Web profile
- A GitHub token with repository read access, and `repo` scope for review and
  merge actions

## Install

Install straight from this Git repository:

```sh
dsh plugin --profile web add github:zhming0/dsh-pr-panel
```

The command installs the package and appends its bundle to the profile. The
Web Plugins page also accepts the same Git spec when it installs an external
bundle. The built `lib/` directory is committed, so a Git install does not need
to run a build script.

Then set the token in the control-plane environment:

```sh
export GITHUB_TOKEN=...
```

The provider resolves the token on every request. It first asks DSH's
`credentials` service for the name in `tokenEnv`, then falls back to the process
environment. For the dsh-yawn control plane, the sandbox credential broker is
not read yet; export the token in the control-plane process (or add it to the
DSH credential store) until that bridge exists.

To use a GitHub Enterprise host, add the host to the row config:

```yaml
- id: forge-github
  name: '@zhming0/dsh-pr-panel/github'
  config:
    hosts: [github.com, ghe.example.com]
```

## What you get

- A PR tab in the right sidebar, a header button, and Session-row status icons.
- PR cards with state, checks, review decision, unresolved threads,
  mergeability, and changed lines.
- A diff view with a file tree, search, folded context, one- and two-column
  layouts, line selection, review comments, pending reviews, and
  approve/request-changes.
- Ready for review, merge with the repository's allowed methods, open in
  browser, copy link, and remove/undo.
- Automatic binding from `gh pr create`, `gh pr view/edit/checkout`, and
  `git push` output in the Session, plus explicit tracking from the panel.
- Local changes from the upstream panel (Branch/Committed/Unstaged/Staged).
  Those reads use the Session's sandbox through the wrapper.

The worktree option, worktree creation card, and worktree restoration are not
available in this bundle.

## Configuration

`forge-github`:

| Field | Default | Meaning |
| --- | --- | --- |
| `token` | unset | Token value. Prefer `tokenEnv`. |
| `tokenEnv` | `GITHUB_TOKEN` | Credential or environment name resolved per request. |
| `hosts` | `[github.com]` | GitHub hosts this provider serves. |
| `timeoutMs` | `30000` | Deadline for one HTTP request. |
| `maxOutputBytes` | `8388608` | Maximum response body and complete-check payload. |

## How it works

The upstream panel receives a `Session` and calls `ctx.fs` / `ctx.subprocess`
for Git inspection and local diffs. In a remote-sandbox deployment those
services find their sandbox through the ambient Agent initiator, which a UI
request or background poll does not have. `pr-panel-initiator` wraps the panel
methods with `agents.withInitiator(agent, ...)`, so the existing upstream code
runs against the right sandbox. The bundle itself stays upstream and can be
updated independently.

The GitHub provider implements the small `gh` command surface the upstream
provider expects (`auth status`, `api`, `pr diff`, `pr ready`) on top of
`fetch`. That kept the upstream GraphQL queries, status mapping, and review
writer unchanged. See `src/github-runner.ts`.

## Development

```sh
pnpm install
pnpm check
pnpm test
pnpm build
```

The `lib/` directory is committed because DSH installs bundles from Git without
a build step. Rebuild and commit it when changing `src/`.

## Limitations

- GitHub only. GitHub Enterprise hosts must be listed in `hosts`; GitLab and
  other code hosts are not supported.
- The panel still includes the upstream local-changes card. It inspects the
  Session's checkout through the wrapper, which can wake a hibernated sandbox.
- The worktree feature is intentionally absent.
- PR creation is not a direct API call: the panel's "Create change request"
  action sends the Agent a message, and the Agent runs `gh` in the sandbox.
- Review and merge need a token with the corresponding repository permissions.
- The provider does not read the dsh-yawn credential broker yet; use the DSH
  credential store or the process environment.

## License

MIT. The GitHub provider, GraphQL mapping, URL parsing, and review writer are
derived from `deepseek-ai/deepseek-harness`
(`packages/experimental/forge-github`, MIT). See [NOTICE](NOTICE).
