/**
 * Provider / project review profiles.
 *
 * A profile bundles the per-project knobs a reviewer needs: the review style
 * (what to emphasise), the focused test commands the agent may run, the
 * checks that must be green before approving, and the safe-write behaviour
 * (whether posting is allowed at all and which review events are permitted).
 *
 * Safe-write is default-deny: `safeWrite.mode` defaults to `'off'`, so a
 * profile that says nothing about writing can never post. Even with a write
 * mode set, the runtime still requires the write permission + credential ref
 * to be granted by the gateway — the profile is a ceiling, not a grant.
 */

import { z } from 'zod'

/** How aggressively the reviewer may act on the provider. */
export type SafeWriteMode =
  /** Never post anything; produce findings only. */
  | 'off'
  /** Post a COMMENT-style review/summary; never approve or request changes. */
  | 'comment'
  /** Post COMMENT or REQUEST_CHANGES, but never APPROVE. */
  | 'request-changes'
  /** Post any review event, including APPROVE. */
  | 'approve'

export const safeWriteModeSchema = z.enum(['off', 'comment', 'request-changes', 'approve'])

export const reviewProfileSchema = z.object({
  /** Profile id (e.g. `default`, `strict`, `docs-only`). */
  id: z.string().min(1),
  /** Free-form description of the review emphasis, injected into the prompt. */
  reviewStyle: z.string().min(1).optional(),
  /**
   * Focused test commands the agent may run via executable-profile shell
   * tools. Each is a bare argv (`["pnpm", "test", "--filter", "core"]`). The
   * executables still have to be granted by the workflow's permissions /
   * executable profile; listing a command here does not grant it.
   */
  testCommands: z.array(z.array(z.string().min(1)).min(1)).default([]),
  /** Check names that must conclude `success` before an APPROVE is allowed. */
  requiredChecks: z.array(z.string().min(1)).default([]),
  /** File globs to ignore when selecting files to inspect (e.g. lockfiles). */
  ignorePaths: z.array(z.string().min(1)).default([]),
  safeWrite: z
    .object({
      mode: safeWriteModeSchema.default('off'),
      /**
       * When true, an APPROVE is downgraded to COMMENT if any required check
       * is not green. Defaults to true — never approve over red CI.
       */
      requireGreenChecks: z.boolean().default(true),
    })
    .default({ mode: 'off', requireGreenChecks: true }),
})

export type ReviewProfile = z.output<typeof reviewProfileSchema>
export type ReviewProfileInput = z.input<typeof reviewProfileSchema>

export const profileConfigSchema = z.object({
  profiles: z.array(reviewProfileSchema).default([]),
  /** Id of the profile used when the run input names none. */
  defaultProfile: z.string().min(1).default('default'),
})

export type ProfileConfig = z.output<typeof profileConfigSchema>
export type ProfileConfigInput = z.input<typeof profileConfigSchema>

/** Built-in default profile: read-only (`safeWrite.mode: 'off'`). */
export const DEFAULT_PROFILE: ReviewProfile = reviewProfileSchema.parse({
  id: 'default',
  reviewStyle:
    'Review for correctness, security, and clarity. Flag bugs, missing error handling, ' +
    'and unsafe patterns. Be concise; reference files and lines.',
})

/**
 * Resolve a profile by id from a config, falling back to the config's
 * `defaultProfile`, then to the built-in {@link DEFAULT_PROFILE}. Parsing the
 * config applies defaults (notably `safeWrite.mode: 'off'`).
 */
export function resolveProfile(config: ProfileConfigInput | undefined, id?: string): ReviewProfile {
  if (config === undefined) return DEFAULT_PROFILE
  const parsed = profileConfigSchema.parse(config)
  const wanted = id ?? parsed.defaultProfile
  const found = parsed.profiles.find((p) => p.id === wanted)
  if (found !== undefined) return found
  const fallback = parsed.profiles.find((p) => p.id === parsed.defaultProfile)
  return fallback ?? DEFAULT_PROFILE
}
