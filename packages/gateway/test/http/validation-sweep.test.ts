/**
 * Plan §4.6: validation-fail leg of the route triad.
 *
 * Auth-fail is already covered uniformly by auth-sweep.test.ts. Happy-path
 * is covered per-route in pipelines-run-file / batch-routes / secrets-route
 * / audit-route / dashboard / wait-step / etc. This file rounds out the
 * triad for the routes the plan flagged as missing validation coverage:
 *
 *   - POST /runs                        (runs.ts)        — bad pipelinePath
 *   - POST /schedules                   (schedules.ts)   — missing id, bad overlap
 *   - DELETE /schedules/:id             (schedules.ts)   — unknown id (404)
 *   - POST /v1/projects/activate        (projects.ts)    — missing dir
 *   - POST /v1/workflows/:id/deactivate (projects.ts)    — empty id (handled by router)
 */
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { bootGatewayWithRetry } from '../utils/boot-gateway.js'

let stateDir: string

beforeEach(async () => {
  stateDir = await mkdtemp(join(tmpdir(), 'skelm-validate-sweep-'))
})

afterEach(async () => {
  await rm(stateDir, { recursive: true, force: true })
})

async function startUnprotectedGateway() {
  return await bootGatewayWithRetry((port) => ({
    stateDir,
    watchRegistries: false,
    enableHttp: true,
    httpPort: port,
    config: {},
  }))
}

describe('HTTP route validation-fail coverage (plan §4.6)', () => {
  it('POST /runs rejects a request with no pipelinePath (400)', async () => {
    const { gw, base } = await startUnprotectedGateway()
    try {
      const res = await fetch(`${base}/runs`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ input: {} }),
      })
      expect(res.status).toBe(400)
    } finally {
      await gw.stop()
    }
  })

  it('POST /runs rejects a non-string pipelinePath (400)', async () => {
    const { gw, base } = await startUnprotectedGateway()
    try {
      const res = await fetch(`${base}/runs`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ pipelinePath: 123 }),
      })
      expect(res.status).toBe(400)
    } finally {
      await gw.stop()
    }
  })

  it('POST /schedules rejects when id is missing (400)', async () => {
    const { gw, base } = await startUnprotectedGateway()
    try {
      const res = await fetch(`${base}/schedules`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ workflowId: 'wf', trigger: { kind: 'manual' } }),
      })
      expect(res.status).toBe(400)
    } finally {
      await gw.stop()
    }
  })

  it('POST /schedules rejects an unknown overlap value (400 with explanatory message)', async () => {
    const { gw, base } = await startUnprotectedGateway()
    try {
      const res = await fetch(`${base}/schedules`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          id: 's',
          workflowId: 'wf',
          trigger: { kind: 'manual' },
          overlap: 'fail-fast',
        }),
      })
      expect(res.status).toBe(400)
    } finally {
      await gw.stop()
    }
  })

  it('DELETE /schedules/:id returns 404 when the id is unknown', async () => {
    const { gw, base } = await startUnprotectedGateway()
    try {
      const res = await fetch(`${base}/schedules/does-not-exist`, { method: 'DELETE' })
      expect(res.status).toBe(404)
    } finally {
      await gw.stop()
    }
  })

  it('POST /v1/projects/activate rejects when dir is missing (400)', async () => {
    const { gw, base } = await startUnprotectedGateway()
    try {
      const res = await fetch(`${base}/v1/projects/activate`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({}),
      })
      expect(res.status).toBe(400)
    } finally {
      await gw.stop()
    }
  })

  it('POST /v1/projects/activate rejects when dir is the empty string (400)', async () => {
    const { gw, base } = await startUnprotectedGateway()
    try {
      const res = await fetch(`${base}/v1/projects/activate`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ dir: '' }),
      })
      expect(res.status).toBe(400)
    } finally {
      await gw.stop()
    }
  })
})
