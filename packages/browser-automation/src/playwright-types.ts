/**
 * Minimal structural subset of the Playwright surface this package drives.
 *
 * The driver depends only on these shapes, never on `playwright-core`'s concrete
 * classes at the type level. That keeps imports cheap (Playwright is lazy-loaded
 * at launch, see {@link PlaywrightLauncher}) and lets tests inject a fake
 * Browser/Page without a real browser process.
 */

/** A located element handle — the subset we read text from. */
export interface PwLocator {
  innerText(): Promise<string>
}

/** A frame-like handle used by navigation events. */
export interface PwFrame {
  url(): string
}

/** A browser page — the subset of Playwright's `Page` the driver uses. */
export interface PwPage {
  goto(url: string): Promise<unknown>
  click(selector: string): Promise<void>
  fill(selector: string, value: string): Promise<void>
  title(): Promise<string>
  url(): string
  innerText(selector: string): Promise<string>
  locator(selector: string): PwLocator
  on?(event: 'framenavigated', listener: (frame: PwFrame) => void): void
  screenshot(opts?: { type?: 'png' | 'jpeg' }): Promise<Uint8Array>
}

/** A browser context — issues pages. */
export interface PwContext {
  newPage(): Promise<PwPage>
}

/** A launched browser — the subset the driver uses. */
export interface PwBrowser {
  newContext(): Promise<PwContext>
  close(): Promise<void>
}

/**
 * Launches a browser. In production this resolves `playwright-core`'s
 * `chromium.launch`; in tests an in-memory fake is injected. Returning the
 * structural {@link PwBrowser} is what keeps the heavy dependency lazy and
 * mockable.
 */
export type PlaywrightLauncher = (opts: { headless: boolean }) => Promise<PwBrowser>
