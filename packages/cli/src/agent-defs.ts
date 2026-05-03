import { existsSync, readFileSync } from 'node:fs'
import { join, resolve } from 'node:path'
import type { Pipeline, Step } from '@skelm/core'
import { CliError } from './load-workflow.js'

export function applyAgentDefinitions<TInput, TOutput>(
  pipeline: Pipeline<TInput, TOutput>,
  workflowDir: string,
): Pipeline<TInput, TOutput> {
  return patchPipeline(pipeline, workflowDir)
}

function patchPipeline<TInput, TOutput>(
  pipeline: Pipeline<TInput, TOutput>,
  workflowDir: string,
): Pipeline<TInput, TOutput> {
  return {
    ...pipeline,
    steps: pipeline.steps.map((step) => patchStep(step, workflowDir)),
  }
}

function patchStep(step: Step, workflowDir: string): Step {
  switch (step.kind) {
    case 'agent': {
      if (step.agentDef === undefined) return step
      const prompt = loadAgentDefinition(step.agentDef, workflowDir)
      const originalSystem = step.system
      if (typeof originalSystem === 'function') {
        return {
          ...step,
          system: (ctx) => mergeSystemPrompt(prompt, originalSystem(ctx)),
        }
      }
      return {
        ...step,
        system: mergeSystemPrompt(prompt, originalSystem),
      }
    }
    case 'idempotent':
      return { ...step, step: patchStep(step.step, workflowDir) }
    case 'parallel':
      return {
        ...step,
        steps: step.steps.map((child) => patchStep(child, workflowDir)),
      }
    case 'forEach':
      return {
        ...step,
        step: (item, index) => patchStep(step.step(item, index), workflowDir),
      }
    case 'branch': {
      const cases = Object.fromEntries(
        Object.entries(step.cases).map(([key, child]) => [key, patchStep(child, workflowDir)]),
      )
      return {
        ...step,
        cases,
        ...(step.default !== undefined && { default: patchStep(step.default, workflowDir) }),
      }
    }
    case 'loop':
      return { ...step, step: patchStep(step.step, workflowDir) }
    case 'pipelineStep':
      return { ...step, pipeline: patchPipeline(step.pipeline, workflowDir) }
    default:
      return step
  }
}

function loadAgentDefinition(agentDef: string, workflowDir: string): string {
  const agentDir = resolve(workflowDir, agentDef)
  const agentsPath = join(agentDir, 'AGENTS.md')
  if (!existsSync(agentsPath)) {
    throw new CliError(`agentDef is missing AGENTS.md: ${agentsPath}`, 'workflow-invalid')
  }

  const parts = [stripFrontmatter(readFileSync(agentsPath, 'utf8')).trim()]
  const soulPath = join(agentDir, 'SOUL.md')
  if (existsSync(soulPath)) {
    const soul = stripFrontmatter(readFileSync(soulPath, 'utf8')).trim()
    if (soul.length > 0) parts.push(soul)
  }
  const prompt = parts.filter((part) => part.length > 0).join('\n\n---\n\n')
  if (prompt.length === 0) {
    throw new CliError(`agentDef prompt body is empty: ${agentsPath}`, 'workflow-invalid')
  }
  return prompt
}

function stripFrontmatter(markdown: string): string {
  if (!markdown.startsWith('---\n')) return markdown
  const end = markdown.indexOf('\n---\n', 4)
  if (end === -1) return markdown
  return markdown.slice(end + 5)
}

function mergeSystemPrompt(agentPrompt: string, system: string | undefined): string {
  return system === undefined ? agentPrompt : `${agentPrompt}\n\n---\n\n${system}`
}
