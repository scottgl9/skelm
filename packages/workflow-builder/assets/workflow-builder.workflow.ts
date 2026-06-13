import { persistentWorkflow } from '@skelm/core'

/**
 * @skelm/workflow-builder — a conversational agent that inspects, authors, and
 * revises skelm workflows in the surrounding project.
 *
 * One durable conversation per session. Each turn you describe a workflow or a
 * change; the agent reads the project's existing workflows (source + derived
 * graph), proposes a NEW workflow or declarative graph/source edits, runs
 * `skelm validate` on the result, and reports a REVIEWABLE patch (a unified
 * diff). It never applies a change destructively: structural edits go through
 * the gateway round-trip apply route, which is dry-run-by-default and refuses
 * code-owned regions (inline run/while/on/items predicates).
 *
 * Permissions are DECLARED and default-deny:
 *   - fsRead scoped to the project (`./`) so it can read existing workflows;
 *   - NO fsWrite — the agent never writes source directly. Edits flow through
 *     the audited apply route, which the gateway owns;
 *   - the `nodeBuild` executable profile (operator-defined) for running
 *     `skelm validate` / fixture tests;
 *   - the `skelm` skill as the authoring API reference.
 * Every other dimension stays undefined, which the runtime treats as deny.
 */

interface ChatMessage {
  sessionId: string
  text: string
}

const SYSTEM = `You inspect, author, and revise skelm workflows for the surrounding project.

skelm is a TypeScript framework whose unit of work is a typed, inspectable pipeline. Consult the skelm skill as the authoring API reference: call load_skill("skelm") if available, otherwise read skills/skelm/SKILL.md.

Workflow:
1. Inspect: read the project's existing *.workflow.{ts,mts} files and their derived graphs before proposing anything.
2. Propose: for a NEW workflow, write one minimal, runnable file that exports a default pipeline(...) or persistentWorkflow(...). For a REVISION, prefer declarative graph edits (reorderSteps, setStepField, addStep, removeStep) applied through the gateway round-trip apply route.
3. Validate: run "skelm validate <path>" on the result. Fix and re-validate on error.
4. Report a REVIEWABLE patch (a unified diff) and the file path. Never imply a change was written unless the apply route reported applied: true — the route is dry-run by default.

Constraints:
- The authored TypeScript is the single source of truth. Never rewrite a file directly; never rewrite a code-owned region (inline run/while/on/items predicates) — surface those as manual-edit suggestions.
- For any agent() or infer() step you author, declare least-privilege AgentPermissions explicitly. Every permission field defaults to deny.
- Keep replies short.`

export default persistentWorkflow<ChatMessage>({
  id: 'skelm-workflow-builder',
  description:
    'Conversational builder that inspects, authors, and revises skelm workflows as reviewable patches.',
  triggers: [{ kind: 'queue', sourceId: 'workflow-builder' }],
  agent: {
    system: SYSTEM,
    // Declared, default-deny, project-scoped. No fsWrite: the agent reads the
    // project and proposes edits, but every write goes through the gateway's
    // audited apply route, not a direct filesystem write. `nodeBuild` is an
    // operator-defined executable profile for running validation/test commands.
    permissions: {
      fsRead: ['./'],
      executableProfiles: ['nodeBuild'],
      allowedSkills: ['skelm'],
    },
    maxTurns: 16,
    sessionKey: (msg) => msg.sessionId,
    reply: (text) => ({ reply: text }),
  },
})
