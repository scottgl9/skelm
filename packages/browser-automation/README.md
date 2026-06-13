# @skelm/browser-automation

Playwright-backed browser driver and provider for [skelm](https://skelm.dev) —
the concrete implementation of the browser contracts defined in `@skelm/agent`
and `@skelm/integration-sdk`.

## What this is

- A `PlaywrightBrowserDriver` implementing the action surface both contracts
  share: `navigate`, `click`, `type`, `screenshot`, `extract`.
- A registry-level `PlaywrightBrowserProvider` (`@skelm/integration-sdk`'s
  `BrowserProvider`) with identity, health, and the driver.
- Reusable workflow helpers: `capturePageArtifact`, `extractTable`.
- An integration-package `manifest` describing the surface for the gateway.

## Hybrid placement

The contract lives in `@skelm/agent` + `@skelm/integration-sdk` (no heavy
dependency). The Playwright dependency lives **only** here and is lazy-loaded —
importing this package costs nothing until a browser is launched. `playwright-core`
is used (not the full `playwright` meta package) so install does not download a
browser binary; install one explicitly with `pnpm exec playwright install chromium`.

## Security

The gateway is the trust boundary and owns lifecycle, egress, and audit:

- Every `navigate` routes through the gateway-supplied `EgressPolicy` **before**
  any Playwright call; a denied host throws `BrowserEgressError`. Reuses the
  `network` permission dimension — no new core dimension.
- Navigation-causing actions re-check the resulting URL before they return, and
  frame-navigation events keep the same allowlist active after the initial
  `navigate()`. A denied post-navigation host change tears down the active page
  before surfacing the error, so follow-up actions fail closed.
- Screenshots persist through the artifact sink and return only a reference id;
  bytes never travel inline. No typed credential reaches an artifact or log.

See the [docs page](https://skelm.dev/backends/browser-automation) for full
usage and the security posture.

## Tests

```bash
pnpm --filter @skelm/browser-automation test       # unit, no browser
SKELM_LIVE_BROWSER=1 pnpm --filter @skelm/browser-automation test  # + live smoke
```

The live smoke skips cleanly when no browser binary is installed.
