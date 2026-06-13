# Workflow packages

A **workflow package** is a directory of workflows distributed as a unit, described by a `skelm.package.json` manifest at its root. The package substrate in `@skelm/core` provides the manifest format, an explicit install cache, and a project lockfile. CLI and gateway surfaces (install commands, activation, running `skelm run @scope/name`) build on top of it.

## Trust posture

- **Manifest before code.** `skelm.package.json` is parsed and validated before any package file is copied or any package code is loaded. An invalid manifest fails with a typed `PackageManifestError` and nothing reaches the cache.
- **Install is always explicit.** Packages are never auto-loaded from `node_modules`; they enter a project only through an install into the package store.
- **Entry paths cannot escape the package.** Every `entry` is a package-relative, forward-slash path; absolute paths and `..` segments are rejected at validation time, and install rejects symlinked entrypoints or any symlink anywhere under the package.
- **Triggers are offered, never armed.** Triggers declared in a manifest are always disabled by default; an operator must enable each one explicitly.
- **Secrets are references only.** A manifest declares the secret *names* a package needs. Values are resolved by the gateway's secret resolver at run time and never appear in manifests, the lockfile, or the store.
- **Permissions stay default-deny.** Per-workflow `permissions` declare a ceiling; omission means deny, exactly as for hand-authored workflows.
- **Trust is gated before activation.** A package's *trust level* is derived from its install source and checked against the operator's *trust policy* before it activates. An update that broadens the requested permission/secret/trigger surface is flagged and held for approval — a package can never silently widen its reach across an update.

## Manifest: `skelm.package.json`

```json
{
  "name": "@skelm/hello",
  "version": "0.1.0",
  "description": "Greets someone by name.",
  "license": "MIT",
  "skelm": {
    "apiVersion": 1,
    "requiredSkelmVersion": ">=0.4.0",
    "workflows": [
      {
        "id": "default",
        "entry": "workflows/hello.workflow.ts",
        "kind": "pipeline",
        "description": "Greets someone by name."
      }
    ],
    "secrets": [{ "name": "HELLO_TOKEN", "description": "API token (name only)." }],
    "triggers": [{ "id": "daily", "kind": "cron", "description": "Disabled until enabled by an operator." }]
  }
}
```

### Top-level fields

| Field | Required | Meaning |
|---|---|---|
| `name` | yes | npm-style package name (`@scope/name` or `name`); validated against npm naming rules |
| `version` | yes | exact semver version |
| `description`, `license`, `homepage` | no | strings, informational |
| `repository` | no | string or object, npm-style |
| `skelm` | yes | the skelm section below |

Extra top-level npm fields (`keywords`, `private`, …) are tolerated and ignored.

### The `skelm` section

| Field | Required | Meaning |
|---|---|---|
| `apiVersion` | yes | must be the literal `1`; other values are rejected |
| `requiredSkelmVersion` | no | semver range the host skelm must satisfy |
| `workflows` | yes | workflow entrypoints (below) |
| `config` | no | JSON-schema-ish object describing package config; opaque to the substrate |
| `secrets` | no | `{ name, description? }[]` — secret names the package needs, never values |
| `integrations` | no | integration ids the package uses |
| `stateNamespaces` | no | durable-state namespaces the package writes |
| `artifacts` | no | artifact types the package emits |
| `triggers` | no | `{ id, kind, description? }[]` — offered triggers, **always disabled by default** |
| `selfTest` | no | `{ entry }` — package self-test module, same path rules as workflow entries |
| `dashboard` | no | opaque dashboard metadata object |

### Workflow entries

Each element of `skelm.workflows`:

| Field | Required | Meaning |
|---|---|---|
| `id` | yes | unique within the manifest; the id `default` is what `skelm run @scope/name` runs |
| `entry` | yes | package-relative path to the workflow module; forward slashes only, no absolute paths, no `..` |
| `kind` | no | `'pipeline'` (default) or `'persistent'` |
| `description` | no | human-readable summary |
| `permissions` | no | `AgentPermissions` ceiling for the workflow; omitted dimensions are denied |

Parse and validate manifests with `parsePackageManifest(raw, source?)` (raw JSON text) or `validatePackageManifest(value, source?)` (already-parsed value). Both throw `PackageManifestError` with the offending field in the message.

