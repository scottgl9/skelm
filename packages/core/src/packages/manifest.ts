// skelm.package.json — the workflow-package manifest. The manifest is parsed
// and validated BEFORE any package code executes; it is the trust boundary
// between files on disk and workflows the gateway will load.

import { PackageManifestError } from '../errors.js'
import type { AgentPermissions } from '../permissions.js'

/** Manifest filename at a workflow-package root. */
export const PACKAGE_MANIFEST_FILENAME = 'skelm.package.json'

/** Workflow entrypoint declared by a package manifest. */
export interface WorkflowPackageWorkflowEntry {
  /** Unique within the manifest. The id `default` is what `skelm run <package>` runs. */
  id: string
  /** Package-relative path to the workflow module. Must not escape the package root. */
  entry: string
  kind?: 'pipeline' | 'persistent'
  description?: string
  /** Declared permission ceiling for this workflow; default-deny when omitted. */
  permissions?: AgentPermissions
}

/** Secret the package needs, by name only. Manifests never carry secret values. */
export interface WorkflowPackageSecretRef {
  name: string
  description?: string
}

/** Trigger the package offers. Triggers are always disabled until an operator enables them. */
export interface WorkflowPackageTrigger {
  id: string
  kind: string
  description?: string
}

export interface WorkflowPackageSelfTest {
  /** Package-relative path to the self-test module. Same path rules as workflow entries. */
  entry: string
}

/** The `skelm` section of a workflow-package manifest. */
export interface WorkflowPackageSkelmSection {
  apiVersion: 1
  /** Semver range the host skelm version must satisfy. */
  requiredSkelmVersion?: string
  workflows: readonly WorkflowPackageWorkflowEntry[]
  /** JSON-schema-ish description of package config. Opaque to the substrate. */
  config?: Readonly<Record<string, unknown>>
  secrets?: readonly WorkflowPackageSecretRef[]
  integrations?: readonly string[]
  stateNamespaces?: readonly string[]
  /** Artifact types the package emits. */
  artifacts?: readonly string[]
  triggers?: readonly WorkflowPackageTrigger[]
  selfTest?: WorkflowPackageSelfTest
  /** Opaque dashboard metadata. */
  dashboard?: Readonly<Record<string, unknown>>
}

/** Parsed and validated `skelm.package.json`. Extra top-level npm fields are tolerated. */
export interface WorkflowPackageManifest {
  /** npm-style package name, e.g. `@skelm/hello`. */
  name: string
  /** Exact semver version. */
  version: string
  description?: string
  license?: string
  homepage?: string
  repository?: string | Readonly<Record<string, unknown>>
  skelm: WorkflowPackageSkelmSection
}

// validate-npm-package-name's new-package rule: lowercase, URL-safe, no
// leading dot/underscore; optional @scope/ prefix.
const NPM_NAME_RE = /^(?:@[a-z0-9-~][a-z0-9-._~]*\/)?[a-z0-9-~][a-z0-9-._~]*$/
const NPM_NAME_MAX_LENGTH = 214

const SEMVER_RE =
  /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)(?:-((?:0|[1-9]\d*|\d*[a-zA-Z-][0-9a-zA-Z-]*)(?:\.(?:0|[1-9]\d*|\d*[a-zA-Z-][0-9a-zA-Z-]*))*))?(?:\+([0-9a-zA-Z-]+(?:\.[0-9a-zA-Z-]+)*))?$/

