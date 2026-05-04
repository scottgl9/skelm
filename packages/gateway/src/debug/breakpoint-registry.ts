/**
 * Run-level breakpoint registry the gateway uses to pause runs at specific
 * step ids for inspection. The dispatcher wires runner.beforeStep to consult
 * this registry: if a step's id matches a registered breakpoint, the
 * runtime awaits release before executing the step body.
 *
 * Operators interact with this through the /debug HTTP routes, by step id.
 * The registry intentionally tracks only step ids — broader matchers
 * (regex, kind, permissions) can come later but the v1 surface is
 * deliberately the smallest thing that lets you say "stop right before
 * the agent step that calls X".
 */
export interface PausedRun {
  runId: string
  stepId: string
  kind: string
  at: number
}

export class BreakpointRegistry {
  private readonly breakpoints: Set<string> = new Set()
  private readonly paused: Map<string, { entry: PausedRun; release: () => void }> = new Map()

  add(stepId: string): void {
    this.breakpoints.add(stepId)
  }

  remove(stepId: string): boolean {
    return this.breakpoints.delete(stepId)
  }

  list(): readonly string[] {
    return Array.from(this.breakpoints).sort()
  }

  has(stepId: string): boolean {
    return this.breakpoints.has(stepId)
  }

  /**
   * Suspend a run at a step until release(runId) is called. Returns a
   * Promise the runtime awaits. Multiple paused steps for the same runId
   * are collapsed onto the same key — release() resumes the latest pause.
   */
  pause(info: { runId: string; stepId: string; kind: string }): Promise<void> {
    return new Promise<void>((resolve) => {
      const entry: PausedRun = {
        runId: info.runId,
        stepId: info.stepId,
        kind: info.kind,
        at: Date.now(),
      }
      this.paused.set(info.runId, { entry, release: resolve })
    })
  }

  release(runId: string): boolean {
    const item = this.paused.get(runId)
    if (item === undefined) return false
    this.paused.delete(runId)
    item.release()
    return true
  }

  listPaused(): readonly PausedRun[] {
    return Array.from(this.paused.values())
      .map((p) => p.entry)
      .sort((a, b) => a.at - b.at)
  }
}
