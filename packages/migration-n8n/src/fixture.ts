function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

/**
 * Extract a sample input payload from n8n execution data, if present.
 *
 * n8n exports sometimes embed `pinData` (pinned node outputs) or a top-level
 * `executionData` blob. We pull the first available item's `json` payload as a
 * representative sample. Returns `undefined` when no usable sample exists —
 * fixture generation is best-effort and never fails the import.
 */
export function extractSampleInput(raw: unknown): unknown | undefined {
  if (!isObject(raw)) return undefined
  const pinData = raw.pinData
  if (isObject(pinData)) {
    for (const items of Object.values(pinData)) {
      if (Array.isArray(items) && items.length > 0) {
        const first = items[0]
        if (isObject(first) && 'json' in first) return first.json
        return first
      }
    }
  }
  return undefined
}

/**
 * Generate a test-fixture stub from sample n8n execution data.
 *
 * Produces a small `*.fixture.json`-style module the author can wire into a
 * skelm test. Returns `undefined` when the export carried no sample data.
 */
export function generateFixture(pipelineId: string, raw: unknown): string | undefined {
  const sample = extractSampleInput(raw)
  if (sample === undefined) return undefined
  const body = JSON.stringify({ pipelineId, input: sample, expected: null }, null, 2)
  return `${body}\n`
}
