# Workflow Packages

Workflow packages are regular npm packages that ship reusable skelm pipelines,
package-local docs, and package-local assets such as prompts, templates, and
fixtures. The package is installed by the host project, then registered from an
explicit package root. skelm does not scan `node_modules` broadly.

## Package metadata

Declare workflow package metadata in `package.json` under
`skelm.workflowPackage`:

```json
{
  "name": "@acme/skelm-triage-workflows",
  "version": "1.2.3",
  "type": "module",
  "exports": {
    "./workflows/issue.workflow.mts": "./workflows/issue.workflow.mts"
  },
  "skelm": {
    "workflowPackage": {
      "id": "acme.triage",
      "name": "ACME triage workflows",
      "workflows": [
        {
          "id": "acme.triage.issue",
          "path": "./workflows/issue.workflow.mts",
          "export": "default",
          "name": "Issue triage"
        }
      ],
      "assets": "./assets",
      "docs": "./README.md"
    }
  }
}
```

`id` values are stable runtime identifiers. Package ids and workflow ids must be
unique among registered packages. Workflow `path`, `assets`, and `docs` values
are package-relative and must stay inside the package root.

## Discovery and registration

Hosts register installed packages by resolving the installed dependency root and
passing that root explicitly:

```ts
import { WorkflowRegistry, discoverWorkflowPackage } from '@skelm/core'

const registry = new WorkflowRegistry()
const pkg = await discoverWorkflowPackage('/app/node_modules/@acme/skelm-triage-workflows')

registry.registerPackage(pkg)
```

For multiple packages, collect errors without failing the whole batch:

```ts
import { discoverWorkflowPackages } from '@skelm/core'

const result = await discoverWorkflowPackages([
  '/app/node_modules/@acme/skelm-triage-workflows',
  '/app/node_modules/@acme/skelm-release-workflows',
])

for (const pkg of result.packages) registry.registerPackage(pkg)
if (result.errors.length > 0) console.warn(result.errors)
```

The registry stores package metadata and stable absolute workflow paths. Loading
pipeline modules remains lazy and is owned by the host or gateway path that
already runs workflows.

## Assets convention

The `assets` field names a package-relative directory. It is intentionally only
a convention in this API: workflow package discovery records the normalized
`assetsPath`, but does not provide an asset loader and does not depend on the
asset-loading feature branch.

Use package-relative asset paths in your own workflow code or host adapter, and
resolve them through the registered package:

```ts
const promptPath = registry.resolvePackagePath('acme.triage', './assets/prompts/review.md')
```

Traversal and absolute paths are rejected. This keeps installed package content
separate from workspace write roots, artifacts, and process cwd.

## Authoring checklist

- Publish normal ESM package files; do not rely on the consumer's cwd.
- Keep workflow ids globally unique, for example `vendor.domain.workflow`.
- Include docs in the package and point `skelm.workflowPackage.docs` at them.
- Keep prompts, templates, and fixtures under the declared `assets` directory.
- Treat package code as trusted application code; installation is an operator
  decision, not a sandbox boundary.
