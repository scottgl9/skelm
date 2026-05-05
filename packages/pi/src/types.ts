/**
 * Types for @skelm/pi - Pi coding agent backend
 */

export interface PiSdkBackendOptions {
  /** Backend id (default: 'pi-sdk') */
  id?: string
  /** Human-readable label */
  label?: string
  /** Working directory for pi's project-local discovery */
  cwd?: string
  /** Request timeout in ms (default: 300_000 = 5 min) */
  timeout?: number
  /**
   * Maximum simultaneous pi sessions. Defaults to 4. Set to 0 for unlimited.
   * Excess calls are queued until a slot opens.
   */
  maxConcurrent?: number
}

export interface PiBackendOptions {
  /** Backend id (default: 'pi') */
  id?: string
  /** Human-readable label */
  label?: string
  /** Path to the pi binary (default: 'pi' on PATH) */
  command?: string
  /** Provider name (e.g. 'llamacpp', 'anthropic'). Omit to use pi's default. */
  provider?: string
  /** Model ID (e.g. 'qwen36'). Omit to use pi's default. */
  model?: string
  /** Working directory for the pi process */
  cwd?: string
  /** Request timeout in ms (default: 300_000 = 5 min) */
  timeout?: number
  /**
   * Maximum simultaneous pi processes. Defaults to 4. Set to 0 for unlimited.
   * Excess calls are queued until a slot opens.
   */
  maxConcurrent?: number
}
