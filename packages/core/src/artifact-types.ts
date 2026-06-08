import type { RunId } from './types-base.js'

// Artifact-store shapes kept in a leaf module so `types.ts` can reference
// `ArtifactStoreHandle` (via Context.artifacts) without inline-importing
// `run-store.ts`, which closes a `types ↔ run-store` cycle. run-store.ts
// re-exports these for back-compat.

/** Stable handle to a single artifact in the store. */
export interface ArtifactRef {
  readonly runId: RunId
  readonly artifactId: string
}

/** Metadata describing a stored artifact (no payload). */
export interface ArtifactDescriptor extends ArtifactRef {
  readonly stepId?: string
  readonly name: string
  readonly mimeType: string
  readonly size: number
  readonly createdAt: number
}

export interface ArtifactMaterializeOptions {
  readonly path?: string
  readonly overwrite?: boolean
  readonly maxBytes?: number
}

export interface ArtifactMaterialization {
  readonly descriptor: ArtifactDescriptor
  readonly path: string
  readonly bytesWritten: number
}

export class ArtifactValidationError extends Error {
  override readonly name = 'ArtifactValidationError'
}

export class ArtifactMaterializationError extends Error {
  override readonly name = 'ArtifactMaterializationError'
}

/**
 * Per-step facade exposed on `ctx.artifacts`. The runner binds `runId` and
 * `stepId` automatically — callers only specify the payload metadata.
 */
export interface ArtifactStoreHandle {
  put(opts: {
    name: string
    mimeType: string
    data: Uint8Array | string
  }): Promise<ArtifactDescriptor>
  get(ref: ArtifactRef): Promise<{ descriptor: ArtifactDescriptor; data: Uint8Array } | null>
  list(opts?: { stepId?: string }): AsyncIterable<ArtifactDescriptor>
  materialize(ref: ArtifactRef, opts?: ArtifactMaterializeOptions): Promise<ArtifactMaterialization>
}

export function validateArtifactMetadata(opts: { name: string; mimeType: string }): void {
  validateArtifactName(opts.name)
  validateArtifactMimeType(opts.mimeType)
}

export function validateArtifactName(name: string): void {
  if (name.length === 0 || name.length > 255) {
    throw new ArtifactValidationError('artifact name must be 1-255 characters')
  }
  if (name === '.' || name === '..') {
    throw new ArtifactValidationError('artifact name must not be a path sentinel')
  }
  if (name.includes('/') || name.includes('\\') || name.includes('\0')) {
    throw new ArtifactValidationError('artifact name must be a single safe file name')
  }
  if (!/^[A-Za-z0-9][A-Za-z0-9._ -]*$/.test(name)) {
    throw new ArtifactValidationError(
      'artifact name must start with an alphanumeric character and contain only letters, numbers, spaces, dots, underscores, and hyphens',
    )
  }
}

export function validateArtifactMimeType(mimeType: string): void {
  if (
    mimeType.length === 0 ||
    mimeType.length > 127 ||
    !/^[A-Za-z0-9][A-Za-z0-9!#$&^_.+-]*\/[A-Za-z0-9][A-Za-z0-9!#$&^_.+-]*$/.test(mimeType)
  ) {
    throw new ArtifactValidationError('artifact mimeType must be a valid type/subtype token')
  }
}
