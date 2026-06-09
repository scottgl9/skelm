import { type Router, createError, eventHandler } from 'h3'
import type { GatewayContext } from '../../lifecycle/gateway-types.js'
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
 *
 * Reuses the gateway's shared WorkspaceManager (the same instance the
 * per-request Runners use) so a persistent workspace created by a run and the
 * workspace these routes list/show/clean resolve to one base directory.
 */
export function registerWorkspaceRoutes(router: Router, gateway: GatewayContext): void {
  const manager = gateway.workspaceManager

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
