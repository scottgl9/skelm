import { describe, expect, it } from 'vitest'
import {
  MsGraphIntegration,
  getMsGraphValidationToken,
  verifyMsGraphClientState,
} from '../src/ms-graph.js'

describe('getMsGraphValidationToken', () => {
  it('returns the validationToken from the request URL', () => {
    expect(getMsGraphValidationToken('/hooks/graph?validationToken=plain-text-token')).toBe(
      'plain-text-token',
    )
  })

  it('returns the raw URL-encoded token value', () => {
    expect(getMsGraphValidationToken('/hooks/graph?validationToken=a%20b%2Bc')).toBe('a b+c')
  })

  it('returns null when the parameter is absent', () => {
    expect(getMsGraphValidationToken('/hooks/graph')).toBeNull()
  })

  it('returns null when the parameter is empty', () => {
    expect(getMsGraphValidationToken('/hooks/graph?validationToken=')).toBeNull()
  })
})

describe('verifyMsGraphClientState', () => {
  it('accepts a notification whose clientState matches', () => {
    expect(verifyMsGraphClientState({ clientState: 'shared-secret' }, 'shared-secret')).toBe(true)
  })

  it('rejects a notification whose clientState differs', () => {
    expect(verifyMsGraphClientState({ clientState: 'attacker' }, 'shared-secret')).toBe(false)
  })

  it('rejects notifications missing clientState', () => {
    expect(verifyMsGraphClientState({}, 'shared-secret')).toBe(false)
    expect(verifyMsGraphClientState(null, 'shared-secret')).toBe(false)
  })
})

describe('MsGraphIntegration.eventToRunInput', () => {
  it('passes notifications through when every clientState matches', async () => {
    const instance = new MsGraphIntegration({
      id: 'ms-graph',
      name: 'graph',
      enabled: true,
      credentials: {
        tenantId: 't',
        clientId: 'c',
        clientState: 'secret',
      },
    })
    await instance.init()
    const result = await (
      instance.eventToRunInput as (e: unknown) => Promise<{ notifications: unknown[] } | null>
    )({
      value: [
        { clientState: 'secret', changeType: 'created', resource: 'me/events' },
        { clientState: 'secret', changeType: 'updated', resource: 'me/events/abc' },
      ],
    })
    expect(result).not.toBeNull()
    expect(result?.notifications).toHaveLength(2)
  })

  it('drops notifications whose clientState does not match and returns null when none remain', async () => {
    const instance = new MsGraphIntegration({
      id: 'ms-graph',
      name: 'graph',
      enabled: true,
      credentials: { tenantId: 't', clientId: 'c', clientState: 'secret' },
    })
    await instance.init()
    const result = await (instance.eventToRunInput as (e: unknown) => Promise<unknown>)({
      value: [{ clientState: 'spoofed' }],
    })
    expect(result).toBeNull()
  })
})