function fail(source: string | undefined, message: string): never {
  throw new PackageManifestError(source === undefined ? message : `${source}: ${message}`, source)
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function requireString(value: unknown, field: string, source: string | undefined): string {
  if (typeof value !== 'string' || value.length === 0) {
    fail(source, `\`${field}\` must be a non-empty string`)
  }
  return value
}

function optionalString(value: unknown, field: string, source: string | undefined): void {
  if (value !== undefined && typeof value !== 'string') {
    fail(source, `\`${field}\` must be a string when present`)
  }
}

function validatePackageName(value: unknown, source: string | undefined): string {
  const name = requireString(value, 'name', source)
  if (name.length > NPM_NAME_MAX_LENGTH || !NPM_NAME_RE.test(name)) {
    fail(source, `\`name\` is not a valid npm package name: "${name}"`)
  }
  return name
}

function validateEntryPath(value: unknown, field: string, source: string | undefined): string {
  const entry = requireString(value, field, source)
  // Backslashes are rejected so `..\` cannot dodge the segment check on
  // Windows; package-relative paths are always posix-style.
  if (entry.includes('\\')) {
    fail(source, `\`${field}\` must use forward slashes: "${entry}"`)
  }
  if (entry.startsWith('/') || /^[A-Za-z]:/.test(entry)) {
    fail(source, `\`${field}\` must be a package-relative path, not absolute: "${entry}"`)
  }
  if (entry.split('/').includes('..')) {
    fail(source, `\`${field}\` must not escape the package root: "${entry}"`)
  }
  return entry
}

function validateStringArray(value: unknown, field: string, source: string | undefined): void {
  if (value === undefined) return
  if (!Array.isArray(value) || value.some((v) => typeof v !== 'string' || v.length === 0)) {
    fail(source, `\`${field}\` must be an array of non-empty strings when present`)
  }
}

function validateOpaqueRecord(value: unknown, field: string, source: string | undefined): void {
  if (value !== undefined && !isPlainObject(value)) {
    fail(source, `\`${field}\` must be an object when present`)
  }
}

function validateWorkflows(value: unknown, source: string | undefined): void {
  if (!Array.isArray(value)) {
    fail(source, '`skelm.workflows` must be an array of workflow entries')
  }
  const seen = new Set<string>()
  for (const [i, entry] of value.entries()) {
    const field = `skelm.workflows[${i}]`
    if (!isPlainObject(entry)) fail(source, `\`${field}\` must be an object`)
    const id = requireString(entry.id, `${field}.id`, source)
    if (seen.has(id)) {
      fail(source, `\`skelm.workflows\` ids must be unique; duplicate id "${id}"`)
    }
    seen.add(id)
    validateEntryPath(entry.entry, `${field}.entry`, source)
    if (entry.kind !== undefined && entry.kind !== 'pipeline' && entry.kind !== 'persistent') {
      fail(source, `\`${field}.kind\` must be 'pipeline' or 'persistent' when present`)
    }
    optionalString(entry.description, `${field}.description`, source)
    validateOpaqueRecord(entry.permissions, `${field}.permissions`, source)
  }
}

function validateSecrets(value: unknown, source: string | undefined): void {
  if (value === undefined) return
  if (!Array.isArray(value)) fail(source, '`skelm.secrets` must be an array when present')
  for (const [i, entry] of value.entries()) {
    const field = `skelm.secrets[${i}]`
    if (!isPlainObject(entry)) fail(source, `\`${field}\` must be an object`)
    requireString(entry.name, `${field}.name`, source)
    optionalString(entry.description, `${field}.description`, source)
  }
}

function validateTriggers(value: unknown, source: string | undefined): void {
  if (value === undefined) return
  if (!Array.isArray(value)) fail(source, '`skelm.triggers` must be an array when present')
  for (const [i, entry] of value.entries()) {
    const field = `skelm.triggers[${i}]`
    if (!isPlainObject(entry)) fail(source, `\`${field}\` must be an object`)
    requireString(entry.id, `${field}.id`, source)
    requireString(entry.kind, `${field}.kind`, source)
    optionalString(entry.description, `${field}.description`, source)
  }
}

function validateSkelmSection(value: unknown, source: string | undefined): void {
  if (!isPlainObject(value)) {
    fail(source, 'manifest must declare a `skelm` object')
  }
  if (value.apiVersion !== 1) {
    fail(source, `\`skelm.apiVersion\` must be 1; got ${JSON.stringify(value.apiVersion)}`)
  }
  optionalString(value.requiredSkelmVersion, 'skelm.requiredSkelmVersion', source)
  validateWorkflows(value.workflows, source)
  validateOpaqueRecord(value.config, 'skelm.config', source)
  validateSecrets(value.secrets, source)
  validateStringArray(value.integrations, 'skelm.integrations', source)
  validateStringArray(value.stateNamespaces, 'skelm.stateNamespaces', source)
  validateStringArray(value.artifacts, 'skelm.artifacts', source)
  validateTriggers(value.triggers, source)
  if (value.selfTest !== undefined) {
    if (!isPlainObject(value.selfTest)) {
      fail(source, '`skelm.selfTest` must be an object when present')
    }
    validateEntryPath(value.selfTest.entry, 'skelm.selfTest.entry', source)
  }
  validateOpaqueRecord(value.dashboard, 'skelm.dashboard', source)
}

/**
 * Validate an already-parsed manifest value. Throws {@link PackageManifestError}
 * on the first violation; returns the value typed as a manifest on success.
 */
export function validatePackageManifest(value: unknown, source?: string): WorkflowPackageManifest {
  if (!isPlainObject(value)) {
    fail(source, 'manifest must be a JSON object')
  }
  validatePackageName(value.name, source)
  const version = requireString(value.version, 'version', source)
  if (!SEMVER_RE.test(version)) {
    fail(source, `\`version\` must be an exact semver version: "${version}"`)
  }
  optionalString(value.description, 'description', source)
  optionalString(value.license, 'license', source)
  optionalString(value.homepage, 'homepage', source)
  if (
    value.repository !== undefined &&
    typeof value.repository !== 'string' &&
    !isPlainObject(value.repository)
  ) {
    fail(source, '`repository` must be a string or object when present')
  }
  validateSkelmSection(value.skelm, source)
  return value as unknown as WorkflowPackageManifest
}

/**
 * Parse and validate raw `skelm.package.json` text. Throws
 * {@link PackageManifestError} on malformed JSON or an invalid manifest.
 */
export function parsePackageManifest(raw: string, source?: string): WorkflowPackageManifest {
  let parsed: unknown
  try {
    parsed = JSON.parse(raw)
  } catch (err) {
    fail(source, `malformed JSON: ${err instanceof Error ? err.message : String(err)}`)
  }
  return validatePackageManifest(parsed, source)
}
