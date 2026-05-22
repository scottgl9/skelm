import { TrustEnforcer, code, pipeline, resolvePermissions } from '@skelm/core'
import { z } from 'zod'

/**
 * Demonstrates the default-deny permission model in action without an
 * agent step (which is added in a later milestone). A code() step builds
 * a TrustEnforcer from an empty default policy and asserts that every
 * privileged action is denied.
 *
 * This is the structural answer to "what does default-deny actually
 * mean?": no allowlist entry, no allowed action.
 */
export default pipeline({
  id: 'permissions-demo',
  description: 'Shows TrustEnforcer denying every privileged action under default-deny.',
  input: z.object({}),
  output: z.object({
    denials: z.array(z.string()),
    summary: z.string(),
  }),
  steps: [
    code({
      id: 'try-everything',
      run: () => {
        const enforcer = new TrustEnforcer(resolvePermissions(undefined, undefined))
        const denials: string[] = []

        const checks: Array<[string, () => { allow: boolean }]> = [
          ['call gh.list_issues', () => enforcer.canCallTool('gh.list_issues')],
          ['exec rg', () => enforcer.canExec('rg')],
          ['attach mcp gh', () => enforcer.canAttachMcpServer('gh')],
          ['load skill triage', () => enforcer.canLoadSkill('triage')],
          ['fetch api.github.com', () => enforcer.canFetch('api.github.com')],
          ['read /etc/passwd', () => enforcer.canRead('/etc/passwd')],
          ['write /tmp/x', () => enforcer.canWrite('/tmp/x')],
        ]

        for (const [label, check] of checks) {
          if (!check().allow) denials.push(label)
        }

        return {
          denials,
          summary: `${denials.length}/${checks.length} actions denied under default-deny`,
        }
      },
    }),
  ],
})
