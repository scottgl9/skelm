/**
 * Playwright-backed browser driver.
 *
 * Implements the action surface both merged contracts define:
 *   - `@skelm/agent`'s browser tool `BrowserProvider`
 *     (navigate/click/type/screenshot/extract), driven by the native agent's
 *     browser tools, and
 *   - `@skelm/integration-sdk`'s structural `BrowserDriver` (the registry-level
 *     mirror), since the method shapes are identical.
 *
 * Security posture (the gateway owns the trust boundary):
 *   - Every navigation routes through the gateway-supplied {@link EgressPolicy}
 *     BEFORE any Playwright call. A denied host throws {@link BrowserEgressError}
 *     and no browser navigation occurs.
 *   - {@link PlaywrightBrowserDriver.captureScreenshotArtifact} persists the
 *     image through the supplied artifact sink and returns only a reference id —
 *     bytes never travel inline through that path. The raw {@link screenshot}
 *     returns bytes solely to satisfy the contract signature the agent tool
 *     wrapper consumes (that wrapper is itself the artifact-sink boundary).
 *   - Playwright is lazy-loaded at first launch, so importing this module costs
 *     nothing until a browser is actually needed. The gateway constructs the
 *     driver with the policy + sink and owns lifecycle (launch/close), egress,
 *     and audit; the driver opens no uncontrolled browser process.
 */

import type { EgressPolicy } from '@skelm/integration-sdk'

import type { PlaywrightLauncher, PwBrowser, PwFrame, PwPage } from './playwright-types.js'

/** Result shape shared by navigate/click/type/extract — matches both contracts. */
export interface BrowserActionResult {
  text: string
  url?: string
}

/** Raw screenshot bytes the driver returns — matches both contracts. */
export interface BrowserScreenshot {
  /** base64-encoded image bytes. */
  data: string
  contentType: string
}

/**
 * Artifact sink the driver persists screenshots through. Structurally matches
 * `@skelm/agent`'s `ArtifactHandle.put`, so a gateway-supplied handle satisfies
 * it directly. The driver never holds the bytes longer than the call.
 */
export interface ArtifactSink {
  put(input: {
    name: string
    content: string
    contentType?: string
    encoding?: 'utf-8' | 'base64'
  }): Promise<{ id: string }>
}

/** Thrown when the egress policy denies a navigation host. */
export class BrowserEgressError extends Error {
  readonly host: string
  constructor(host: string, reason?: string) {
    super(`Browser egress denied for host "${host}"${reason ? `: ${reason}` : ''}`)
    this.name = 'BrowserEgressError'
    this.host = host
  }
}

/** Thrown when an action runs before a page exists (no prior navigate). */
export class BrowserNotNavigatedError extends Error {
  constructor() {
    super('No active page — call navigate(url) before this action')
    this.name = 'BrowserNotNavigatedError'
  }
}

export interface PlaywrightBrowserDriverOptions {
  /** Gateway-supplied egress hook. Required — the driver never opens a host the policy denies. */
  readonly egress: EgressPolicy
  /** Run headless (default true). */
  readonly headless?: boolean
  /**
   * Browser launcher. Defaults to lazily importing `playwright-core` chromium.
   * Tests inject a fake to avoid a real browser.
   */
  readonly launcher?: PlaywrightLauncher
  /** Abort signal forwarded to long-running actions, when supplied. */
  readonly signal?: AbortSignal
}

function hostOf(url: string): string | undefined {
  try {
    return new URL(url).hostname
  } catch {
    return undefined
  }
}

const defaultLauncher: PlaywrightLauncher = async ({ headless }) => {
  const { chromium } = await import('playwright-core')
  return (await chromium.launch({ headless })) as unknown as PwBrowser
}

export class PlaywrightBrowserDriver {
  readonly headless: boolean
  private readonly egress: EgressPolicy
  private readonly launcher: PlaywrightLauncher
  private browser: PwBrowser | undefined
  private page: PwPage | undefined
  private pendingNavigationViolation: BrowserEgressError | undefined

  constructor(opts: PlaywrightBrowserDriverOptions) {
    this.egress = opts.egress
    this.headless = opts.headless ?? true
    this.launcher = opts.launcher ?? defaultLauncher
  }

