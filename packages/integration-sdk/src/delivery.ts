/**
 * Delivery target contract.
 *
 * The canonical {@link DeliveryTarget} already lives in `@skelm/core` (Phase 2),
 * where it is recorded on tasks. It is re-exported here — not redefined — so
 * integration packages share the exact same shape across tasks, HITL gates,
 * notifications, cron/scheduled runs, and final artifacts. Reconcile, do not
 * duplicate: there is one `DeliveryTarget`.
 */

export type { DeliveryTarget } from '@skelm/core'
