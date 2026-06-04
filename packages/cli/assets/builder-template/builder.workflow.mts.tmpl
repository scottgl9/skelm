import { persistentWorkflow } from 'skelm'

/**
 * skelm builder — a conversational agent that authors skelm workflows.
 *
 * One durable conversation per chat session over the terminal (`tui`) chat UI.
 * Each turn you describe a workflow in natural language; the agent consults the
 * bundled `skelm` skill, writes a `*.workflow.mts` into this folder, validates
 * it with `skelm validate`, and reports the path. The backend resolves from
 * skelm.config.mts — codex by default, with pi-sdk as the runtime failover.
 */

interface ChatMessage {
  sessionId: string
  from: string
  text: string
  seq: number
}

const SYSTEM = `You author skelm workflow files. skelm is a TypeScript framework whose unit of work is a typed pipeline.

Consult the skelm skill as the authoring API reference: call load_skill("skelm") if you have that tool, otherwise read skills/skelm/SKILL.md from this project.

When the user describes a workflow, produce exactly one workflow file:
- A single .mts file that exports a default pipeline(...) imported from "skelm".
- Declare zod input/output schemas at the run boundaries.
- For any agent() or infer() step, declare least-privilege AgentPermissions explicitly — every permission field defaults to deny, so grant only what the workflow needs.
- Keep it minimal and runnable; do not invent backends or tools that were not requested.

Then, in order:
1. Write the file into this directory.
2. Run "skelm validate <path>" once. Only if it reports an error, fix the file and validate again.
3. End your reply by stating the path of the workflow file you created.

If the user asks to revise an earlier workflow, edit that file and re-validate. Keep replies short.`

export default persistentWorkflow<ChatMessage>({
  id: 'skelm-builder',
  description: 'Conversational builder that authors skelm workflows from natural-language specs.',
  triggers: [{ kind: 'queue', sourceId: 'tui' }],
  agent: {
    // No `backend`: inherits skelm.config.mts `backends.agent` (codex → pi-sdk).
    system: SYSTEM,
    // Least-privilege, explicitly declared (no unrestricted bypass): read the
    // project, write generated files, run validation commands, load the skelm skill.
    // `fsWrite: ['./']` is scoped to this project — authoring workflow files
    // here is the builder's whole job.
    //
    // networkEgress stays 'allow' (not an allowHosts list) ON PURPOSE: the
    // in-process pi-sdk failover can't route through the gateway egress proxy,
    // so it can't enforce a narrower policy. The start-of-step check runs
    // against codex (the routing primary, which CAN enforce), so a narrower
    // policy would pass there yet go silently unenforced once the turn fell
    // over to pi-sdk. 'allow' is the honest contract for this codex→pi-sdk
    // chain; pin SKELM_BUILDER_BACKEND=codex and tighten this if you never want
    // the pi-sdk failover.
    permissions: {
      fsRead: ['./'],
      fsWrite: ['./'],
      // Include bash so the pi-sdk fallback exposes its shell tool; the
      // builder prompt requires running `skelm validate <path>` after writing.
      allowedExecutables: ['skelm', 'node', 'bash'],
      allowedSkills: ['skelm'],
      networkEgress: 'allow',
    },
    maxTurns: 12,
    sessionKey: (msg) => msg.sessionId,
    reply: (text) => ({ reply: text }),
  },
})
