import { WorkspaceManager } from '@skelm/core'
import { join } from 'node:path'
import { type Router, createError, eventHandler } from 'h3'
import type { Gateway } from '../../lifecycle/gateway.js'
import { decodeMaybe } from './utils.js'

/**
 * Persistent workspaces read/manage API.
 *
 *   GET    /workspaces                          — list all persistent
 *   GET    /workspaces/:workflow/:name          — one workspace's metadata
 *   DELETE /workspaces/:workflow/:name          — clean a workspace
 *
 * The CLI used to construct WorkspaceManager locally and call into it;
 * those code paths now route through here so the gateway owns the
 * persistent-base directory and any related locks.
 */
export function registerWorkspaceRoutes(router: Router, gateway: Gateway): void {
  const manager = new WorkspaceManager({
    persistentBase: join(gateway.stateDir, 'workspaces'),
  })

  router.get(
    '/workspaces',
    eventHandler(async () => {
      const workspaces = await manager.listPersistentWorkspaces()
      return { workspaces }
    }),
  )

  router.get(
    '/workspaces/:workflow/:name',
    eventHandler(async (event) => {
      const workflow = decodeMaybe(event.context.params?.workflow)
      const name = decodeMaybe(event.context.params?.name)
      if (workflow === undefined || name === undefined) {
        throw createError({ statusCode: 400, message: 'workflow and name required' })
      }
      const ws = await manager.getPersistentWorkspace(workflow, name)
      if (ws === null) throw createError({ statusCode: 404, message: 'workspace not found' })
      return ws
    }),
  )

  router.delete(
    '/workspaces/:workflow/:name',
    eventHandler(async (event) => {
      const workflow = decodeMaybe(event.context.params?.workflow)
      const name = decodeMaybe(event.context.params?.name)
      if (workflow === undefined || name === undefined) {
        throw createError({ statusCode: 400, message: 'workflow and name required' })
      }
      await manager.cleanPersistentWorkspace(workflow, name)
      return { cleaned: `${workflow}/${name}` }
    }),
  )
}
