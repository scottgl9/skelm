/**
 * Declarative manifest for the browser-automation package.
 *
 * Follows the SDK's {@link IntegrationPackageManifest} runtime-descriptor shape:
 * the gateway reads it after load to register the package's surface. The package
 * needs no credentials (a local Playwright browser resolves no secrets) but does
 * require the `network` permission dimension — every navigation is network
 * egress gated by the gateway-supplied egress policy.
 */

import type { IntegrationPackageManifest } from '@skelm/integration-sdk'

export const manifest: IntegrationPackageManifest = {
  name: '@skelm/browser-automation',
  version: '0.4.8',
  description: 'Playwright-backed browser provider: egress-gated navigation, artifact screenshots.',
  actions: [
    { id: 'navigate', description: 'Navigate to a URL.', requiredPermissions: ['network'] },
    { id: 'click', description: 'Click an element by CSS selector.' },
    { id: 'type', description: 'Type text into an element by CSS selector.' },
    {
      id: 'screenshot',
      description: 'Capture a screenshot; persisted as an artifact, never inline.',
    },
    { id: 'extract', description: 'Extract DOM text/table content.' },
  ],
  requiredPermissions: ['network'],
  liveTests: [
    {
      provider: '@skelm/browser-automation',
      name: 'live browser smoke (local static fixture)',
      requiredEnv: ['SKELM_LIVE_BROWSER'],
      description:
        'Drives a real Playwright browser against a local static HTML fixture. ' +
        'Skipped unless SKELM_LIVE_BROWSER=1 and a browser binary is installed.',
    },
  ],
}
