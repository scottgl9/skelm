import { VercelAiBackendError } from './errors.js'

/**
 * Extract a JSON value from the model's text output. Tolerates ```json
 * fenced blocks and surrounding prose. The runner re-validates against the
 * step's output schema, so we only need to parse here.
 */
export function parseStructured(text: string): unknown {
  const candidate = extractJson(text)
  if (candidate === null) {
    throw new VercelAiBackendError(
      `vercel-ai inference returned no parseable JSON. Output (first 200 chars): ${text.slice(0, 200)}`,
    )
  }
  try {
    return JSON.parse(candidate)
  } catch (err) {
    throw new VercelAiBackendError(
      `vercel-ai inference output is not valid JSON: ${(err as Error).message}. Raw: ${text.slice(0, 200)}`,
      err,
    )
  }
}

export function extractJson(text: string): string | null {
  const fenced = text.match(/```(?:json)?\s*([\s\S]*?)```/)
  if (fenced?.[1]) return fenced[1].trim()
  const start = text.search(/[{[]/)
  if (start === -1) return null
  const opener = text[start]
  const closer = opener === '{' ? '}' : ']'
  const end = text.lastIndexOf(closer)
  if (end <= start) return null
  return text.slice(start, end + 1)
}
