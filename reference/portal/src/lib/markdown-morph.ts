/**
 * DOM-morph helper for markdown viewers — preserves scroll, text
 * selection, and focus across content updates.
 *
 * Pattern:
 *   1. Caller binds a container element via `bind:this={el}` and never
 *      uses `{@html}` on it (Svelte's reactive innerHTML replacement
 *      would clobber morphed nodes).
 *   2. Caller calls `applyMorph(container, html)` whenever new rendered
 *      HTML is ready. The helper diffs into `container.children` and
 *      patches in place.
 *
 * `childrenOnly: true` keeps the bound container stable — only its
 * children are morphed, so the Svelte ref never goes stale and any
 * event handlers attached to the container itself (click delegation
 * for interactive checkboxes, etc.) survive.
 */

import morphdom from 'morphdom';

/**
 * Morph `container`'s children to match the given HTML. The helper
 * builds a hidden wrapper element from `html`, lets morphdom diff
 * against `container`, and applies minimal patches.
 *
 * Idempotent: passing the same HTML twice in a row does no DOM work.
 *
 * Returns true on success, false if either argument is missing.
 */
export function applyMorph(container: HTMLElement | null | undefined, html: string): boolean {
  if (!container) return false;
  // Idempotency / cheap fast-path: if the container's last morphed
  // signature matches the new html, skip. We stash on the element to
  // avoid an extra Map lookup per call.
  const sig = (container as any).__lastMorphSig;
  if (sig === html) return true;

  // Build the source tree. Using a wrapper div with the SAME tag /
  // class as the container ensures morphdom treats the children
  // 1:1 — it compares root attributes too even with childrenOnly,
  // and divergent tags would force a full replace.
  const wrapper = document.createElement(container.tagName.toLowerCase());
  // Mirror class / id so morphdom doesn't try to reconcile the root
  // attributes themselves (we only care about the children).
  if (container.className) wrapper.className = container.className;
  wrapper.innerHTML = html;

  morphdom(container, wrapper, {
    childrenOnly: true,
    onBeforeElUpdated: (fromEl, toEl) => {
      // Skip if structurally identical — saves attribute-walks for
      // the common case where most nodes are unchanged between
      // renders (a paragraph with no edits).
      if (fromEl.isEqualNode(toEl)) return false;
      return true;
    },
  });

  (container as any).__lastMorphSig = html;
  return true;
}

/**
 * Convenience: clear a container's morph state. Call when the
 * viewer is unmounting or when the doc identity changes — without
 * this, switching docs whose HTML happens to coincidentally match
 * the cached signature would skip the morph.
 */
export function resetMorph(container: HTMLElement | null | undefined) {
  if (!container) return;
  delete (container as any).__lastMorphSig;
}
