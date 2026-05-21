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
}
