/**
 * Live document subscription — keeps a portal viewer in sync with the
 * agent's writes via Server-Sent Events.
 *
 * Two channels:
 *
 *   1. **Per-doc** (`subscribeToDoc(path, opts)`). Used by the library
 *      doc viewer, ContextTab, and Space cover iframe. Server sends
 *      notification events only (`doc-updated` / `doc-removed`); the
 *      client refetches the doc body via `/portal/documents/:path`.
 *      Encryption stays in the standard read path — content never
 *      travels through a second decryption surface.
 *
 *   2. **List-channel** (`subscribeToLibrary(opts)`, PR 6). Used by
 *      the library list page. Server sends metadata-only events for
 *      every list-affecting mutation across the operator's docs:
 *      `document-upserted` (path + scope + updated_at) and
 *      `document-removed` (path). The list page patches its
 *      in-memory array; for unknown paths it fetches the row via
 *      the same per-doc API to render the new entry. Same privacy
 *      contract as the per-doc channel — title/summary live behind
 *      the per-doc fetch, never streamed in the SSE payload.
 *
 * Lifecycle (managed inside each helper):
 *   - Open EventSource → on `open`, fire a sync callback so the
 *     viewer catches anything that changed since mount.
 *   - Per-doc: on `doc-updated`, call `onUpdate()` UNLESS the path is
 *     within the self-write suppression window (`markSelfWrite`).
 *   - List: on `document-upserted`, call `onDocUpserted(payload)`;
 *     on `document-removed`, call `onDocRemoved(payload)`. Self-write
 *     suppression is applied at the helper layer for the upsert path.
 *   - On 3 consecutive failed reconnects, stop and surface
 *     `onConnectionState('disconnected')`. Caller can offer manual retry.
 *   - On clean reconnect, surface `onConnectionState('live')` and
 *     trigger a resync callback to catch missed events.
 *
 * Self-write suppression: when the same tab POSTs an edit, it should
 * not see its own SSE echo redrawn. Call `markSelfWrite(path)` right
 * after a successful POST; both per-doc and list channels honour the
 * same registry. Other tabs see the update normally.
 */

const SELF_WRITE_WINDOW_MS = 300;
const MAX_FAILED_RECONNECTS = 3;

export type LiveConnectionState = 'connecting' | 'live' | 'disconnected';

export interface SubscribeOptions {
  /** Called when the doc has changed (or on initial connect). */
  onUpdate: () => void;
  /** Called when the doc has been deleted. Optional. */
  onDelete?: () => void;
  /** Surfaces transitions between connecting / live / disconnected. */
  onConnectionState?: (state: LiveConnectionState) => void;
}

export interface DocLiveSubscription {
  /** Stops the subscription and frees the EventSource. */
  dispose: () => void;
  /**
   * Mark a self-write so the next ~300ms of `doc-updated` events for
   * this path are ignored (the saving tab already has the new state
   * locally).
   */
  markSelfWrite: () => void;
  /** Manually trigger a refetch — exposed for "retry" UI. */
  refetch: () => void;
}

// Shared self-write registry. Keyed by path so a save in one tab does
// not suppress events for the SAME path in OTHER tabs (each tab has
// its own JS state).
const selfWriteUntil = new Map<string, number>();

/**
 * Mark a self-write for `path`. Standalone export so portal save
 * handlers can call this without needing a subscription handle (e.g.
 * the library page saves before subscriptions exist for that doc).
 */
export function markSelfWrite(path: string) {
  selfWriteUntil.set(path, Date.now() + SELF_WRITE_WINDOW_MS);
}

function isInSelfWriteWindow(path: string): boolean {
  const until = selfWriteUntil.get(path);
  if (!until) return false;
  if (Date.now() < until) return true;
  selfWriteUntil.delete(path);
  return false;
}

/**
 * Subscribe to live updates for one document. Returns a handle with a
 * `dispose()` to call on unmount. Safe to call from a Svelte $effect:
 *
 *   $effect(() => {
 *     if (!path) return;
 *     const sub = subscribeToDoc(path, { onUpdate: () => refetch(path) });
 *     return () => sub.dispose();
 *   });
 */
