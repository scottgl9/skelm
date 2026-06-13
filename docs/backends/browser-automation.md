# Browser automation (`@skelm/browser-automation`)

The concrete [Playwright](https://playwright.dev/)-backed implementation of
skelm's browser contracts. It supplies a `BrowserProvider`/`BrowserDriver` that
the native agent's browser tools (`browser_navigate`, `browser_click`,
`browser_type`, `browser_screenshot`, `browser_extract`) drive, plus a few
reusable workflow helpers.

## Hybrid placement

The browser **contract** is defined where it can be tested without a heavy
dependency, and the **driver** lives here:

- `@skelm/agent` — the browser tool surface (`navigate`/`click`/`type`/
  `screenshot`/`extract`) and its permission posture (`tools/browser.ts`).
- `@skelm/integration-sdk` — the registry-level `BrowserProvider` and the
  structural `BrowserDriver` mirror (`providers.ts`).
- `@skelm/browser-automation` (this package) — the Playwright driver that
  satisfies both. `playwright-core` is a dependency of this package only; it
  never leaks into core or agent, which keep only the contract.

## Install

```bash
pnpm add @skelm/browser-automation
# Playwright needs a browser binary for real navigation:
pnpm exec playwright install chromium
```

`playwright-core` is the dependency rather than the full `playwright` meta
package, so installing this package does **not** download a browser binary on
its own — the gateway/operator installs the browser explicitly. Playwright is
also **lazy-loaded**: importing this package costs nothing until a browser is
actually launched.

## Usage

The gateway constructs the provider with a gateway-supplied **egress policy** and
owns its lifecycle. Authors never construct an uncontrolled browser.

```ts
import { PlaywrightBrowserProvider } from '@skelm/browser-automation'

// `egress` is supplied by the gateway; here it is illustrative.
const provider = new PlaywrightBrowserProvider({
  egress: (host) => ({ allow: host.endsWith('.example.com') }),
  headless: true,
})

const result = await provider.driver.navigate('https://docs.example.com')
// → { text: '<page title>', url: 'https://docs.example.com/' }
```

### Workflow helpers

```ts
import { capturePageArtifact, extractTable } from '@skelm/browser-automation'

// Navigate then persist a screenshot through the artifact sink (never inline):
const shot = await capturePageArtifact(provider.playwrightDriver, artifactSink, {
  url: 'https://docs.example.com',
  name: 'docs.png',
})

// Extract a text/HTML table into rows of cells:
const { rows } = await extractTable(provider.playwrightDriver, { selector: '#data' })
```

## Security posture

The gateway is the trust boundary; this driver enforces the contract but does not
own policy.

- **Egress-gated navigation.** Every `navigate` consults the gateway-supplied
  `EgressPolicy` **before** any Playwright call. A denied host throws
  `BrowserEgressError` and no navigation occurs — the driver never opens an
  arbitrary URL the policy does not allow. This reuses the agent's existing
  `network` permission dimension (a browser navigation is network egress); no new
  core permission dimension is added.
- **Navigation-causing actions stay gated.** `click()` re-checks the page URL
  before returning, and frame-navigation events keep the same allowlist active
  after the initial `navigate()`, so a page cannot silently pivot the browser to
  a different host without surfacing `BrowserEgressError`. When that happens,
  the driver tears down the active page before returning the error so follow-up
  actions fail closed.
- **Screenshots are artifacts, never inline secrets.**
  `captureScreenshotArtifact` (and the agent's `browser_screenshot` tool) persist
  image bytes through the artifact sink and return only a reference id. Image
  bytes never travel inline through that path.
- **No secret leakage.** The driver writes nothing to logs; egress error messages
  name only the host, never query strings or typed credentials.
- **Gateway owns lifecycle, egress, and audit.** The driver is constructed with
  the policy + sink and exposes `close()`; the gateway launches, closes, gates,
  and audits. No uncontrolled browser process is spawned.

## Tests

- **Unit (default CI, no browser):** an injected fake Playwright
  `Browser`/`Page` verifies each op maps to the right Playwright call, that an
  egress DENY blocks navigation before any nav, that screenshots route to the
  artifact sink rather than inline, and that no typed secret reaches an artifact.
- **Live smoke (opt-in):** set `SKELM_LIVE_BROWSER=1` to drive a real chromium
  against a local static HTML fixture. It skips cleanly when the flag is absent
  or no browser binary is installed.
