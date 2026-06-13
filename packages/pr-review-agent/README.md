# @skelm/pr-review-agent

A project-agnostic **PR review workflow package** for skelm. Given a pull
request reference (provider + repo + number) it:

1. Fetches PR metadata, the diff/changed files, prior reviews, commits, and CI
   status through a provider adapter (GitHub first), authenticating by a
   **credential reference** resolved by the gateway.
2. Classifies the pass as **first-review** or **follow-up** from prior
   submitted reviews.
3. Runs the native [`@skelm/agent`](../agent) backend over the diff to produce
   **findings with file/line references** plus a recommended review event.
4. **Verifies follow-up** commits against prior findings — for each prior
   finding, did a post-review commit touch its file?
5. Optionally posts a review — **only** when the project profile's safe-write
   mode and a write credential both allow it.

It is **read-only by default**. Posting a review/comment requires an explicit
write permission *and* a write-capable GitHub credential reference. Every
external write is a network egress the gateway enforces and audits; this
package adds no second audit writer.

## Install & run

```bash
skelm package install ./packages/pr-review-agent
skelm run @skelm/pr-review-agent \
  --input '{"provider":"github","owner":"octo","repo":"demo","number":42}'
```

The host skelm config must register a native `@skelm/agent` backend under the
id `agent` (`backends: { agent: 'agent' }`).

### Input

| Field | Required | Meaning |
|---|---|---|
| `provider` | no | `'github'` (default and only provider today) |
| `owner` / `repo` / `number` | yes | PR coordinates |
| `profileId` | no | Profile id to apply; falls back to the config default |
| `priorFindings` | no | Findings carried from a prior run, for follow-up verification |

## Provider / project profiles

A **profile** bundles the per-project review knobs:

| Field | Meaning |
|---|---|
| `reviewStyle` | Free-form emphasis injected into the review prompt |
| `testCommands` | Focused test argv the agent may run via executable-profile shell tools (still gated by the workflow's executable permissions) |
| `requiredChecks` | Check names that must conclude `success` before an APPROVE |
| `ignorePaths` | Paths excluded from the diff sent to the model (lockfiles, generated code) |
| `safeWrite.mode` | `off` (default), `comment`, `request-changes`, or `approve` |
| `safeWrite.requireGreenChecks` | Downgrade APPROVE to COMMENT over red required checks (default true) |

`resolveProfile(config, id)` resolves by id, falling back to the config's
`defaultProfile`, then to the built-in read-only `DEFAULT_PROFILE`.

## Permissions & safe-write gating

Default-deny applies at two layers, both of which must open before a write:

1. **Profile ceiling** — `safeWrite.mode` defaults to `off`. A profile that
   says nothing about writing can never post; an APPROVE is clamped to COMMENT
   unless the mode is `approve` and the required checks are green.
2. **Credential grant** — the adapter is read-only unless constructed with a
   write-capable credential reference (`GITHUB_REVIEW_WRITE_TOKEN`). A write
   without a credential denies, it does not silently no-op.

`clampEvent()` enforces the ceiling; `GitHubReviewAdapter.postReview()` throws
`PrReviewWriteDeniedError` when read-only. Credential values are held privately
in the adapter and scrubbed from any error via `redactSecret()` — they never
reach logs, audit, or error messages.

## Library API

`runReview({ adapter, model, ref, profileConfig?, profileId?, priorFindings?, onAudit? })`
runs the whole flow over an injected `PrReviewAdapter` and `ReviewModel`, which
makes it fully testable with stubs (no network, no LLM). See the package tests
and `self-test/self-test.ts` for the stubbed loop.

## Self-test

`self-test/self-test.ts` runs the review loop against a stub PR with a stubbed
transport and model, asserting: data fetched via the adapter, first-vs-follow-up
classification, findings carry file/line, read-only by default, write gated by
profile + credential, and follow-up verification against post-review commits.