export function subscribeToDoc(path: string, opts: SubscribeOptions): DocLiveSubscription {
  if (!path) throw new Error('subscribeToDoc: path required');
  const url = `/portal/sse/document?path=${encodeURIComponent(path)}`;

  let es: EventSource | null = null;
  let failedReconnects = 0;
  let disposed = false;
  // Browsers auto-reconnect EventSource; we observe the readyState
  // transition via `onerror` and decide whether to give up.
  let lastState: LiveConnectionState = 'connecting';

  function setState(next: LiveConnectionState) {
    if (next === lastState) return;
    lastState = next;
    opts.onConnectionState?.(next);
  }

  function open() {
    if (disposed) return;
    setState('connecting');
    es = new EventSource(url);

    es.onopen = () => {
      failedReconnects = 0;
      setState('live');
      // Always refetch on (re)connect so we catch anything that
      // happened during the disconnect window.
      try { opts.onUpdate(); } catch { /* caller's problem */ }
    };

    es.onmessage = (ev: MessageEvent) => {
      let data: { type?: string; path?: string };
      try { data = JSON.parse(ev.data); } catch { return; }
      if (!data || typeof data !== 'object') return;

      if (data.type === 'doc-updated') {
        if (isInSelfWriteWindow(path)) return;
        try { opts.onUpdate(); } catch { /* caller's problem */ }
      } else if (data.type === 'doc-removed') {
        try { opts.onDelete?.(); } catch { /* caller's problem */ }
      }
    };

    es.onerror = () => {
      // EventSource flips to CLOSED on terminal errors (auth fail,
      // 4xx). Browsers still try to reconnect on transient errors;
      // we bail after MAX_FAILED_RECONNECTS to avoid hammering.
      if (!es) return;
      const closed = es.readyState === 2; // EventSource.CLOSED
      failedReconnects++;
      if (closed || failedReconnects >= MAX_FAILED_RECONNECTS) {
        try { es.close(); } catch { /* noop */ }
        es = null;
        setState('disconnected');
        // Don't auto-reopen. Caller can call `refetch()` to retry on
        // user action.
        return;
      }
      setState('connecting');
    };
  }

  function refetch() {
    // If we're disconnected, this is the user's manual retry — try
    // once to re-open the SSE channel; on success we'll get an
    // onopen-driven onUpdate anyway.
    try { opts.onUpdate(); } catch { /* caller's problem */ }
    if (lastState === 'disconnected' && !disposed) {
      failedReconnects = 0;
      open();
    }
  }

  function markSelfWriteLocal() {
    markSelfWrite(path);
  }

  function dispose() {
    disposed = true;
    if (es) {
      try { es.close(); } catch { /* noop */ }
      es = null;
    }
  }

  open();

  return { dispose, markSelfWrite: markSelfWriteLocal, refetch };
}

// ─── List channel — collection-level subscription (PR 6) ────────────────

export interface DocUpsertedEvent {
  path: string;
  scope?: string;
  updated_at?: string;
  /**
   * PR 7 structural fields. is_pinned (0/1) + folder_id (UUID|null) +
   * published (0/1) let the patcher update pin / move / publish state
   * in place without a follow-up GET. They're non-sensitive
   * structural enums per the doc-broadcaster threat model.
   */
  is_pinned?: number;
  folder_id?: string | null;
  published?: number;
}

export interface DocRemovedEvent {
  path: string;
}

/**
 * Folder mutation event (PR 7). Server emits one of:
 *   - 'folder-created'  with { folder_id, parent_id }
 *   - 'folder-renamed'  with { folder_id }
 *   - 'folder-removed'  with { folder_id }
 *
 * Folder names live in plaintext at rest but stay off the SSE wire
 * because they're user-chosen labels with potentially-sensitive
 * context. Caller should refetch `/portal/folders` to render current
 * state. The helper exposes a single `onFolderChanged` callback for
 * all three event types since the typical caller's response is the
 * same (refetch the small folder list).
 */
export interface FolderEvent {
  type: 'folder-created' | 'folder-renamed' | 'folder-removed';
  folder_id: string;
  parent_id?: string | null;
}

