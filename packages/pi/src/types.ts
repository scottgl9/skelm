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
  /**
   * Replace pi's coding-agent system prompt with a custom base.
   * When omitted, pi's default prompt is kept and req.system / skills are
   * appended after it.
   */
  systemPrompt?: string
  /**
   * Disable pi's extension loading from .pi/extensions/.
   * Default: true — extensions can expand the tool surface in ways skelm
   * cannot audit; disabled by default for predictable sandboxing.
   */
  noExtensions?: boolean
  /**
   * Disable pi's built-in skill loading from .pi/skills/.
   * Default: true — skelm injects skills itself; loading pi's own skills
   * would cause duplicates.
   */
  noSkills?: boolean
  /**
   * Disable pi's cwd context file discovery (AGENTS.md, .pi/context/).
   * Default: false — project context files are useful and safe.
   */
  noContextFiles?: boolean
  /**
   * Advertise `capabilities.vision`. Defaults to `true`: image parts in the
   * prompt are forwarded to pi via `session.prompt(text, { images })`. Whether
   * the configured pi model actually accepts images depends on its
   * `~/.pi/agent/models.json` entry (the model's `input` field). Set
   * `vision: false` to flip on the framework's vision gate for deployments
   * pinned to a text-only pi model.
   */
  vision?: boolean
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
  /**
   * Optional egress proxy URL to inject into subprocess environment.
   * When provided along with an egress token from the gateway, the pi process
   * will route outbound connections through the proxy for network policy enforcement.
   */
  egressProxyUrl?: string
}
