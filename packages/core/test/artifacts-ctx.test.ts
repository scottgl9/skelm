import { describe, expect, it } from 'vitest'
import { code, pipeline } from '../src/builders.js'
import { EventBus } from '../src/events.js'
import { MemoryRunStore } from '../src/run-store.js'
import { runPipeline } from '../src/runner.js'

describe('ctx.artifacts binding', () => {
  it('persists a binary artifact and emits a tool.result event scoped to the step', async () => {
    const store = new MemoryRunStore()
    const events = new EventBus()
    const seen: Array<{ type: string; tool?: string; stepId?: string; size?: number }> = []
    events.subscribe((e) => {
      if (e.type === 'tool.result') {
        seen.push({
          type: e.type,
          tool: e.tool,
          stepId: e.stepId,
          size: (e.result as { size: number }).size,
        })
      }
    })

    const wf = pipeline({
      id: 'snapshot',
      steps: [
        code({
          id: 'capture',
          run: async (ctx) => {
            const desc = await ctx.artifacts!.put({
              name: 'screen.png',
              mimeType: 'image/png',
              data: new Uint8Array([0x89, 0x50, 0x4e, 0x47]),
            })
            return { artifactId: desc.artifactId, size: desc.size }
          },
        }),
      ],
    })

    const run = await runPipeline(wf, undefined, { store, events })
    expect(run.status).toBe('completed')
    const out = run.steps?.[0]?.output as { artifactId: string; size: number } | undefined
    expect(out?.size).toBe(4)

    // The artifact actually landed in the store.
    const fetched = await store.getArtifact({
      runId: run.runId,
      artifactId: out!.artifactId,
    })
    expect(fetched).not.toBeNull()
    expect(fetched!.descriptor.stepId).toBe('capture')
    expect(Array.from(fetched!.data)).toEqual([0x89, 0x50, 0x4e, 0x47])

    // The audit/event trail recorded a tool.result for the put.
    expect(seen).toEqual([
      { type: 'tool.result', tool: 'artifacts.put', stepId: 'capture', size: 4 },
    ])
  })

  it('does not write the artifact bytes into the run event payload', async () => {
    // Adversarial: large binary blobs must not leak through the event log.
    const store = new MemoryRunStore()
    const events = new EventBus()
    const captured: unknown[] = []
    events.subscribe((e) => captured.push(e))

    const big = new Uint8Array(64 * 1024).fill(0x42)
    const wf = pipeline({
      id: 'big-snap',
      steps: [
        code({
          id: 'capture',
          run: async (ctx) => {
            await ctx.artifacts!.put({
              name: 'big.bin',
              mimeType: 'application/octet-stream',
              data: big,
            })
            return null
          },
        }),
      ],
    })
    const run = await runPipeline(wf, undefined, { store, events })
    expect(run.status).toBe('completed')

    // No event payload should carry the bytes themselves.
    const serialized = JSON.stringify(captured)
    // The pattern "BBBB..." would appear if base64-or-utf8 leaked through.
    expect(serialized.includes('B'.repeat(64))).toBe(false)
    expect(serialized.length).toBeLessThan(10_000)
  })
})
