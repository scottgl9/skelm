#!/usr/bin/env node
// Bundle non-TS assets the CLI ships at runtime. Currently just the canonical
// skelm authoring skill, copied verbatim from the repo's single source of truth
// (`skill/skelm/SKILL.md`) so `skelm builder` can scaffold it into a generated
// project. Kept here (build step) rather than a committed duplicate that drifts:
// the build refreshes it, and a guard test asserts the copy matches canonical.
import { copyFileSync, mkdirSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const here = dirname(fileURLToPath(import.meta.url))
const repoRoot = resolve(here, '..', '..', '..')
const src = join(repoRoot, 'skill', 'skelm', 'SKILL.md')
const destDir = join(here, '..', 'assets', 'skelm-skill')
const dest = join(destDir, 'SKILL.md')

mkdirSync(destDir, { recursive: true })
copyFileSync(src, dest)
process.stdout.write(`copied skelm skill → ${dest}\n`)
