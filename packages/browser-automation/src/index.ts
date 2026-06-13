/**
 * @skelm/browser-automation
 *
 * Playwright-backed concrete implementation of the browser contracts skelm
 * defines: the agent's browser tool `BrowserProvider`
 * (navigate/click/type/screenshot/extract) and the integration-sdk's
 * registry-level `BrowserProvider`/`BrowserDriver`.
 *
 * Hybrid placement: the contract lives in `@skelm/agent` + `@skelm/integration-sdk`
 * (no heavy dependency); the Playwright dependency lives only here and is
 * lazy-loaded. Navigation is egress-gated; screenshots route to an artifact
 * sink; the gateway constructs the driver with policy + sink and owns lifecycle,
 * egress, and audit.
 */

export {
  PlaywrightBrowserDriver,
  BrowserEgressError,
  BrowserNotNavigatedError,
} from './driver.js'
export type {
  ArtifactSink,
  BrowserActionResult,
  BrowserScreenshot,
  PlaywrightBrowserDriverOptions,
} from './driver.js'

export { PlaywrightBrowserProvider } from './provider.js'
export type { PlaywrightBrowserProviderOptions } from './provider.js'

export { capturePageArtifact, extractTable } from './workflows.js'

export { manifest } from './manifest.js'

export type {
  PlaywrightLauncher,
  PwBrowser,
  PwContext,
  PwLocator,
  PwPage,
} from './playwright-types.js'
