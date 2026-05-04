import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { WorkflowPluginBase, WorkflowState } from '../../src/workflows/base.js'
import { WorkflowRegistry } from '../../src/workflows/registry.js'
import type {
  WorkflowConfig,
  WorkflowExecutionResult,
  WorkflowHealthStatus,
  WorkflowInvocation,
} from '../../src/workflows/types.js'

class MockWorkflowPlugin extends WorkflowPluginBase {
  private mockExecute: (invocation: WorkflowInvocation) => Promise<WorkflowExecutionResult>
  private mockHealthCheck: () => Promise<WorkflowHealthStatus>

  constructor(
    id: string,
    name: string,
    version = '1.0.0',
    description?: string,
    execute?: (invocation: WorkflowInvocation) => Promise<WorkflowExecutionResult>,
    healthCheck?: () => Promise<WorkflowHealthStatus>,
  ) {
    super(id, name, version, description)
    this.mockExecute =
      execute ||
      (() =>
        Promise.resolve({
          executionId: 'mock-execution',
          workflowId: id,
          success: true,
          startedAt: new Date(),
          completedAt: new Date(),
        }))
    this.mockHealthCheck =
      healthCheck ||
      (() =>
        Promise.resolve({
          healthy: true,
          status: 'healthy',
        }))
  }

  override getPluginType(): 'workflow' {
    return 'workflow'
  }

  override execute(invocation: WorkflowInvocation): Promise<WorkflowExecutionResult> {
    return this.mockExecute(invocation)
  }

  protected override doInitialize(config: WorkflowConfig): Promise<void> {
    return Promise.resolve()
  }

  protected override doHealthCheck(): Promise<WorkflowHealthStatus> {
    return this.mockHealthCheck()
  }
}