## Package store

`WorkflowPackageStore` caches installed packages under the project:

```
<projectRoot>/.skelm/packages/<encoded-name>/<version>/
```

Scoped names are encoded into one path segment by replacing `/` with `__` (`@skelm/hello` → `@skelm__hello`). The store is a core library; it performs no network access. `installFromDirectory(sourceDir)` validates the manifest, rejects symlinks anywhere under the package, and checks every declared workflow or self-test entry exists as a regular file *before* copying. It stages the copy next to the final path and renames it into place so a crash never leaves a partial install. `list()`, `get(name, version)`, and `remove(name, version?)` manage the cache; cached manifests are re-validated on every load.

`computePackageIntegrity(dir)` returns a deterministic `sha256:<hex>` over the package's sorted relative paths and file bytes, and rejects package trees that contain symlinks. `store.verify(name, version, expectedIntegrity)` recomputes it and throws `PackageIntegrityError` on any mismatch or symlinked contents — the tamper check used against the lockfile record.

## Lockfile: `skelm.lock.json`

A project-root, source-controlled record of installed packages:

```json
{
  "lockfileVersion": 1,
  "packages": {
    "@skelm/hello": {
      "name": "@skelm/hello",
      "version": "0.1.0",
      "resolved": "/path/to/source",
      "integrity": "sha256:…",
      "installedAt": "2026-06-12T00:00:00.000Z",
      "requiredSkelmVersion": ">=0.4.0",
      "trustLevel": "local"
    }
  }
}
```

`resolved` is the local source directory today; tarball URLs arrive with remote installs. `trustLevel` records the trust level derived at install time (below). `readLockfile`, `writeLockfile`, `updateLockfileEntry`, and `removeLockfileEntry` operate on it. Writes are atomic (temp file + rename) and serialization is deterministic — sorted package keys, fixed field order — so lockfile diffs stay reviewable. A missing lockfile reads as empty; a malformed one throws `ConfigError`.

## Package trust policy

A package carries a **trust level** derived from where it was installed from, and the operator declares a **trust policy** that decides which levels may activate without explicit approval. Both live in `@skelm/core/packages`; the gateway enforces them on install and records the level in the lockfile.

### Trust levels

`derivePackageTrustLevel(source, opts?)` returns one of:

| Level | Derived from |
|---|---|
| `local` | a local directory on the operator's machine |
| `workspace` | a local `.tgz`/`.tar.gz` tarball built from this workspace |
| `npm` | a tarball or spec resolved from the public npm registry |
| `verified` | a registry source carrying a verified-publisher signal |
| `private` | a private/internal registry source |

A local directory is `local`; a local tarball is `workspace`. Registry origins are named explicitly by the caller (only the gateway knows the egress origin) via `opts.registryOrigin`, which always wins over the source shape. Remote installs are still deferred pending a network-egress policy decision, so today the gateway derives `local` and `workspace` only.

### Trust policy

`PackageTrustPolicy` is operator config (`defaults.packageTrust` in `skelm.gateway.ts`):

```ts
defaults: {
  packageTrust: {
    allow: ['local', 'workspace'],          // activate without approval
    requireApproval: ['npm', 'private'],     // install only with explicit approval
  },
}
```

The posture is **default-deny**: a level in neither list is refused. When `defaults.packageTrust` is omitted the gateway applies `DEFAULT_PACKAGE_TRUST_POLICY` — `local`/`workspace` allowed, `npm`/`verified`/`private` require approval. `evaluatePackageTrust(level, policy)` returns `'allow'`, `'requires-approval'`, or `'denied'`.

On `POST /v1/packages/install` the gateway:

- refuses a **denied** level with `403` and a `package.install.refused` audit event, before any file reaches the store;
- holds a **requires-approval** level with `409` and a `package.install.pending` audit event unless the request carries `{ "approve": true }`;
- proceeds for an **allowed** (or approved) level, records the `trustLevel` in the lockfile, and emits the usual `package.install` audit event (now including the trust level).

### Permission-expansion on update

