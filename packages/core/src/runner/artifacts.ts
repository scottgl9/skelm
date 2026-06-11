import { constants } from 'node:fs'
import { mkdir, open, realpath, stat } from 'node:fs/promises'
import { dirname, isAbsolute, relative, resolve } from 'node:path'
import type { EventBus } from '../events.js'
import {
  ArtifactMaterializationError,
  type ArtifactStore,
  type ArtifactStoreHandle,
  ArtifactValidationError,
} from '../run-store.js'
import type { StepId } from '../types.js'

export type WorkspaceBindableArtifactHandle = ArtifactStoreHandle & {
  withWorkspacePath(path: string): ArtifactStoreHandle
}

export function createArtifactsHandle(opts: {
  artifactStore: ArtifactStore
  events: EventBus
  runId: string
  stepId: StepId
  materializationRoot?: string
}): WorkspaceBindableArtifactHandle {
  const { artifactStore, events, runId, stepId, materializationRoot } = opts
  return {
    put: async (putOpts) => {
      const startedAt = Date.now()
      const descriptor = await artifactStore.putArtifact({
        runId,
        stepId,
        name: putOpts.name,
        mimeType: putOpts.mimeType,
        data: putOpts.data,
      })
      events.publish({
        type: 'tool.result',
        runId,
        stepId,
        tool: 'artifacts.put',
        result: {
          artifactId: descriptor.artifactId,
          name: descriptor.name,
          mimeType: descriptor.mimeType,
          size: descriptor.size,
        },
        durationMs: Date.now() - startedAt,
        at: Date.now(),
      })
      return descriptor
    },
    get: (ref) => artifactStore.getArtifact(ref),
    list: (listOpts) => artifactStore.listArtifacts(runId, listOpts),
    materialize: async (ref, materializeOpts = {}) => {
      const workspacePath = materializationRoot
      if (workspacePath === undefined) {
        throw new ArtifactMaterializationError(
          'ctx.artifacts.materialize requires the current step to declare a workspace',
        )
      }
      const startedAt = Date.now()
      if (ref.runId !== runId) {
        throw new ArtifactMaterializationError(
          `artifact ${ref.artifactId} belongs to run ${ref.runId}, not current run ${runId}`,
        )
      }
      const found = await artifactStore.getArtifact(ref)
      if (found === null) {
        throw new ArtifactMaterializationError(
          `artifact ${ref.artifactId} was not found for run ${ref.runId}`,
        )
      }
      if (
        materializeOpts.maxBytes !== undefined &&
        found.data.byteLength > materializeOpts.maxBytes
      ) {
        throw new ArtifactMaterializationError(
          `artifact ${ref.artifactId} is ${found.data.byteLength} bytes, exceeding maxBytes ${materializeOpts.maxBytes}`,
        )
      }
      const relativePath = materializeOpts.path ?? found.descriptor.name
      const path = await resolveArtifactMaterializationPath(workspacePath, relativePath)
      await assertMaterializationTargetAllowed(workspacePath, path)
      await mkdir(dirname(path), { recursive: true })
      await assertMaterializationTargetAllowed(workspacePath, path)
      if (materializeOpts.overwrite === true) {
        const file = await open(
          path,
          constants.O_WRONLY | constants.O_CREAT | constants.O_TRUNC | constants.O_NOFOLLOW,
          0o644,
        )
        try {
          await file.writeFile(found.data)
        } finally {
          await file.close()
        }
      } else {
        try {
          const file = await open(path, 'wx')
          try {
            await file.writeFile(found.data)
          } finally {
            await file.close()
          }
        } catch (err) {
          if (
            typeof err === 'object' &&
            err !== null &&
            'code' in err &&
            (err as NodeJS.ErrnoException).code === 'EEXIST'
          ) {
            throw new ArtifactMaterializationError(
              `artifact target already exists (use overwrite: true to replace): ${relativePath}`,
            )
          }
          throw err
        }
      }
      events.publish({
        type: 'tool.result',
        runId,
        stepId,
        tool: 'artifacts.materialize',
        result: {
          artifactId: found.descriptor.artifactId,
          name: found.descriptor.name,
          mimeType: found.descriptor.mimeType,
          size: found.descriptor.size,
          path: relativePath,
          bytesWritten: found.data.byteLength,
        },
        durationMs: Date.now() - startedAt,
        at: Date.now(),
      })
      return {
        descriptor: found.descriptor,
        path,
        bytesWritten: found.data.byteLength,
      }
    },
    withWorkspacePath: (path) =>
      createArtifactsHandle({ artifactStore, events, runId, stepId, materializationRoot: path }),
  }
}

async function resolveArtifactMaterializationPath(
  root: string,
  requested: string,
): Promise<string> {
  if (requested.length === 0 || requested.includes('\0')) {
    throw new ArtifactValidationError('artifact materialization path must be a non-empty path')
  }
  if (isAbsolute(requested)) {
    throw new ArtifactValidationError('artifact materialization path must be relative')
  }
  for (const segment of requested.split(/[\\/]+/)) {
    if (segment === '' || segment === '.' || segment === '..') {
      throw new ArtifactValidationError(
        'artifact materialization path must not contain empty, dot, or parent segments',
      )
    }
  }
  const path = resolve(root, requested)
  assertInsideRoot(root, path, 'artifact materialization path must stay inside the workspace')
  return path
}

async function assertMaterializationTargetAllowed(root: string, path: string): Promise<void> {
  const rootReal = await realpath(root)
  const parentReal = await realpathNearestExistingParent(path)
  assertInsideRoot(rootReal, parentReal, 'artifact materialization parent escapes the workspace')
  try {
    const info = await stat(path)
    if (!info.isFile()) {
      throw new ArtifactValidationError('artifact materialization target must be a file')
    }
    const targetReal = await realpath(path)
    assertInsideRoot(rootReal, targetReal, 'artifact materialization target escapes the workspace')
  } catch (error) {
    if (isMissingPath(error)) return
    throw error
  }
}

async function realpathNearestExistingParent(path: string): Promise<string> {
  let current = dirname(path)
  while (true) {
    try {
      return await realpath(current)
    } catch (error) {
      if (!isMissingPath(error)) throw error
      const parent = dirname(current)
      if (parent === current) throw error
      current = parent
    }
  }
}

function assertInsideRoot(root: string, path: string, message: string): void {
  const rel = relative(resolve(root), resolve(path))
  if (rel === '' || (!rel.startsWith('..') && !isAbsolute(rel))) return
  throw new ArtifactValidationError(message)
}

function isMissingPath(error: unknown): boolean {
  return typeof error === 'object' && error !== null && 'code' in error && error.code === 'ENOENT'
}
