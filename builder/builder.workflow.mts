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

// Dimensions the build step grants — reported in the result regardless of how
// the model phrased its final message.
const GRANTED = ['fsRead=./', 'fsWrite=./', 'exec=skelm,node', 'skills=skelm', 'network=allow']

/**
 * Derive the structured result from the agent's free-form output. Small local
 * models reliably write the file but don't reliably end with a strict JSON
 * object, so we prefer a JSON object if the agent emitted one and otherwise
 * recover the generated path from the text.
 */
function summarize(out: unknown): z.infer<typeof Output> {
  const o = out !== null && typeof out === 'object' ? (out as Record<string, unknown>) : undefined
  // A backend that returns a structured {path,...} result directly.
  if (o !== undefined && typeof o.path === 'string') {
    return {
      path: o.path,
      summary: typeof o.summary === 'string' ? o.summary : `Generated ${o.path}`,
      permissions: Array.isArray(o.permissions) ? o.permissions.map(String) : GRANTED,
    }
  }
  // Otherwise recover from the agent's free-form text (agent steps without an
  // output schema record `{ text, ... }`).
  const text = typeof out === 'string' ? out : typeof o?.text === 'string' ? o.text : ''
  const json = text.match(/\{[\s\S]*"path"[\s\S]*\}/)
  if (json !== null) {
    try {
      const parsed = JSON.parse(json[0]) as Record<string, unknown>
      if (typeof parsed.path === 'string') {
        return {
          path: parsed.path,
          summary: typeof parsed.summary === 'string' ? parsed.summary : `Generated ${parsed.path}`,
          permissions: Array.isArray(parsed.permissions) ? parsed.permissions.map(String) : GRANTED,
        }
      }
    } catch {
      // fall through to path recovery
    }
  }
  const path = text.match(/[\w./-]+\.(?:workflow|pipeline)\.m?ts/)?.[0] ?? ''
  return {
    path,
    summary: path ? `Generated ${path}` : 'Agent finished without reporting a workflow file path.',
    permissions: GRANTED,
  }
}

const SYSTEM = `You author skelm workflow files. skelm is a TypeScript framework whose unit of work is a typed pipeline.

Consult the skelm skill as the authoring API reference: call load_skill("skelm") if you have that tool, otherwise read skills/skelm/SKILL.md from the project.

Produce exactly one workflow file:
- A single .mts file that \`export default pipeline({ ... })\` (import from "skelm").
- Declare zod input/output schemas at the run boundaries.
- For any agent()/llm() step, declare least-privilege AgentPermissions explicitly — every permission field defaults to deny, so grant only what the workflow needs.
- Keep it minimal and runnable; do not invent backends or tools that aren't requested.

Then, in order, and stop as soon as step 3 is done:
1. Write the file into the target directory.
2. Run \`skelm validate <path>\` once. Only if it reports an error, fix the file and validate again.
3. End your reply by stating the path of the workflow file you created. Do not make further changes.`

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
      backend: 'pi-sdk',
      skills: ['skelm'],
      system: SYSTEM,
      prompt: (ctx) => {
        const input = ctx.input as z.infer<typeof Input>
        const resumed = ctx.steps['ask-spec'] as { spec?: string } | undefined
        const spec = input.spec ?? resumed?.spec ?? ''
        const outDir = input.outDir ?? '.'
        return `Build a skelm workflow for this spec:\n\n${spec}\n\nWrite the file into ${outDir}/ and validate it before finishing.`
      },
      // Self-contained least-privilege grants (no config profile dependency, so
      // the workflow is portable): read the project, write generated files, run
      // skelm/node, load the skelm skill. networkEgress must be 'allow' for the
      // in-process pi-sdk backend — it can't route agent traffic through the
      // gateway egress proxy, so skelm fails closed on any narrower policy.
      permissions: {
        fsRead: ['./'],
        fsWrite: ['./'],
        allowedExecutables: ['skelm', 'node'],
        allowedSkills: ['skelm'],
        networkEgress: 'allow',
      },
      maxTurns: 12,
      timeoutMs: 600_000,
    }),
  ],
  finalize: (ctx) => summarize(ctx.steps.build),
})
