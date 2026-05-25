import { agent, pipeline, wait } from 'skelm'
import { z } from 'zod'

/**
 * skelm builder — a skelm workflow that authors other skelm workflows.
 *
 * Run it by directory (`skelm run builder`). Pass the spec up front with
 * `--input '{"spec":"..."}'`, or omit it and the wait() step prompts for it
 * interactively (the gateway emits run.waiting and the CLI drives the prompt).
 */

const Input = z.object({
  /** Natural-language description of the workflow to build. */
  spec: z.string().optional(),
  /** Directory to write the generated workflow into. Defaults to the cwd. */
  outDir: z.string().optional(),
})

const Output = z.object({
  path: z.string(),
  summary: z.string(),
  permissions: z.array(z.string()),
})

const SYSTEM = `You author skelm workflow files. skelm is a TypeScript framework whose unit of work is a typed pipeline.

First call load_skill("skelm") and follow it as the authoring API reference.

Produce exactly one workflow file:
- A single .mts file that \`export default pipeline({ ... })\` (import from "skelm").
- Declare zod input/output schemas at the run boundaries.
- For any agent()/llm() step, declare least-privilege AgentPermissions explicitly — every permission field defaults to deny, so grant only what the workflow needs.
- Keep it minimal and runnable; do not invent backends or tools that aren't requested.

Then:
1. Write the file with fs_write into the target directory.
2. Run \`skelm validate <path>\` with the exec tool. If it reports issues, fix the file and re-validate until it passes.
3. Reply with ONLY a JSON object: { "path": "<absolute or project-relative path>", "summary": "<one-sentence description>", "permissions": ["<dimension granted>", ...] }.`

export default pipeline({
  id: 'skelm-builder',
  description: 'Builds a new skelm workflow from a natural-language spec.',
  input: Input,
  output: Output,
  steps: [
    wait({
      id: 'ask-spec',
      message: 'Describe the workflow to build (reply with JSON: {"spec":"..."})',
      when: (ctx) => !(ctx.input as z.infer<typeof Input>).spec,
      output: z.object({ spec: z.string() }),
    }),
    agent({
      id: 'build',
      backend: 'agent',
      skills: ['skelm'],
      system: SYSTEM,
      prompt: (ctx) => {
        const input = ctx.input as z.infer<typeof Input>
        const resumed = ctx.steps['ask-spec'] as { spec?: string } | undefined
        const spec = input.spec ?? resumed?.spec ?? ''
        const outDir = input.outDir ?? '.'
        return `Build a skelm workflow for this spec:\n\n${spec}\n\nWrite the file into ${outDir}/ and validate it before returning.`
      },
      // Self-contained least-privilege grants (no config profile dependency, so
      // the workflow is portable): read the project, write generated files, run
      // skelm/node, load the skelm skill. No network egress — the backend
      // reaches the LLM endpoint directly, not through a tool.
      permissions: {
        fsRead: ['./'],
        fsWrite: ['./'],
        allowedExecutables: ['skelm', 'node'],
        allowedSkills: ['skelm'],
        networkEgress: 'deny',
      },
      output: Output,
      maxTurns: 12,
      timeoutMs: 300_000,
    }),
  ],
  finalize: (ctx) => ctx.steps.build as z.infer<typeof Output>,
})
