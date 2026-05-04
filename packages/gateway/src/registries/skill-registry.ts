import { promises as fs } from 'node:fs'
import { isAbsolute, resolve } from 'node:path'
import { type Skill, parseSkill } from '@skelm/core'
import { BaseRegistry } from './base.js'
import { FsWatcher } from './fs-watch.js'
import { walkGlob } from './glob.js'

export interface SkillRegistryOptions {
  projectRoot: string
  glob: string
  watch?: boolean
}

/**
 * Registry of SKILL.md documents discovered on disk. The skill `id` from
 * frontmatter is the registry key; collisions cause the later-discovered
 * skill to overwrite earlier ones (sorted by path, so deterministic).
 *
 * Skills with malformed frontmatter are skipped; their parse errors are
 * available via `getErrors()` for tooling to surface.
 */
export class SkillRegistry extends BaseRegistry<Skill> {
  private watcher: FsWatcher | null = null
  private errors: Map<string, string> = new Map()
  private readonly scanRoot: string

  constructor(private readonly options: SkillRegistryOptions) {
    super()
    const segment = options.glob.split('*')[0] ?? ''
    const rel = segment.replace(/\/$/, '')
    this.scanRoot = isAbsolute(rel) ? rel : resolve(options.projectRoot, rel === '' ? '.' : rel)
  }

  async start(): Promise<void> {
    await this.refresh()
    if (this.options.watch) {
      this.watcher = new FsWatcher({
        dir: this.scanRoot,
        onChange: () => {
          void this.refresh().catch(() => {
            /* ignore */
          })
        },
      })
      this.watcher.start()
    }
  }

  override async close(): Promise<void> {
    await this.watcher?.close()
    this.watcher = null
    await super.close()
  }

  /** Map of source path → parse error message, for skills that failed to load. */
  getErrors(): ReadonlyMap<string, string> {
    return this.errors
  }

  protected async loadSnapshot(): Promise<Skill[]> {
    const errors = new Map<string, string>()
    const files = await walkGlob(this.options.projectRoot, this.options.glob)
    const skills: Skill[] = []
    for (const path of files) {
      try {
        const raw = await fs.readFile(path, 'utf8')
        const skill = parseSkill(path, raw)
        skills.push(skill)
      } catch (err) {
        errors.set(path, (err as Error).message)
      }
    }
    this.errors = errors
    return skills
  }

  getScanRoot(): string {
    return this.scanRoot
  }
}
