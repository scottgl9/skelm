/**
 * Canned webhook payloads shipped as a {@link MockProviderFixture} so CI can
 * drive the normalizer deterministically without a real network. No real
 * credentials or secret values appear here.
 */

import type { MockProviderFixture } from '@skelm/integration-sdk'

export const GENERIC_WEBHOOK_FIXTURE: MockProviderFixture = {
  provider: 'webhook',
  description: 'Canned generic webhook payloads for deterministic CI.',
  payloads: {
    'event.created': {
      event: { type: 'event.created', id: 'evt_001' },
      data: { resource: 'order', resourceId: 'ord_42' },
    },
    'event.updated': {
      event: { type: 'event.updated', id: 'evt_002' },
      data: { resource: 'order', resourceId: 'ord_42' },
    },
    'no-id': {
      event: { type: 'event.unidentified' },
      data: { note: 'provider supplied no id; normalizer derives one' },
    },
  },
}
