# @skelm/package-publisher

A first-party **workflow package** that pre-flights another skelm workflow
package before it ships. Given a target package directory it:

1. **Validates** the target's `skelm.package.json` with the core
   `parsePackageManifest` / `validatePackageManifest`, surfacing the typed
   `PackageManifestError` message.
2. **Summarizes permissions** — a references-only view of what each workflow
   entry and the manifest declare (permission dimensions, executable profiles,
   secret *names*, integrations, triggers). It never resolves or prints a
   secret value.
3. **Secret-scans** the package contents and **fails** if a likely credential
   is found — the whole point is to stop secrets from being published. Matches
   are reported as `file` + redacted sample + a non-reversible fingerprint;
   the raw value is never returned or logged.
4. **Validates the declared self-test** entry (when the target's manifest
   declares one) without executing package code.
5. **Computes integrity** and assembles a publish **dry-run** (file list,
   sizes, version, `sha256` integrity). An actual `npm publish` is **out of
   scope** and is never performed by this package.

## Use as a workflow package

The default workflow (`workflows/publish.workflow.ts`) takes
`{ packageDir, runSelfTest? }` as input and throws when any stage fails, so a
gateway run is marked failed on an invalid manifest, a found secret, or a
self-test failure.

```ts
import { runPublish } from '@skelm/package-publisher'

const report = await runPublish('/abs/path/to/target-package')
if (!report.ok) {
  // report.manifestError | report.secretFindings (redacted) | report.selfTest
}
```

## Publish report shape

`runPublish(dir, opts?)` returns a `PublishReport`:

- `ok` — true only when no stage failed and no secret was found.
- `stages` — per-stage status (`passed` / `failed` / `skipped`) for
  `validateManifest`, `permissionSummary`, `secretScan`, `selfTest`, `dryRun`.
- `manifestError` — typed validation message when the manifest is invalid.
- `permissions` — the `PermissionSummary` (references only).
- `secretFindings` — redacted `SecretFinding[]`; a non-empty list fails the run.
- `selfTest` — `{ status, entry?, detail? }`.
- `dryRun` — `{ name, version, integrity, files, totalBytes, published: false }`.

## Secret-scan heuristics

The scanner (`scanText`, exported) combines anchored token patterns with a
Shannon-entropy fallback. Pattern rules: `aws-access-key-id`,
`aws-secret-access-key`, `github-token`, `github-fine-grained-token`,
`slack-token`, `google-api-key`, `stripe-secret-key`, `openai-key`,
`anthropic-key`, `bearer-token`, `private-key` (PEM header), and
`url-basic-auth` (inline `user:pass@host` URLs). The entropy rule
(`high-entropy-string`) flags long mixed-class runs above a Shannon-entropy
threshold while skipping obvious placeholders (`${…}`, `<token>`, `xxxx`,
repeated characters) and lockfile/import/URL lines that are public by design.
The full rule list is exported as `SECRET_SCAN_RULES`.

**Redaction.** `redactSecret` keeps at most the first three and last two
characters and masks the middle; values of eight characters or fewer are fully
masked. Each finding also carries `sha256:<first 12 hex>` as a stable,
non-reversible fingerprint. A finding never contains the secret's interior
bytes.

## Scope

This package performs **no** privileged action: no network, no `npm publish`,
no execution of the target's privileged steps. The self-test stage confirms
that the declared self-test entry stays within the package root, is readable,
and declares a default export, but it does not import or execute the target
module. Real publishing remains an operator-gated step performed elsewhere.
