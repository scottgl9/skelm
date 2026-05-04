import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { WorkflowPluginBase, WorkflowState } from '../../src/workflows/base.js'
import { WorkflowExecutor } from '../../src/workflows/executor.js'
import { WorkflowRegistry } from '../../src/workflows/registry.js'
import type { WorkflowConfig, WorkflowExecutionResult, WorkflowHealthStatus, WorkflowInvocation } from '../../src/workflows/types.js'

class TestWorkflowPlugin extends WorkflowPluginBase {
  private mockExecute: (invocation: WorkflowInvocation) => Promise<WorkflowExecutionResult>
  
  constructor(
    id: string,
    name: string,
    version = '1.0.0',
    execute?: (invocation: WorkflowInvocation) => Promise<WorkflowExecutionResult>
  ) {
    super(id, name, version)
    this.mockExecute = execute || (() => Promise.resolve({
      executionId: 'mock-execution',
      workflowId: id,
      success: true,
      data: { result: 'success' },
      startedAt: new Date(),
      completedAt: new Date(),
    }))
  }
  
  override getPluginType(): 'workflow' {
    return 'workflow'
  }
  
  override execute(invocation: WorkflowInvocation): Promise<WorkflowExecutionResult> {
    return this.mockExecute(invocation)
  }
  
  override protected doInitialize(config: WorkflowConfig): Promise<void> {
    return Promise.resolve()
  }
  
  override protected doHealthCheck(): Promise<WorkflowHealthStatus> {
    return Promise.resolve({ healthy: true, status: 'healthy' })
  }
}

