import { promises as fs } from 'node:fs'
import { dirname, isAbsolute, resolve } from 'node:path'
import { type Skill, parseSkill } from '@skelm/core'
import type { SkillRegistry } from './skill-registry.js'

export interface CreateSkillSourceOptions {
  registry: SkillRegistry
  workflowPath?: string
  skillsDir?: string
}

/**
 * Returns a `(skillId) => Promise<Skill | null>` resolver suitable for
 * `RunOptions.skillSource`, layering three lookups in order:
 *
 *   1. registered skills (the gateway's `SkillRegistry`)
 *   2. `<workflowDir>/skills/<id>/SKILL.md` (relative to the workflow file)
 *   3. `<skillsDir>/<id>/SKILL.md` (configured fallback root)
 *
 * Returns null when the id is unknown or its SKILL.md fails to parse — the
 * runner treats that as "skill missing" and warns via permission/event paths;
 * callers should not throw.
 */
export function createSkillSource(
  opts: CreateSkillSourceOptions,
): (skillId: string) => Promise<Skill | null> {
  const { registry, workflowPath, skillsDir } = opts
  const workflowDir = workflowPath !== undefined ? dirname(workflowPath) : undefined
  const fallbackRoot =
    skillsDir !== undefined && workflowDir !== undefined && !isAbsolute(skillsDir)
      ? resolve(workflowDir, skillsDir)
      : skillsDir
  return async (skillId) => {
    const registered = registry.get(skillId)
    if (registered !== undefined) return registered
    if (workflowDir !== undefined) {
      const hit = await tryLoadSkillFile(resolve(workflowDir, 'skills', skillId, 'SKILL.md'))
      if (hit !== null) return hit
    }
    if (fallbackRoot !== undefined) {
      const hit = await tryLoadSkillFile(resolve(fallbackRoot, skillId, 'SKILL.md'))
      if (hit !== null) return hit
    }
    return null
  }
}

async function tryLoadSkillFile(path: string): Promise<Skill | null> {
  let raw: string
  try {
    raw = await fs.readFile(path, 'utf8')
  } catch {
    return null
  }
  try {
    return parseSkill(path, raw)
  } catch {
    return null
  }
}
