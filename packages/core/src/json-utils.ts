/**
 * Try to parse a string as JSON. Returns the parsed value on success, or the
 * original string when parsing fails. Used to extract structured output from
 * agent text responses when the backend doesn't natively support structured
 * output (i.e. `response.structured` is undefined).
 */
export function tryParseJson(text: string | undefined): unknown {
  if (text === undefined) return undefined
  const trimmed = text.trim()
  if (!trimmed.startsWith('{') && !trimmed.startsWith('[')) return text
  try {
    return JSON.parse(trimmed)
  } catch {
    return text
  }
}

/**
 * Extract JSON from agent text that may contain markdown, explanations, or
 * other non-JSON content. Looks for the first `{...}` or `[...]` block and
 * attempts to parse it. Returns the parsed value or the original text if
 * extraction fails.
 */
export function extractJsonFromText(text: string | undefined): unknown {
  if (text === undefined) return undefined
  const trimmed = text.trim()

  if (
    (trimmed.startsWith('{') && trimmed.endsWith('}')) ||
    (trimmed.startsWith('[') && trimmed.endsWith(']'))
  ) {
    try {
      return JSON.parse(trimmed)
    } catch {
      return text
    }
  }

  const objMatch = trimmed.match(/\{[\s\S]*\}/)
  const arrMatch = trimmed.match(/\[[\s\S]*\]/)

  if (objMatch) {
    try {
      return JSON.parse(objMatch[0])
    } catch {
      // Fall through to try array
    }
  }

  if (arrMatch) {
    try {
      return JSON.parse(arrMatch[0])
    } catch {
      return text
    }
  }

  return text
}
