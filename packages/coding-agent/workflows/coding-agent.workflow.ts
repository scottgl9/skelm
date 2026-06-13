/**
 * Default workflow entrypoint for the `@skelm/coding-agent` package.
 *
 * Run with `skelm run @skelm/coding-agent` (input: `{ "task": "..." }`).
 *
 * Configuration is read from environment so the same package runs across
 * projects without edits:
 *
 *   SKELM_CODING_AGENT_WORKSPACE   absolute repo path (default: process.cwd())
 *   SKELM_CODING_AGENT_PROFILE     JSON `ProjectProfile`
 *   SKELM_CODING_AGENT_PR          set to "1"/"true" to allow PR opening
 *   SKELM_CODING_AGENT_BACKEND     backend id (default: "agent")
 *
 * Permissions are DECLARED on the agent step (default-deny, workspace-scoped
 * fsWrite, executable profiles only); the gateway intersects them with the
 * project defaults and the per-workflow `permissions` ceiling in the manifest.
 */

import { createCodingAgentWorkflow } from '@skelm/coding-agent'
import type { ProjectProfile } from '@skelm/coding-agent'

function readProfile(): ProjectProfile {
  const raw = process.env.SKELM_CODING_AGENT_PROFILE
  if (raw === undefined || raw.length === 0) return {}
  try {
    return JSON.parse(raw) as ProjectProfile
  } catch {
    return {}
  }
}

const prEnv = process.env.SKELM_CODING_AGENT_PR
const prEnabled = prEnv === '1' || prEnv === 'true'

export default createCodingAgentWorkflow({
  workspace: process.env.SKELM_CODING_AGENT_WORKSPACE ?? process.cwd(),
  backend: process.env.SKELM_CODING_AGENT_BACKEND ?? 'agent',
  profile: readProfile(),
  pr: { enabled: prEnabled },
})
