import { describe, expect, it, vi } from 'vitest'
import { z } from 'zod'
import { IntegrationBase } from '../src/base.js'
import {
  INTEGRATION_PLUGIN_BRAND,
  createIntegrationPlugin,
  defineIntegration,
} from '../src/factory.js'
import type { IntegrationConfig } from '../src/types.js'

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makeConfig(overrides: Partial<IntegrationConfig> = {}): IntegrationConfig {
  return {
    id: 'test',
    name: 'Test',
    enabled: true,
    credentials: { apiKey: 'key-abc', workspaceId: 'ws-123' },
    ...overrides,
  }
}

const testSchema = z.object({
  apiKey: z.string().min(1),
  workspaceId: z.string().min(1),
})

const TestIntegration = defineIntegration({
  id: 'test',
  name: 'Test',
  capabilities: {
    canTrigger: true,
    canReceiveWebhooks: false,
    canPoll: true,
    canSendNotifications: true,
  },
  credentialsSchema: testSchema,
  async performHealthCheck() {
    return true
  },
  async eventToRunInput(event, creds) {
    const e = event as { type?: string }
    if (e.type !== 'ping') return null
    return { trigger: { type: 'test-ping', workspaceId: creds.workspaceId } }
  },
  async sendNotification(message, _opts, creds) {
    // In real life: call an API. Here just validate creds are available.
    if (!creds.apiKey) throw new Error('no apiKey')
    void message
  },
})

// ---------------------------------------------------------------------------
// defineIntegration
// ---------------------------------------------------------------------------

describe('defineIntegration', () => {
  it('returns a class that extends IntegrationBase', () => {
    const inst = new TestIntegration(makeConfig())
    expect(inst).toBeInstanceOf(IntegrationBase)
  })

  it('sets id, name, and capabilities from options', () => {
    const inst = new TestIntegration(makeConfig())
    expect(inst.id).toBe('test')
    expect(inst.name).toBe('Test')
    expect(inst.capabilities.canTrigger).toBe(true)
    expect(inst.capabilities.canReceiveWebhooks).toBe(false)
  })

  it('initializes successfully with valid credentials', async () => {
    const inst = new TestIntegration(makeConfig())
    await expect(inst.init()).resolves.toBeUndefined()
  })

  it('throws on invalid credentials (Zod validation)', async () => {
    const inst = new TestIntegration(makeConfig({ credentials: { apiKey: '' } }))
    await expect(inst.init()).rejects.toThrow(/Invalid credentials/)
  })

  it('throws on missing credential fields', async () => {
    const inst = new TestIntegration(makeConfig({ credentials: {} }))
    await expect(inst.init()).rejects.toThrow(/Invalid credentials/)
  })

  it('calls validateCredentials hook after Zod passes', async () => {
    const validateSpy = vi.fn().mockResolvedValue(undefined)
    const Cls = defineIntegration({
      id: 'spy',
      name: 'Spy',
      capabilities: {
        canTrigger: false,
        canReceiveWebhooks: false,
        canPoll: false,
        canSendNotifications: false,
      },
      credentialsSchema: testSchema,
      validateCredentials: validateSpy,
      async performHealthCheck() {
        return true
      },
    })
    const inst = new Cls(makeConfig())
    await inst.init()
    expect(validateSpy).toHaveBeenCalledOnce()
    const [creds] = validateSpy.mock.calls[0] as [typeof testSchema._type]
    expect(creds.apiKey).toBe('key-abc')
  })

  it('propagates errors from validateCredentials hook', async () => {
    const Cls = defineIntegration({
      id: 'failing',
      name: 'Failing',
      capabilities: {
        canTrigger: false,
        canReceiveWebhooks: false,
        canPoll: false,
        canSendNotifications: false,
      },
      credentialsSchema: testSchema,
      async validateCredentials() {
        throw new Error('token rejected by provider')
      },
      async performHealthCheck() {
        return true
      },
    })
    await expect(new Cls(makeConfig()).init()).rejects.toThrow('token rejected by provider')
  })

  it('skips init body when enabled=false', async () => {
    const inst = new TestIntegration(makeConfig({ enabled: false }))
    await expect(inst.init()).resolves.toBeUndefined()
    // healthCheck returns false because never initialized
    expect(await inst.healthCheck()).toBe(false)
  })

  it('healthCheck returns true after successful init', async () => {
    const inst = new TestIntegration(makeConfig())
    await inst.init()
    expect(await inst.healthCheck()).toBe(true)
  })

  it('healthCheck returns false before init', async () => {
    const inst = new TestIntegration(makeConfig())
    expect(await inst.healthCheck()).toBe(false)
  })

  it('eventToRunInput converts a matching event', async () => {
    const inst = new TestIntegration(makeConfig())
    await inst.init()
    const result = await inst.eventToRunInput({ type: 'ping' })
    expect(result).toMatchObject({ trigger: { type: 'test-ping', workspaceId: 'ws-123' } })
  })

  it('eventToRunInput returns null for unrecognized events', async () => {
    const inst = new TestIntegration(makeConfig())
    await inst.init()
    const result = await inst.eventToRunInput({ type: 'unknown' })
    expect(result).toBeNull()
  })

  it('sendNotification resolves when implemented', async () => {
    const inst = new TestIntegration(makeConfig())
    await inst.init()
    await expect(inst.sendNotification('hello')).resolves.toBeUndefined()
  })

  it('sendNotification throws when not implemented', async () => {
    const Cls = defineIntegration({
      id: 'nosend',
      name: 'NoSend',
      capabilities: {
        canTrigger: false,
        canReceiveWebhooks: false,
        canPoll: false,
        canSendNotifications: false,
      },
      credentialsSchema: testSchema,
      async performHealthCheck() {
        return true
      },
    })
    const inst = new Cls(makeConfig())
    await inst.init()
    await expect(inst.sendNotification('hello')).rejects.toThrow('does not support sendNotification')
  })

  it('calls setupWebhook and cleanupWebhook when configured', async () => {
    const setupSpy = vi.fn().mockResolvedValue(undefined)
    const cleanupSpy = vi.fn().mockResolvedValue(undefined)
    const Cls = defineIntegration({
      id: 'webhooktest',
      name: 'WebhookTest',
      capabilities: {
        canTrigger: true,
        canReceiveWebhooks: true,
        canPoll: false,
        canSendNotifications: false,
      },
      credentialsSchema: testSchema,
      async performHealthCheck() {
        return true
      },
      setupWebhook: setupSpy,
      cleanupWebhook: cleanupSpy,
    })
    const config = makeConfig({
      webhook: { path: '/webhooks/test', events: ['push'] },
    })
    const inst = new Cls(config)
    await inst.init()
    expect(setupSpy).toHaveBeenCalledOnce()
    await inst.shutdown()
    expect(cleanupSpy).toHaveBeenCalledOnce()
  })

  it('healthCheck returns false before init (pre-init guard)', async () => {
    const inst = new TestIntegration(makeConfig())
    await expect(inst.healthCheck()).resolves.toBe(false)
  })
})