When an install targets a package that is already recorded in the lockfile, the gateway diffs the **requested** surface of the new manifest against the installed one with `summarizePackagePermissions` + `diffPackagePermissions`. Any widening — broader `allowedTools`, new `allowedExecutables`/`executableProfiles`, new `allowedMcpServers`/`allowedSkills`, new `allowedSecrets`, broader `fsRead`/`fsWrite`, newly-blanket or newly-host network egress, or a newly-offered trigger — sets `expanded: true`. A flagged update is held with `409` and a `package.update.flagged` audit event unless the request carries `{ "approve": true }`. A same-or-narrower update is not flagged. This mirrors the framework rule that permissions are never widened silently.

`GET /v1/packages/:name` surfaces the package's `trustLevel` and a `permissions` summary so install/update is reviewable before activation.

## Gateway API

Package management is a privileged control-plane surface owned by the gateway. Every mutation is bearer-authenticated like the rest of `/v1`, validates the manifest before touching the store, and writes a single audit event through the gateway's audit writer. The CLI is a thin client over these routes; the store and lockfile are never touched in-process by the CLI.

| Route | Purpose |
|---|---|
| `GET /v1/packages` | List installed packages merged with their lockfile entries. |
| `GET /v1/packages/:name` | Manifest, installed versions, content integrity, derived `trustLevel`, a `permissions` summary, and lockfile entry. `:name` may be a URL-encoded scoped name (`@scope%2Fname`). |
| `POST /v1/packages/install` | Body `{ "source": "<local dir or .tgz path>", "approve"?: true }`. Validates the manifest, applies the trust policy (refusing a denied level with `403`, holding a require-approval level with `409` unless approved), flags an update that expands the requested permission surface with `409` unless approved, installs into the store, records the lockfile entry (name, version, resolved source, `sha256` integrity, `trustLevel`), and emits a `package.install` (or `package.install.refused` / `package.install.pending` / `package.update.flagged`) audit event. |
| `POST /v1/packages/resolve` | Body `{ "spec": "@scope/name[@version][/entry]" }`. Resolves a run spec to the installed workflow's absolute entry file only after verifying the cached package against the lockfile integrity record; the entry id defaults to `default`. Used by `skelm run @scope/name` and unscoped `skelm run name/entry`. |
| `DELETE /v1/packages/:name` | Optional `?version=`. Removes from the store and (when no version remains) from the lockfile; emits a `package.remove` audit event. |

**Install sources.** Only a **local directory** or a **local `.tgz` tarball** are accepted this release. A tarball is gunzipped and read with a minimal ustar reader; any entry with an absolute path or a `..` traversal segment is rejected (400) before a single byte is written, and a leading `package/` prefix (npm-pack layout) is stripped. **npm-registry / URL installs are planned** but deferred pending a network-egress policy decision.

## CLI

`skelm package` is a thin client over the gateway API above — it requires a running gateway and never installs in-process.

| Command | Behaviour |
|---|---|
| `skelm package install <source>` | `POST /v1/packages/install` with a local directory or `.tgz` path. |
| `skelm package list [--json]` | `GET /v1/packages`. |
| `skelm package info <name> [--json]` | `GET /v1/packages/:name`. |
| `skelm package remove <name> [--version <v>]` | `DELETE /v1/packages/:name`. |
| `skelm package update <name>` | Reinstall from the lockfile's recorded source (reads it via `info`, then re-runs install). |
| `skelm run @scope/name[@version][/entry]` | The run command detects a package spec (leading `@`, or a `name@version` / `name/entry` form that is not a real path), resolves it via `POST /v1/packages/resolve`, verifies the cached package against `skelm.lock.json`, then runs the resolved entry file exactly like `skelm run <file>`. |

Exit codes match the documented CLI conventions: `0` on success, `1` on a CLI/gateway error (unknown package, missing entry, gateway unreachable), and the usual run exit codes for `skelm run`.

**Materialization source.** An installed package directory under `.skelm/packages/<name>/<version>/` is already a self-contained, integrity-verified, gateway-owned managed copy. A package-spec run therefore materializes the executed tree from that package directory as its source root — not from the surrounding project tree (whose materializer excludes `.skelm`, which would otherwise drop the resolved entry). The executed copy stays gateway-owned and path-validated; the project's `skelm.config.*` still supplies `defaults.permissions` and backend defaults for the run.
