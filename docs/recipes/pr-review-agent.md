# Recipe — PR review agent

[`@skelm/pr-review-agent`](https://github.com/scottgl9/skelm/tree/main/packages/pr-review-agent)
is a project-agnostic workflow package that reviews a pull request: it fetches
the PR through a provider adapter (GitHub first), classifies the pass as a
first review or a follow-up, runs the native [`@skelm/agent`](/backends/skelm-agent)
backend over the diff to produce findings with file/line references, verifies
whether follow-up commits addressed prior findings, and — only when explicitly
permitted — posts a safe, gated review.

It is **read-only by default**. Posting requires both an opted-in project
profile and a write-capable credential reference.

## Install and run

```bash
skelm package install ./packages/pr-review-agent
skelm run @skelm/pr-review-agent \
  --input '{"provider":"github","owner":"octo","repo":"demo","number":42}'
```

The host skelm config must register a native `@skelm/agent` backend under the
id `agent`:

```ts
// skelm.config.ts
import { defineWorkflowConfig } from '@skelm/core'
import { createSkelmAgentBackend } from '@skelm/agent'

export default defineWorkflowConfig({
  backends: { agent: 'agent' },
  instances: [createSkelmAgentBackend({ id: 'agent', baseUrl: process.env.OPENAI_BASE_URL, model: 'gpt-4o-mini' })],
})
```

## The review flow

1. **Fetch** — the `fetch-pr` step builds a `GitHubReviewAdapter` from the
   `GITHUB_REVIEW_TOKEN` secret (a *reference*; the gateway resolves the value)
   and pulls PR metadata, changed files/diff, commits, prior reviews, and CI
   check status. Egress is scoped to `api.github.com`.
2. **Classify** — `classifyReview()` returns `first-review` until the PR carries
   a submitted review from a non-bot reviewer, then `follow-up`.
3. **Review** — an `agent()` step runs the diff through the native backend with
   no tools, no filesystem, and no exec; it returns a structured `summary`,
   `findings[]` (each with `path`, optional `line`, `severity`, `message`), and a
   `recommendedEvent`.
4. **Verify follow-up** — for a follow-up, `verifyFollowUp()` checks, per prior
   finding, whether a commit landed after the latest prior review touched the
   finding's file. This is guidance for the reviewer, not auto-resolution.
5. **Post (gated)** — the `post` step posts only when the profile's safe-write
   mode and a write credential both allow it (below).

## First-review vs follow-up

The distinction drives both the prompt and the post-processing. A first review
analyses the full diff cold. A follow-up additionally receives the prior
findings and reports, per finding, whether a post-review commit addressed it —
so the reviewer can focus on what changed since last time instead of
re-reviewing the whole PR.

## Provider / project profiles

A profile bundles the per-project review knobs. Resolve one with
`resolveProfile(config, id)`, which falls back to the config's `defaultProfile`
and then the built-in read-only `DEFAULT_PROFILE`.

| Field | Meaning |
|---|---|
| `reviewStyle` | Emphasis injected into the prompt |
| `testCommands` | Focused test argv the agent may run via executable-profile shell tools |
| `requiredChecks` | Checks that must conclude `success` before an APPROVE |
| `ignorePaths` | Paths excluded from the diff (lockfiles, generated code) |
| `safeWrite.mode` | `off` (default) · `comment` · `request-changes` · `approve` |
| `safeWrite.requireGreenChecks` | Downgrade APPROVE to COMMENT over red checks (default true) |

`testCommands` only *names* commands the reviewer may run; the executables must
still be granted by the workflow's [executable profiles](/reference/permissions).
Listing a command here grants nothing on its own.

## Permissions and safe-write gating

Posting a review is a privileged external write. Two independent default-deny
layers must both open:

1. **Profile ceiling.** `safeWrite.mode` defaults to `off` — a profile that says
   nothing about writing can never post. `clampEvent()` clamps the model's
   recommendation to the ceiling: `comment` allows only COMMENT, `request-changes`
   never approves, and `approve` still refuses to APPROVE over red required
   checks.
2. **Credential grant.** The adapter is read-only unless constructed with a
   write-capable credential reference (`GITHUB_REVIEW_WRITE_TOKEN`). A write
   without that credential **denies** — `GitHubReviewAdapter.postReview()` throws
   `PrReviewWriteDeniedError` rather than silently no-op.

When a write does happen it is a network egress the gateway
[enforces and audits](/reference/permissions); the package adds no second audit
writer. Credential values are held privately in the adapter and scrubbed from
any error via `redactSecret()`, so they never reach logs, audit, or error
messages.

## Testing without a network or LLM

`runReview({ adapter, model, ref, ... })` takes an injected `PrReviewAdapter`
and `ReviewModel`, so the whole flow runs deterministically against stubs. The
package's `self-test/self-test.ts` does exactly this — a stub PR with a stubbed
transport and model — asserting fetch-via-adapter, classification, file/line
findings, read-only-by-default, write gating, and follow-up verification.
