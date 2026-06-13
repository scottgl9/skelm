# Package Publisher

`@skelm/package-publisher` is a first-party [workflow package](./workflow-packages.md)
that pre-flights another workflow package before it is published. It validates,
secret-scans, validates self-test entries, and assembles a publish **dry-run** — it never runs a
real `npm publish`.

## Why it exists

Workflow packages are distributed as units and loaded by the gateway. Before a
package leaves a machine, you want a fast, deterministic check that the manifest
is valid, that no credential is about to be shipped, and that the package's own
self-test entry is structurally valid without executing untrusted code. This
package is that check, runnable from the CLI/gateway
like any other workflow or embedded directly through its exported functions.

## Publish pipeline stages

The default workflow (`workflows/publish.workflow.ts`) takes
`{ packageDir, runSelfTest? }` and runs five stages in order:

| Stage | What it does | Fails the run when |
|---|---|---|
| `validateManifest` | Parses `skelm.package.json` with the core `parsePackageManifest` | the manifest is missing or invalid (typed `PackageManifestError`) |
| `permissionSummary` | Builds a references-only capability summary | — |
| `secretScan` | Scans every text file for likely secrets | any likely secret is found |
| `selfTest` | Verifies the declared self-test entry stays in-root, is readable, and declares a default export | the entry escapes the root, is unreadable, empty, or lacks a default export |
| `dryRun` | Computes integrity and assembles the would-publish file list | — |

A failed manifest validation short-circuits the remaining stages. The default
workflow throws on `ok === false`, so a gateway run is marked failed.

## Permission summary

The summary is **references only** — it reports the *shapes and names* declared
in the manifest and never resolves or prints a secret value:

- per workflow entry: `hasPermissions`, `executableProfiles`,
  `allowedExecutables`, `declaresNetworkEgress`, `fsRead`, `fsWrite`,
  `allowedSecrets` (names), `requestsUnrestricted`;
- package level: declared `secrets` (names), `integrations`, `triggers`
  (`{ id, kind }`), `stateNamespaces`.

## Secret-scan heuristics

The scanner combines anchored token patterns with a Shannon-entropy fallback.

**Pattern rules:** `aws-access-key-id`, `aws-secret-access-key`,
`github-token`, `github-fine-grained-token`, `slack-token`, `google-api-key`,
`stripe-secret-key`, `openai-key`, `anthropic-key`, `bearer-token`,
`private-key` (PEM `-----BEGIN … PRIVATE KEY-----` header), and `url-basic-auth`
(inline `scheme://user:pass@host` credentials).

**Entropy rule (`high-entropy-string`):** long mixed-class runs above a Shannon
entropy threshold. Obvious placeholders (`${…}`, `{{…}}`, `<token>`, `xxxx`,
`example`, single repeated characters) and lines that are public by design
(`sha256-…`/`integrity` hashes, `import`/`require`, URLs) are skipped to keep
false positives low.

The exported `SECRET_SCAN_RULES` lists every rule id the scanner can emit.

### Redaction

A finding never contains the secret's interior bytes. `redactSecret` keeps at
most the first three and last two characters and masks the middle; values of
eight characters or fewer are fully masked. Each finding also carries a
`sha256:<first 12 hex>` fingerprint — a stable, non-reversible id for the match.
Every finding is `{ file, line, rule, redacted, fingerprint }`.

## Dry-run output

`buildDryRun` (and the `dryRun` field of the report) returns:

```jsonc
{
  "name": "@scope/name",
  "version": "1.2.3",
  "integrity": "sha256:…",   // computePackageIntegrity over the dir
  "files": [{ "path": "skelm.package.json", "bytes": 412 }, …],
  "totalBytes": 1234,
  "published": false          // always false — publishing is out of scope
}
```

## Scope

This package performs no privileged action: no network, no `npm publish`, no
execution of the target package's privileged steps. Actual publishing remains
an operator-gated step performed elsewhere; the `allowPublish` option records
intent only and does not publish.

## Embedding

```ts
import { runPublish } from '@skelm/package-publisher'

const report = await runPublish('/abs/path/to/target-package')
if (!report.ok) {
  // report.manifestError | report.secretFindings (redacted) | report.selfTest
}
```