export interface SubscribeListOptions {
  /** Called on initial connect AND on reconnect (resyncs missed events). */
  onResync: () => void;
  /** Called for each `document-upserted` event (after self-write suppression). */
  onDocUpserted: (ev: DocUpsertedEvent) => void;
  /** Called for each `document-removed` event. */
  onDocRemoved: (ev: DocRemovedEvent) => void;
  /**
   * PR 7: called for each folder mutation event. Coarse — typical
   * caller's response is a refetch of `/portal/folders`. Optional;
   * subscribers that don't render folder UI can omit it.
   */
  onFolderChanged?: (ev: FolderEvent) => void;
  /** Surfaces transitions between connecting / live / disconnected. */
  onConnectionState?: (state: LiveConnectionState) => void;
}

export interface ListLiveSubscription {
  /** Stops the subscription and frees the EventSource. */
  dispose: () => void;
  /** Manually trigger a reconnect — exposed for "retry" UI. */
  retry: () => void;
}

/**
 * Subscribe to library-list-affecting events for the authenticated
 * user. Returns a handle with `dispose()` for caller's onUnmount.
 *
 * Same reconnect / disposer / connection-state pattern as
 * `subscribeToDoc`. The caller does the actual list patching in the
 * `onDocUpserted` / `onDocRemoved` callbacks; this helper just
 * normalises the wire format and applies self-write suppression.
 */
export function subscribeToLibrary(opts: SubscribeListOptions): ListLiveSubscription {
  const url = '/portal/sse/library';

  let es: EventSource | null = null;
  let failedReconnects = 0;
  let disposed = false;
  let lastState: LiveConnectionState = 'connecting';

  function setState(next: LiveConnectionState) {
    if (next === lastState) return;
    lastState = next;
    opts.onConnectionState?.(next);
  }

  function open() {
    if (disposed) return;
    setState('connecting');
    es = new EventSource(url);

    es.onopen = () => {
      failedReconnects = 0;
      setState('live');
      // Resync on (re)connect: the client may have missed events
      // during the disconnect window; the simplest correct
      // recovery is a full list refetch by the caller.
      try { opts.onResync(); } catch { /* caller's problem */ }
    };

    es.onmessage = (ev: MessageEvent) => {
      let data: {
        type?: string;
        path?: string;
        scope?: string;
        updated_at?: string;
        is_pinned?: number;
        folder_id?: string | null;
        published?: number;
        folder_id_field?: never; // narrow: folder events use folder_id at top-level
      } & { folder_id?: string; parent_id?: string | null };
      try { data = JSON.parse(ev.data); } catch { return; }
      if (!data || typeof data !== 'object') return;

      switch (data.type) {
        case 'document-upserted': {
          if (typeof data.path !== 'string') return;
          // Honour self-write suppression so a save in this tab
          // doesn't immediately re-trigger work for the same path.
          // The patcher's optimistic update already handled it.
          if (isInSelfWriteWindow(data.path)) return;
          try {
            opts.onDocUpserted({
              path: data.path,
              scope: data.scope,
              updated_at: data.updated_at,
              is_pinned: data.is_pinned,
              folder_id: data.folder_id,
              published: data.published,
            });
          } catch { /* caller's problem */ }
          return;
        }
        case 'document-removed': {
          if (typeof data.path !== 'string') return;
          try { opts.onDocRemoved({ path: data.path }); } catch { /* caller's problem */ }
          return;
        }
        case 'folder-created':
        case 'folder-renamed':
        case 'folder-removed': {
          if (typeof data.folder_id !== 'string') return;
          if (!opts.onFolderChanged) return;
          try {
            opts.onFolderChanged({
              type: data.type,
              folder_id: data.folder_id,
              parent_id: data.parent_id,
            });
          } catch { /* caller's problem */ }
          return;
        }
        default:
          return;
      }
    };

    es.onerror = () => {
      if (!es) return;
      const closed = es.readyState === 2; // EventSource.CLOSED
      failedReconnects++;
      if (closed || failedReconnects >= MAX_FAILED_RECONNECTS) {
        try { es.close(); } catch { /* noop */ }
        es = null;
        setState('disconnected');
        return;
      }
      setState('connecting');
    };
  }

  function retry() {
    if (disposed) return;
    if (es) { try { es.close(); } catch { /* noop */ } es = null; }
    failedReconnects = 0;
    open();
  }

  function dispose() {
    disposed = true;
    if (es) {
      try { es.close(); } catch { /* noop */ }
      es = null;
    }
  }

  open();

  return { dispose, retry };
}