  private enforce(url: string): string {
    const host = hostOf(url)
    if (host === undefined) throw new BrowserEgressError(url, 'invalid URL')
    const decision = this.egress(host)
    if (!decision.allow) throw new BrowserEgressError(host, decision.reason)
    return host
  }

  private async ensurePage(): Promise<PwPage> {
    if (this.page) return this.page
    if (!this.browser) this.browser = await this.launcher({ headless: this.headless })
    const context = await this.browser.newContext()
    this.page = await context.newPage()
    this.installNavigationGuard(this.page)
    return this.page
  }

  private requirePage(): PwPage {
    if (!this.page) throw new BrowserNotNavigatedError()
    return this.page
  }

  async navigate(url: string): Promise<BrowserActionResult> {
    this.enforce(url)
    const page = await this.ensurePage()
    this.pendingNavigationViolation = undefined
    await page.goto(url)
    await this.enforceCurrentUrl(page)
    return { text: await page.title(), url: page.url() }
  }

  async click(selector: string): Promise<BrowserActionResult> {
    const page = this.requirePage()
    this.pendingNavigationViolation = undefined
    await page.click(selector)
    await this.enforceCurrentUrl(page)
    return { text: await page.title(), url: page.url() }
  }

  async type(input: { selector: string; text: string }): Promise<BrowserActionResult> {
    const page = this.requirePage()
    await page.fill(input.selector, input.text)
    return { text: await page.title(), url: page.url() }
  }

  async screenshot(input?: { selector?: string }): Promise<BrowserScreenshot> {
    const page = this.requirePage()
    const bytes =
      input?.selector !== undefined
        ? await captureElement(page, input.selector)
        : await page.screenshot({ type: 'png' })
    return { data: Buffer.from(bytes).toString('base64'), contentType: 'image/png' }
  }

  async extract(input: { selector?: string }): Promise<BrowserActionResult> {
    const page = this.requirePage()
    const text =
      input.selector !== undefined
        ? await page.innerText(input.selector)
        : await page.innerText('body')
    return { text: normalizeText(text), url: page.url() }
  }

  /**
   * Capture a screenshot and persist it through the artifact sink, returning
   * only the reference id and content type. Bytes never travel inline. This is
   * the path the gateway/host should prefer for durable, auditable captures.
   */
  async captureScreenshotArtifact(
    sink: ArtifactSink,
    input?: { selector?: string; name?: string },
  ): Promise<{ artifact: string; contentType: string }> {
    const shot = await this.screenshot(
      input?.selector !== undefined ? { selector: input.selector } : {},
    )
    const ref = await sink.put({
      name: input?.name ?? 'screenshot.png',
      content: shot.data,
      contentType: shot.contentType,
      encoding: 'base64',
    })
    return { artifact: ref.id, contentType: shot.contentType }
  }

  /** Close the browser. The gateway owns lifecycle; call when the run ends. */
  async close(): Promise<void> {
    const browser = this.browser
    this.browser = undefined
    this.page = undefined
    this.pendingNavigationViolation = undefined
    if (browser) await browser.close()
  }

  private installNavigationGuard(page: PwPage): void {
    page.on?.('framenavigated', (frame: PwFrame) => {
      try {
        this.enforce(frame.url())
      } catch (error) {
        if (error instanceof BrowserEgressError) {
          this.pendingNavigationViolation ??= error
          return
        }
        throw error
      }
    })
  }

  private async enforceCurrentUrl(page: PwPage): Promise<void> {
    let violation = this.pendingNavigationViolation
    if (!violation) {
      try {
        this.enforce(page.url())
      } catch (error) {
        if (error instanceof BrowserEgressError) violation = error
        else throw error
      }
    }
    if (violation) {
      await this.discardPage()
      throw violation
    }
  }

  private async discardPage(): Promise<void> {
    const browser = this.browser
    this.browser = undefined
    this.page = undefined
    this.pendingNavigationViolation = undefined
    if (browser) {
      try {
        await browser.close()
      } catch {}
    }
  }
}

async function captureElement(page: PwPage, selector: string): Promise<Uint8Array> {
  const loc = page.locator(selector) as unknown as { screenshot?(): Promise<Uint8Array> }
  if (typeof loc.screenshot === 'function') return loc.screenshot()
  return page.screenshot({ type: 'png' })
}

function normalizeText(text: string): string {
  return text
    .split('\n')
    .map((line) => line.trim())
    .filter((line) => line.length > 0)
    .join('\n')
}
