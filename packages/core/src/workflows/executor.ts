/**
 * Workflow executor for processing trigger invocations
 * 
 * Simple executor that routes workflow invocations to registered workflows
 */

import { WorkflowRegistry } from './registry.js'
import type { WorkflowInvocation, WorkflowExecutionResult } from './types.js'

/**
 * Simple workflow executor
 * 
 * Routes workflow invocations to the appropriate workflow plugin
 */
export class WorkflowExecutor {
  constructor(private readonly registry: WorkflowRegistry) {}
  
  /**
   * Execute a workflow invocation
   */
  async execute(invocation: WorkflowInvocation): Promise<WorkflowExecutionResult> {
    const workflow = this.registry.get(invocation.workflowId)
    
    if (!workflow) {
      return {
        executionId: `exec-${Date.now()}-${Math.random().toString(36).substring(7)}`,
        workflowId: invocation.workflowId,
        success: false,
        error: `Workflow not found: ${invocation.workflowId}`,
        startedAt: new Date(),
        completedAt: new Date(),
      }
    }
    
    if (!workflow.isActive) {
      return {
        executionId: `exec-${Date.now()}-${Math.random().toString(36).substring(7)}`,
        workflowId: invocation.workflowId,
        success: false,
        error: `Workflow is not active: ${invocation.workflowId}`,
        startedAt: new Date(),
        completedAt: new Date(),
      }
    }
    
    const executionId = `exec-${Date.now()}-${Math.random().toString(36).substring(7)}`
    const startedAt = new Date()
    
    try {
      const result = await workflow.execute(invocation)
      
      return {
        ...result,
        executionId,
        startedAt,
        completedAt: new Date(),
      }
    } catch (error) {
      return {
        executionId,
        workflowId: invocation.workflowId,
        success: false,
        error: error instanceof Error ? error.message : String(error),
        startedAt,
        completedAt: new Date(),
      }
    }
  }
  
  /**
   * Execute multiple workflow invocations in parallel
   */
  async executeAll(invocations: WorkflowInvocation[]): Promise<WorkflowExecutionResult[]> {
    const promises = invocations.map((invocation) => this.execute(invocation))
    return Promise.all(promises)
  }
}