describe('WorkflowRegistry', () => {
  let registry: WorkflowRegistry

  beforeEach(() => {
    registry = new WorkflowRegistry()
  })

  afterEach(async () => {
    await registry.shutdown()
  })

  describe('register/unregister', () => {
    it('registers a workflow plugin', () => {
      const mockWorkflow = new MockWorkflowPlugin('test-workflow', 'Test Workflow')

      registry.register(mockWorkflow)

      expect(registry.has('test-workflow')).toBe(true)
      expect(registry.get('test-workflow')).toBe(mockWorkflow)
    })

    it('throws on duplicate registration', () => {
      const mockWorkflow = new MockWorkflowPlugin('duplicate-workflow', 'Duplicate Workflow')

      registry.register(mockWorkflow)

      expect(() => registry.register(mockWorkflow)).toThrow(
        "Workflow with id 'duplicate-workflow' is already registered",
      )
    })

    it('unregisters a workflow plugin', async () => {
      const mockWorkflow = new MockWorkflowPlugin('unregister-workflow', 'Unregister Workflow')

      registry.register(mockWorkflow)
      expect(registry.has('unregister-workflow')).toBe(true)

      await registry.unregister('unregister-workflow')

      expect(registry.has('unregister-workflow')).toBe(false)
    })

    it('stops active workflow before unregistering', async () => {
      const mockWorkflow = new MockWorkflowPlugin(
        'stop-before-unregister',
        'Stop Before Unregister',
      )

      // Manually set state to ACTIVE by calling start
      await mockWorkflow.initialize({ id: 'stop-before-unregister' })
      await mockWorkflow.start()

      const stopSpy = vi.spyOn(mockWorkflow, 'stop')

      registry.register(mockWorkflow)
      await registry.unregister('stop-before-unregister')

      expect(stopSpy).toHaveBeenCalled()
    })
  })

  describe('list/get', () => {
    it('lists all registered workflows', () => {
      const workflow1 = new MockWorkflowPlugin('wf-1', 'Workflow 1')
      const workflow2 = new MockWorkflowPlugin('wf-2', 'Workflow 2')

      registry.register(workflow1)
      registry.register(workflow2)

      const list = registry.list()
      expect(list.length).toBe(2)
    })

    it('gets a workflow by ID', () => {
      const mockWorkflow = new MockWorkflowPlugin('get-workflow', 'Get Workflow')

      registry.register(mockWorkflow)

      const workflow = registry.get('get-workflow')
      expect(workflow).toBe(mockWorkflow)
    })

    it('returns undefined for non-existent workflow', () => {
      expect(registry.get('non-existent')).toBeUndefined()
    })

    it('lists only enabled workflows', () => {
      const workflow1 = new MockWorkflowPlugin('enabled-wf', 'Enabled Workflow')
      const workflow2 = new MockWorkflowPlugin('disabled-wf', 'Disabled Workflow')
      Object.defineProperty(workflow2, 'enabled', { value: false, writable: true })

      registry.register(workflow1)
      registry.register(workflow2)

      const enabled = registry.listEnabled()
      expect(enabled.length).toBe(1)
      expect(enabled[0].id).toBe('enabled-wf')
    })
  })

  describe('lifecycle', () => {
    it('initializes all registered workflows', async () => {
      const mockWorkflow = new MockWorkflowPlugin('init-workflow', 'Init Workflow')
      const initializeSpy = vi.spyOn(mockWorkflow, 'initialize')

      registry.register(mockWorkflow)
      await registry.initializeAll({ 'init-workflow': { id: 'init-workflow' } })

      expect(initializeSpy).toHaveBeenCalledWith({ id: 'init-workflow' })
    })

    it('starts all enabled workflows', async () => {
      const mockWorkflow = new MockWorkflowPlugin('start-workflow', 'Start Workflow')
      const startSpy = vi.spyOn(mockWorkflow, 'start')

      registry.register(mockWorkflow)
      await registry.startAll()

      expect(startSpy).toHaveBeenCalled()
    })

    it('stops all workflows', async () => {
      const mockWorkflow = new MockWorkflowPlugin('stop-workflow', 'Stop Workflow')
      const stopSpy = vi.spyOn(mockWorkflow, 'stop')

      registry.register(mockWorkflow)
      await registry.stopAll()

      expect(stopSpy).toHaveBeenCalled()
    })

    it('shuts down all workflows and clears registry', async () => {
      const mockWorkflow = new MockWorkflowPlugin('shutdown-workflow', 'Shutdown Workflow')
      const stopSpy = vi.spyOn(mockWorkflow, 'stop')

      registry.register(mockWorkflow)
      await registry.shutdown()

      expect(stopSpy).toHaveBeenCalled()
      expect(registry.list().length).toBe(0)
    })
  })

  describe('health check', () => {
    it('checks health of all workflows', async () => {
      const mockWorkflow = new MockWorkflowPlugin(
        'health-workflow',
        'Health Workflow',
        '1.0.0',
        undefined,
        undefined,
        () => Promise.resolve({ healthy: true, status: 'healthy' }),
      )

      registry.register(mockWorkflow)

      const health = await registry.checkAllHealth()

      expect(health['health-workflow']).toEqual({
        healthy: true,
        status: 'healthy',
        lastCheck: expect.any(Date),
      })
    })

    it('returns error status for unhealthy workflows', async () => {
      const mockWorkflow = new MockWorkflowPlugin(
        'unhealthy-workflow',
        'Unhealthy Workflow',
        '1.0.0',
        undefined,
        undefined,
        () => Promise.reject(new Error('Health check failed')),
      )

      registry.register(mockWorkflow)

      const health = await registry.checkAllHealth()

      expect(health['unhealthy-workflow'].healthy).toBe(false)
      expect(health['unhealthy-workflow'].error).toBe('Health check failed')
    })

    it('returns healthy workflows list', async () => {
      const healthyWorkflow = new MockWorkflowPlugin(
        'healthy',
        'Healthy',
        '1.0.0',
        undefined,
        undefined,
        () => Promise.resolve({ healthy: true, status: 'healthy' }),
      )
      const unhealthyWorkflow = new MockWorkflowPlugin(
        'unhealthy',
        'Unhealthy',
        '1.0.0',
        undefined,
        undefined,
        () => Promise.reject(new Error('Failed')),
      )

      registry.register(healthyWorkflow)
      registry.register(unhealthyWorkflow)

      const healthy = await registry.getHealthyWorkflows()

      expect(healthy.length).toBe(1)
      expect(healthy[0].id).toBe('healthy')
    })
  })
})
