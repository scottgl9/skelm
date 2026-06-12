/**
 * Browser-automation tool CONTRACT for the native agent.
 *
 * These tools define a typed surface (navigate, click, type, screenshot,
 * extract) that the agent can drive. The concrete implementation is NOT bundled
 * here — Playwright (or any driver) lands in a future `@skelm/browser-automation`
 * package that supplies a `BrowserProvider`. This file ships only the contract
 * plus the not-wired path.
 *
 * Placement is hybrid by orchestrator decision: the contract lives in
 * `@skelm/agent` so the tool surface and its permission posture are defined and
 * tested in one place; the heavy driver dependency is deferred to the browser
 * package.
 *
 * Permission posture (default-deny). The browser tools are only advertised when
 * a `BrowserProvider` is wired into the ToolExecutionContext — absent a
 * provider they are NOT advertised at all. When wired, every action additionally
 * requires:
 *   - network egress for the target host (gated through `enforcer.canFetch`),
 *     reusing the existing `network` dimension — no new core dimension is added;
 *   - an artifact sink for `browser_screenshot` (the screenshot is persisted as
 *     an artifact, never returned inline) — `browser_screenshot` refuses when no
 *     artifact handle is present.
 */

import type { BuiltInToolDef, ToolExecutionContext, ToolResult } from '../tools.js'

/** A single navigation/extraction result returned by a provider action. */
export interface BrowserActionResult {
  /** Free-form textual result (page title, extracted text, status, …). */
  text: string
  /** Current URL after the action, when the provider tracks it. */
  url?: string
}

/** Raw screenshot bytes a provider returns; the tool persists them as an artifact. */
export interface BrowserScreenshot {
  /** base64-encoded image bytes. */
  data: string
  contentType: string
}

/**
 * Concrete browser driver, supplied by `@skelm/browser-automation` (deferred).
 * Each method maps 1:1 to a browser tool. The provider performs the real
 * automation; the tool wrappers in this file own permission enforcement and
 * artifact persistence so a provider cannot bypass the trust boundary.
 */
export interface BrowserProvider {
  navigate(url: string): Promise<BrowserActionResult>
  click(selector: string): Promise<BrowserActionResult>
  type(input: { selector: string; text: string }): Promise<BrowserActionResult>
  screenshot(input?: { selector?: string }): Promise<BrowserScreenshot>
  extract(input: { selector?: string }): Promise<BrowserActionResult>
}

function hostOf(url: string): string | undefined {
  try {
    return new URL(url).hostname
  } catch {
    return undefined
  }
}

/**
 * Gate a browser action that reaches `url` through the network dimension. The
 * browser posture reuses `canFetch` rather than introducing a new core
 * permission dimension: a browser navigation is network egress.
 */
function enforceNavigation(ctx: ToolExecutionContext, url: string): ToolResult | undefined {
  const host = hostOf(url)
  if (host === undefined) return { content: `Error: invalid URL "${url}"`, isError: true }
  const decision = ctx.enforcer.canFetch(host)
  if (!decision.allow) {
    ctx.events?.publish({
      type: 'permission.denied' as const,
      ...(ctx.events.runId ? { runId: ctx.events.runId } : {}),
      ...(ctx.events.stepId ? { stepId: ctx.events.stepId } : {}),
      dimension: 'network' as const,
      detail: `browser_navigate denied: ${host} — ${decision.reason}`,
      at: Date.now(),
    })
    return { content: `Permission denied: ${decision.reason}`, isError: true }
  }
  return undefined
}

export const BROWSER_TOOLS: readonly BuiltInToolDef[] = [
  {
    name: 'browser_navigate',
    description: 'Navigate the browser to a URL. Requires network egress for the target host.',
    parameters: {
      type: 'object',
      properties: { url: { type: 'string', description: 'Absolute URL to navigate to.' } },
      required: ['url'],
    },
    handler: async (args, ctx): Promise<ToolResult> => {
      const p = args as { url?: string }
      if (!p.url) return { content: 'Error: url is required', isError: true }
      if (ctx.browser === undefined) {
        return { content: 'Error: no browser provider is wired for this run', isError: true }
      }
      const denied = enforceNavigation(ctx, p.url)
      if (denied) return denied
      const r = await ctx.browser.navigate(p.url)
      return { content: JSON.stringify(r) }
    },
  },
  {
    name: 'browser_click',
    description: 'Click an element matched by a CSS selector in the current page.',
    parameters: {
      type: 'object',
      properties: { selector: { type: 'string', description: 'CSS selector to click.' } },
      required: ['selector'],
    },
    handler: async (args, ctx): Promise<ToolResult> => {
      const p = args as { selector?: string }
      if (!p.selector) return { content: 'Error: selector is required', isError: true }
      if (ctx.browser === undefined) {
        return { content: 'Error: no browser provider is wired for this run', isError: true }
      }
      const r = await ctx.browser.click(p.selector)
      return { content: JSON.stringify(r) }
    },
  },
  {
    name: 'browser_type',
    description: 'Type text into an element matched by a CSS selector.',
    parameters: {
      type: 'object',
      properties: {
        selector: { type: 'string', description: 'CSS selector of the input.' },
        text: { type: 'string', description: 'Text to type.' },
      },
      required: ['selector', 'text'],
    },
    handler: async (args, ctx): Promise<ToolResult> => {
      const p = args as { selector?: string; text?: string }
      if (!p.selector || p.text === undefined) {
        return { content: 'Error: selector and text are required', isError: true }
      }
      if (ctx.browser === undefined) {
        return { content: 'Error: no browser provider is wired for this run', isError: true }
      }
      const r = await ctx.browser.type({ selector: p.selector, text: p.text })
      return { content: JSON.stringify(r) }
    },
  },
  {
    name: 'browser_screenshot',
    description:
      'Capture a screenshot of the current page (or a selected element) and persist it as ' +
      'an artifact. Requires an artifact sink — the image is never returned inline.',
    parameters: {
      type: 'object',
      properties: {
        selector: { type: 'string', description: 'Optional CSS selector to scope the capture.' },
        name: { type: 'string', description: 'Artifact name (default "screenshot.png").' },
      },
      required: [],
    },
    handler: async (args, ctx): Promise<ToolResult> => {
      const p = args as { selector?: string; name?: string }
      if (ctx.browser === undefined) {
        return { content: 'Error: no browser provider is wired for this run', isError: true }
      }
      if (ctx.artifacts === undefined) {
        return {
          content:
            'Permission denied: browser_screenshot requires an artifact sink to persist the image; none is wired for this run.',
          isError: true,
        }
      }
      const shot = await ctx.browser.screenshot(
        p.selector !== undefined ? { selector: p.selector } : {},
      )
      const ref = await ctx.artifacts.put({
        name: p.name ?? 'screenshot.png',
        content: shot.data,
        contentType: shot.contentType,
        encoding: 'base64',
      })
      return { content: JSON.stringify({ artifact: ref.id, contentType: shot.contentType }) }
    },
  },
  {
    name: 'browser_extract',
    description: 'Extract text content from the current page, optionally scoped to a CSS selector.',
    parameters: {
      type: 'object',
      properties: {
        selector: { type: 'string', description: 'Optional CSS selector to scope extraction.' },
      },
      required: [],
    },
    handler: async (args, ctx): Promise<ToolResult> => {
      const p = args as { selector?: string }
      if (ctx.browser === undefined) {
        return { content: 'Error: no browser provider is wired for this run', isError: true }
      }
      const r = await ctx.browser.extract(p.selector !== undefined ? { selector: p.selector } : {})
      return { content: JSON.stringify(r) }
    },
  },
]