// ---------------------------------------------------------------------------
// createIntegrationPlugin
// ---------------------------------------------------------------------------

describe('createIntegrationPlugin', () => {
  it('wraps an integration as a WorkflowPlugin', () => {
    const inst = new TestIntegration(makeConfig())
    const plugin = createIntegrationPlugin(inst)
    expect(plugin.id).toBe('test')
    expect(plugin.name).toBe('Test')
    expect(plugin.type).toBe('workflow')
    expect(plugin[INTEGRATION_PLUGIN_BRAND]).toBe(true)
  })

  it('start() calls integration.init()', async () => {
    const inst = new TestIntegration(makeConfig())
    const initSpy = vi.spyOn(inst, 'init')
    const plugin = createIntegrationPlugin(inst)
    await plugin.initialize({})
    await plugin.start()
    expect(initSpy).toHaveBeenCalledOnce()
    expect(plugin.state).toBe('active')
  })

  it('stop() calls integration.shutdown()', async () => {
    const inst = new TestIntegration(makeConfig())
    const shutdownSpy = vi.spyOn(inst, 'shutdown')
    const plugin = createIntegrationPlugin(inst)
    await plugin.initialize({})
    await plugin.start()
    await plugin.stop()
    expect(shutdownSpy).toHaveBeenCalledOnce()
    expect(plugin.state).toBe('stopped')
  })

  it('healthCheck() delegates to integration', async () => {
    const inst = new TestIntegration(makeConfig())
    const plugin = createIntegrationPlugin(inst)
    await plugin.initialize({})
    await plugin.start()
    const status = await plugin.healthCheck()
    expect(status.healthy).toBe(true)
    expect(status.status).toBe('ok')
  })

  it('healthCheck() returns unhealthy when not initialized', async () => {
    const inst = new TestIntegration(makeConfig())
    const plugin = createIntegrationPlugin(inst)
    const status = await plugin.healthCheck()
    expect(status.healthy).toBe(false)
  })

  it('getService("integration") returns the underlying integration', async () => {
    const inst = new TestIntegration(makeConfig())
    const plugin = createIntegrationPlugin(inst)
    expect(plugin.getService('integration')).toBe(inst)
  })

  it('getService returns undefined for unknown services', () => {
    const inst = new TestIntegration(makeConfig())
    const plugin = createIntegrationPlugin(inst)
    expect(plugin.getService('unknown')).toBeUndefined()
  })

  it('getMetadata returns correct metadata shape', () => {
    const inst = new TestIntegration(makeConfig())
    const plugin = createIntegrationPlugin(inst)
    const meta = plugin.getMetadata()
    expect(meta.id).toBe('test')
    expect(meta.type).toBe('workflow')
    expect(meta.capabilities).toContain('canTrigger')
    expect(meta.capabilities).toContain('canPoll')
    expect(meta.capabilities).toContain('canSendNotifications')
    expect(meta.capabilities).not.toContain('canReceiveWebhooks')
  })

  it('on/off event handlers work', () => {
    const inst = new TestIntegration(makeConfig())
    const plugin = createIntegrationPlugin(inst)
    const handler = vi.fn()
    plugin.on('test', handler)
    plugin.off('test', handler)
    // No assertion needed — just confirming no throw
  })
})
