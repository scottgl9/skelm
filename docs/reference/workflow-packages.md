# Workflow packages

A **workflow package** is a directory of workflows distributed as a unit, described by a `skelm.package.json` manifest at its root. The package substrate in `@skelm/core` provides the manifest format, an explicit install cache, and a project lockfile. CLI and gateway surfaces (install commands, activation, running `skelm run @scope/name`) build on top of it.

## Trust posture

- **Manifest before code.** `skelm.package.json` is parsed and validated before any package file is copied or any package code is loaded. An invalid manifest fails with a typed `PackageManifestError` and nothing reaches the cache.
- **Install is always explicit.** Packages are never auto-loaded from `node_modules`; they enter a project only through an install into the package store.
- **Entry paths cannot escape the package.** Every `entry` is a package-relative, forward-slash path; absolute paths and `..` segments are rejected at validation time.
- **Triggers are offered, never armed.** Triggers declared in a manifest are always disabled by default; an operator must enable each one explicitly.
- **Secrets are references only.** A manifest declares the secret *names* a package needs. Values are resolved by the gateway's secret resolver at run time and never appear in manifests, the lockfile, or the store.
- **Permissions stay default-deny.** Per-workflow `permissions` declare a ceiling; omission means deny, exactly as for hand-authored workflows.

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

Scoped names are encoded into one path segment by replacing `/` with `__` (`@skelm/hello` → `@skelm__hello`). The store is a core library; it performs no network access. `installFromDirectory(sourceDir)` validates the manifest and checks every declared entry file exists *before* copying, stages the copy next to the final path, and renames it into place so a crash never leaves a partial install. `list()`, `get(name, version)`, and `remove(name, version?)` manage the cache; cached manifests are re-validated on every load.

`computePackageIntegrity(dir)` returns a deterministic `sha256:<hex>` over the package's sorted relative paths and file bytes. `store.verify(name, version, expectedIntegrity)` recomputes it and throws `PackageIntegrityError` on any mismatch — the tamper check used against the lockfile record.

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
      "requiredSkelmVersion": ">=0.4.0"
    }
  }
}
```

`resolved` is the local source directory today; tarball URLs arrive with remote installs. `readLockfile`, `writeLockfile`, `updateLockfileEntry`, and `removeLockfileEntry` operate on it. Writes are atomic (temp file + rename) and serialization is deterministic — sorted package keys, fixed field order — so lockfile diffs stay reviewable. A missing lockfile reads as empty; a malformed one throws `ConfigError`.
