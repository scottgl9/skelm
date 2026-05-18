import type { StateStore } from './run-store.js'

/**
 * Reference to a threaded conversation (a GitHub PR/issue thread, a Slack
 * thread_ts, an email message-id chain, …). `kind` discriminates the
 * source; `key` is a stable string that identifies one conversation within
 * that kind. The helper does not interpret either field — it only uses
 * them to scope a namespace in the underlying StateStore.
 *
 * Conventions used by the built-in integrations:
 *   - github-pr   : `${owner}/${repo}#${number}`
 *   - github-issue: `${owner}/${repo}#${number}`
 *   - slack       : `${channelId}:${threadTs}`
 */
export interface ThreadRef {
  readonly kind: string
  readonly key: string
}

/** A single thread's state-tracking handle. */
export interface Thread {
  readonly ref: ThreadRef
  /** Last comment id recorded by `markSeen`. Undefined when nothing has been seen yet. */
  lastSeen(): Promise<string | undefined>
  /** Record a comment id as the latest one observed. */
  markSeen(commentId: string): Promise<void>
  /**
   * Append a comment to the local record. Comments are stored in
   * insertion order. `commentId` is opaque; callers may use the source
   * provider's id or any stable string.
   */
  appendComment(commentId: string, comment: unknown): Promise<void>
  /**
   * Iterate appended comments newer than `sinceCommentId`. When the id is
   * omitted (or not found in the local record) every appended comment is
   * yielded. Comments are yielded in insertion order.
   */
  unseenSince(sinceCommentId?: string): AsyncIterable<{
    readonly commentId: string
    readonly comment: unknown
  }>
}

/** Per-run accessor; obtain a `Thread` via `ctx.threads.get(ref)`. */
export interface ThreadHost {
  get(ref: ThreadRef): Thread
}

/**
 * Build the `ctx.threads` host backed by the supplied `StateStore`. Each
 * thread uses two state shapes under a shared namespace:
 *   - key `lastSeen`            (string, the last comment id seen)
 *   - stream `comments`         (entries: { commentId, comment })
 *
 * Namespace shape: `thread:<kind>:<key>`. Picked to be distinct from
 * `pipeline:` / `step:` / `shared:` namespaces produced by
 * `resolveStateNamespace`, so thread state never collides with regular
 * `ctx.state` keys.
 */
export function createThreadHost(store: StateStore): ThreadHost {
  return Object.freeze({
    get(ref: ThreadRef): Thread {
      if (!ref.kind || !ref.key) {
        throw new Error('ctx.threads.get(): ref must include non-empty kind and key')
      }
      const namespace = `thread:${ref.kind}:${ref.key}`
      return Object.freeze({
        ref,
        async lastSeen(): Promise<string | undefined> {
          return await store.getState<string>(namespace, 'lastSeen')
        },
        async markSeen(commentId: string): Promise<void> {
          await store.setState(namespace, 'lastSeen', commentId)
        },
        async appendComment(commentId: string, comment: unknown): Promise<void> {
          await store.appendState(namespace, 'comments', { commentId, comment })
        },
        async *unseenSince(
          sinceCommentId?: string,
        ): AsyncIterable<{ commentId: string; comment: unknown }> {
          let pastSince = sinceCommentId === undefined
          for await (const entry of store.readState(namespace, 'comments')) {
            const e = entry as { commentId: string; comment: unknown }
            if (!pastSince) {
              if (e.commentId === sinceCommentId) pastSince = true
              continue
            }
            yield e
          }
        },
      })
    },
  })
}
