import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { CronTrigger, createCronTrigger } from '../../src/triggers/cron.js'
import type { TriggerEvent } from '../../src/triggers/types.js'
import { WorkflowPluginBase } from '../../src/workflows/base.js'
import { WorkflowExecutor } from '../../src/workflows/executor.js'
import { WorkflowRegistry } from '../../src/workflows/registry.js'
import type { WorkflowConfig, WorkflowExecutionResult, WorkflowHealthStatus, WorkflowInvocation } from '../../src/workflows/types.js'

class TestWorkflow extends WorkflowPluginBase {
  private executeHandler: (invocation: WorkflowInvocation) => Promise<WorkflowExecutionResult>
  
  constructor(
    id: string,
    name: string,
    executeHandler?: (invocation: WorkflowInvocation) => Promise<WorkflowExecutionResult>
  ) {
    super(id, name, '1.0.0')
    this.executeHandler = executeHandler || (() => Promise.resolve({
      executionId: 'exec-1',
      workflowId: id,
      success: true,
      data: { processed: true },
      startedAt: new Date(),
      completedAt: new Date(),
    }))
  }
  
  override getPluginType(): 'workflow' {
    return 'workflow'
  }
  
  override execute(invocation: WorkflowInvocation): Promise<WorkflowExecutionResult> {
    return this.executeHandler(invocation)
  }
  
  override protected doInitialize(config: WorkflowConfig): Promise<void> {
    return Promise.resolve()
  }
  
  override protected doHealthCheck(): Promise<WorkflowHealthStatus> {
    return Promise.resolve({ healthy: true, status: 'healthy' })
  }
}

describe('Trigger → Workflow Integration', () => {
  let workflowRegistry: WorkflowRegistry
  let workflowExecutor: WorkflowExecutor
  
  beforeEach(() => {
    workflowRegistry = new WorkflowRegistry()
    workflowExecutor = new WorkflowExecutor(workflowRegistry)
  })
  
  afterEach(async () => {
    await workflowRegistry.shutdown()
  })
  
  describe('CronTrigger invokes workflow', () => {
    it('invokes workflow when trigger fires', async () => {
      // Set up workflow
      let capturedInvocation: WorkflowInvocation | null = null
      const workflow = new TestWorkflow('test-workflow', 'Test Workflow', async (invocation) => {
        capturedInvocation = invocation
        return {
          executionId: 'exec-1',
          workflowId: 'test-workflow',
          success: true,
          data: { result: 'success' },
          startedAt: new Date(),
          completedAt: new Date(),
        }
      })
      await workflow.initialize({ id: 'test-workflow' })
      await workflow.start()
      workflowRegistry.register(workflow)
      
      // Set up trigger with workflow executor
      const trigger = createCronTrigger('cron-workflow-test', 'Cron Workflow Test')
      trigger.setWorkflowExecutor(workflowExecutor)
      await trigger.initialize({
        id: 'cron-workflow-test',
        schedule: '0 * * * *',
        workflowId: 'test-workflow',
      })
      
      // Manually emit an event to test workflow invocation
      const mockEvent: TriggerEvent = {
        eventId: 'event-1',
        triggerId: 'cron-workflow-test',
        triggerType: 'cron',
        timestamp: new Date(),
        payload: { scheduled: true },
        metadata: { source: 'cron' },
      }
      
      // Call emitEvent via a test hook
      await (trigger as unknown as { emitEvent: (e: TriggerEvent) => Promise<void> }).emitEvent(mockEvent)
      
      // Verify workflow was invoked
      expect(capturedInvocation).not.toBeNull()
      expect(capturedInvocation?.workflowId).toBe('test-workflow')
      expect(capturedInvocation?.triggerEvent.eventId).toBe('event-1')
    })
    
    it('passes input to workflow', async () => {
      let capturedInput: unknown = null
      const workflow = new TestWorkflow('input-workflow', 'Input Workflow', async (invocation) => {
        capturedInput = invocation.input
        return {
          executionId: 'exec-1',
          workflowId: 'input-workflow',
          success: true,
          data: {},
          startedAt: new Date(),
          completedAt: new Date(),
        }
      })
      await workflow.initialize({ id: 'input-workflow' })
      await workflow.start()
      workflowRegistry.register(workflow)
      
      const trigger = createCronTrigger('cron-input-test', 'Cron Input Test')
      trigger.setWorkflowExecutor(workflowExecutor)
      await trigger.initialize({
        id: 'cron-input-test',
        schedule: '0 * * * *',
        workflowId: 'input-workflow',
        input: { custom: 'data' },
      })
      
      const mockEvent: TriggerEvent = {
        eventId: 'event-1',
        triggerId: 'cron-input-test',
        triggerType: 'cron',
        timestamp: new Date(),
        payload: {},
        metadata: { source: 'cron' },
      }
      
      await (trigger as unknown as { emitEvent: (e: TriggerEvent) => Promise<void> }).emitEvent(mockEvent)
      
      expect(capturedInput).toEqual({ custom: 'data' })
    })
    
    it('passes context from event metadata to workflow', async () => {
      let capturedContext: Record<string, unknown> | undefined
      const workflow = new TestWorkflow('context-workflow', 'Context Workflow', async (invocation) => {
        capturedContext = invocation.context
        return {
          executionId: 'exec-1',
          workflowId: 'context-workflow',
          success: true,
          data: {},
          startedAt: new Date(),
          completedAt: new Date(),
        }
      })
      await workflow.initialize({ id: 'context-workflow' })
      await workflow.start()
      workflowRegistry.register(workflow)
      
      const trigger = createCronTrigger('cron-context-test', 'Cron Context Test')
      trigger.setWorkflowExecutor(workflowExecutor)
      await trigger.initialize({
        id: 'cron-context-test',
        schedule: '0 * * * *',
        workflowId: 'context-workflow',
      })
      
      const mockEvent: TriggerEvent = {
        eventId: 'event-1',
        triggerId: 'cron-context-test',
        triggerType: 'cron',
        timestamp: new Date(),
        payload: {},
        metadata: { 
          source: 'cron',
          userId: 'user-123',
          channelId: 'channel-456',
        },
      }
      
      await (trigger as unknown as { emitEvent: (e: TriggerEvent) => Promise<void> }).emitEvent(mockEvent)
      
      expect(capturedContext).toEqual({ userId: 'user-123', channelId: 'channel-456' })
    })
    
    it('handles workflow execution errors gracefully', async () => {
      const workflow = new TestWorkflow('error-workflow', 'Error Workflow', async () => {
        throw new Error('Workflow execution failed')
      })
      await workflow.initialize({ id: 'error-workflow' })
      await workflow.start()
      workflowRegistry.register(workflow)
      
      const trigger = createCronTrigger('cron-error-test', 'Cron Error Test')
      trigger.setWorkflowExecutor(workflowExecutor)
      await trigger.initialize({
        id: 'cron-error-test',
        schedule: '0 * * * *',
        workflowId: 'error-workflow',
      })
      
      const mockEvent: TriggerEvent = {
        eventId: 'event-1',
        triggerId: 'cron-error-test',
        triggerType: 'cron',
        timestamp: new Date(),
        payload: {},
        metadata: { source: 'cron' },
      }
      
      // Should not throw even if workflow fails
      await expect(
        (trigger as unknown as { emitEvent: (e: TriggerEvent) => Promise<void> }).emitEvent(mockEvent)
      ).resolves.not.toThrow()
    })
  })
})