describe('WorkflowExecutor', () => {
  let registry: WorkflowRegistry
  let executor: WorkflowExecutor
  
  beforeEach(() => {
    registry = new WorkflowRegistry()
    executor = new WorkflowExecutor(registry)
  })
  
  afterEach(async () => {
    await registry.shutdown()
  })
  
  describe('execute', () => {
    it('executes a workflow invocation', async () => {
      const workflow = new TestWorkflowPlugin('test-workflow', 'Test Workflow')
      await workflow.initialize({ id: 'test-workflow' })
      await workflow.start()
      
      registry.register(workflow)
      
      const invocation: WorkflowInvocation = {
        workflowId: 'test-workflow',
        triggerEvent: {
          eventId: 'event-1',
          triggerId: 'trigger-1',
          triggerType: 'cron',
          timestamp: new Date(),
          payload: { test: 'data' },
          metadata: { source: 'test' },
        },
      }
      
      const result = await executor.execute(invocation)
      
      expect(result.success).toBe(true)
      expect(result.workflowId).toBe('test-workflow')
      expect(result.executionId).toMatch(/^exec-\d+-/)
    })
    
    it('returns error for non-existent workflow', async () => {
      const invocation: WorkflowInvocation = {
        workflowId: 'non-existent',
        triggerEvent: {
          eventId: 'event-1',
          triggerId: 'trigger-1',
          triggerType: 'cron',
          timestamp: new Date(),
          payload: {},
          metadata: { source: 'test' },
        },
      }
      
      const result = await executor.execute(invocation)
      
      expect(result.success).toBe(false)
      expect(result.error).toContain('Workflow not found')
    })
    
    it('returns error for inactive workflow', async () => {
      const workflow = new TestWorkflowPlugin('inactive-workflow', 'Inactive Workflow')
      await workflow.initialize({ id: 'inactive-workflow' })
      // Not started, so state is INITIALIZED
      
      registry.register(workflow)
      
      const invocation: WorkflowInvocation = {
        workflowId: 'inactive-workflow',
        triggerEvent: {
          eventId: 'event-1',
          triggerId: 'trigger-1',
          triggerType: 'cron',
          timestamp: new Date(),
          payload: {},
          metadata: { source: 'test' },
        },
      }
      
      const result = await executor.execute(invocation)
      
      expect(result.success).toBe(false)
      expect(result.error).toContain('not active')
    })
    
    it('includes input in invocation', async () => {
      let capturedInput: unknown
      const workflow = new TestWorkflowPlugin('input-workflow', 'Input Workflow', '1.0.0', async (invocation) => {
        capturedInput = invocation.input
        return {
          executionId: 'exec-1',
          workflowId: 'input-workflow',
          success: true,
          data: { received: true },
          startedAt: new Date(),
          completedAt: new Date(),
        }
      })
      await workflow.initialize({ id: 'input-workflow' })
      await workflow.start()
      
      registry.register(workflow)
      
      const invocation: WorkflowInvocation = {
        workflowId: 'input-workflow',
        triggerEvent: {
          eventId: 'event-1',
          triggerId: 'trigger-1',
          triggerType: 'webhook',
          timestamp: new Date(),
          payload: {},
          metadata: { source: 'test' },
        },
        input: { custom: 'data' },
      }
      
      await executor.execute(invocation)
      
      expect(capturedInput).toEqual({ custom: 'data' })
    })
    
    it('includes context in invocation', async () => {
      let capturedContext: unknown
      const workflow = new TestWorkflowPlugin('context-workflow', 'Context Workflow', '1.0.0', async (invocation) => {
        capturedContext = invocation.context
        return {
          executionId: 'exec-1',
          workflowId: 'context-workflow',
          success: true,
          data: { received: true },
          startedAt: new Date(),
          completedAt: new Date(),
        }
      })
      await workflow.initialize({ id: 'context-workflow' })
      await workflow.start()
      
      registry.register(workflow)
      
      const invocation: WorkflowInvocation = {
        workflowId: 'context-workflow',
        triggerEvent: {
          eventId: 'event-1',
          triggerId: 'trigger-1',
          triggerType: 'slack',
          timestamp: new Date(),
          payload: {},
          metadata: { source: 'test' },
        },
        context: { userId: 'user-123', channelId: 'channel-456' },
      }
      
      await executor.execute(invocation)
      
      expect(capturedContext).toEqual({ userId: 'user-123', channelId: 'channel-456' })
    })
    
    it('handles execution errors gracefully', async () => {
      const workflow = new TestWorkflowPlugin('error-workflow', 'Error Workflow', '1.0.0', async () => {
        throw new Error('Execution failed')
      })
      await workflow.initialize({ id: 'error-workflow' })
      await workflow.start()
      
      registry.register(workflow)
      
      const invocation: WorkflowInvocation = {
        workflowId: 'error-workflow',
        triggerEvent: {
          eventId: 'event-1',
          triggerId: 'trigger-1',
          triggerType: 'cron',
          timestamp: new Date(),
          payload: {},
          metadata: { source: 'test' },
        },
      }
      
      const result = await executor.execute(invocation)
      
      expect(result.success).toBe(false)
      expect(result.error).toBe('Execution failed')
    })
  })
  
  describe('executeAll', () => {
    it('executes multiple invocations in parallel', async () => {
      const workflow1 = new TestWorkflowPlugin('wf-1', 'Workflow 1')
      const workflow2 = new TestWorkflowPlugin('wf-2', 'Workflow 2')
      
      await workflow1.initialize({ id: 'wf-1' })
      await workflow1.start()
      await workflow2.initialize({ id: 'wf-2' })
      await workflow2.start()
      
      registry.register(workflow1)
      registry.register(workflow2)
      
      const invocations: WorkflowInvocation[] = [
        {
          workflowId: 'wf-1',
          triggerEvent: {
            eventId: 'event-1',
            triggerId: 'trigger-1',
            triggerType: 'cron',
            timestamp: new Date(),
            payload: {},
            metadata: { source: 'test' },
          },
        },
        {
          workflowId: 'wf-2',
          triggerEvent: {
            eventId: 'event-2',
            triggerId: 'trigger-2',
            triggerType: 'webhook',
            timestamp: new Date(),
            payload: {},
            metadata: { source: 'test' },
          },
        },
      ]
      
      const results = await executor.executeAll(invocations)
      
      expect(results.length).toBe(2)
      expect(results[0].success).toBe(true)
      expect(results[1].success).toBe(true)
    })
    
    it('handles mixed success/failure', async () => {
      const successWorkflow = new TestWorkflowPlugin('success-wf', 'Success Workflow')
      const errorWorkflow = new TestWorkflowPlugin('error-wf', 'Error Workflow', '1.0.0', async () => {
        throw new Error('Failed')
      })
      
      await successWorkflow.initialize({ id: 'success-wf' })
      await successWorkflow.start()
      await errorWorkflow.initialize({ id: 'error-wf' })
      await errorWorkflow.start()
      
      registry.register(successWorkflow)
      registry.register(errorWorkflow)
      
      const invocations: WorkflowInvocation[] = [
        {
          workflowId: 'success-wf',
          triggerEvent: {
            eventId: 'event-1',
            triggerId: 'trigger-1',
            triggerType: 'cron',
            timestamp: new Date(),
            payload: {},
            metadata: { source: 'test' },
          },
        },
        {
          workflowId: 'error-wf',
          triggerEvent: {
            eventId: 'event-2',
            triggerId: 'trigger-2',
            triggerType: 'cron',
            timestamp: new Date(),
            payload: {},
            metadata: { source: 'test' },
          },
        },
      ]
      
      const results = await executor.executeAll(invocations)
      
      expect(results.length).toBe(2)
      expect(results[0].success).toBe(true)
      expect(results[1].success).toBe(false)
    })
  })
})
