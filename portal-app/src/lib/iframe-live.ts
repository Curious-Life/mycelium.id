/**
 * iframe-live — fluid HTML document updates inside a sandboxed iframe.
 *
 * The agent (or any other writer) can rewrite an HTML document while
 * the user is viewing it. The naïve `srcdoc = newHtml` reassignment
 * causes a full reload (white flash, scroll-reset, animation restart).
 * This module avoids that by:
 *
 *   1. Wrapping the agent's HTML with a small bootloader script
 *      (`wrapHtmlForLive`). The bootloader inlines morphdom and listens
 *      for `postMessage` updates from the parent.
 *   2. Providing `mountLiveIframe` to manage the parent-side handshake:
 *      it tracks when the bootloader has signalled `mycelium:ready`
 *      and, after that, sends updates via `postMessage` instead of
 *      reassigning `srcdoc`. Updates that arrive before the bootloader
 *      is ready fall back to a `srcdoc` swap (one initial flash, then
 *      smooth thereafter).
 *
 * Sandbox stays `allow-scripts allow-popups` (no `allow-same-origin`):
 * the iframe runs in a unique null origin. It cannot read parent
 * cookies, call our APIs, or spy on the parent DOM. The only channel
 * is the structured-clone postMessage we explicitly use.
 *
 * Origin checks: a null-origin iframe's `event.origin` is the literal
 * string `'null'` and is not a useful trust signal. We trust by SOURCE
 * IDENTITY instead — `event.source === iframeEl.contentWindow`. That
 * identity is established by us (the parent) when we created the
 * iframe; nothing outside the parent's tab can spoof it.
 */

// Vite-specific: load the morphdom UMD bundle as a raw string at build
// time so we can inline it into the bootloader. This is the only safe
// way to get morphdom INTO a null-origin iframe — XHR/import would be
// blocked by the sandbox without `allow-same-origin`.
//
// `?raw` is supported by Vite/SvelteKit out of the box.
import morphdomUmdSrc from 'morphdom/dist/morphdom-umd.min.js?raw';

// Marker so we never double-wrap (a doc that's already been wrapped
// gets passed back through `wrapHtmlForLive` if the user toggles
// modes — we should leave it alone).
const WRAP_MARKER = '<!--mycelium-live-bootloader-->';

// Prepended to every wrapped doc so iframes follow the user's system
// dark/light preference. `color-scheme: light dark` tells the browser
// the doc supports both modes (drives default scrollbar / form-control
// theming); the `Canvas`/`CanvasText` system colors give a sane default
// surface that flips automatically. Author CSS appears LATER in source
// order, so any explicit `body { background: ... }` the doc sets still
// wins via cascade — this is a fallback, not an override.
const SYSTEM_THEME_PREAMBLE =
  '<meta name="color-scheme" content="light dark">'
  + '<style>html,body{background:Canvas;color:CanvasText}</style>';

// Bootloader logic that runs INSIDE the iframe after morphdom has
// been inlined. Authored as a plain string (not via `Function`
// serialization) so build-time minification can't strip placeholder
// comments. Pure ES5-safe code — the iframe may be rendering on an
// old browser embedded in some shared context.
const BOOTLOADER_TAIL = `
(function(){
  if (typeof window === 'undefined' || !window.morphdom) return;
  var morphdom = window.morphdom;

  function parseBody(html) {
    try { return new DOMParser().parseFromString(html, 'text/html').body; }
    catch (e) { return null; }
  }

  function apply(html) {
    var newBody = parseBody(html);
    if (!newBody) return;
    morphdom(document.body, newBody, {
      childrenOnly: false,
      onBeforeElUpdated: function (a, b) { return !a.isEqualNode(b); }
    });
  }

  window.addEventListener('message', function (e) {
    var d = e && e.data;
    if (!d || typeof d !== 'object') return;
    if (e.source !== window.parent) return;
    if (d.type === 'mycelium:update' && typeof d.html === 'string') {
      apply(d.html);
    }
  });

  try { window.parent.postMessage({ type: 'mycelium:ready' }, '*'); }
  catch (e) { /* parent gone */ }
})();
`;

/**
 * Compose the bootloader script: morphdom UMD followed by our message
 * handler. Defensive `</script>` escape in the morphdom source
 * prevents an inline-script-injection edge case where the bundle
 * happens to contain a literal `</script>` (rare but cheap to guard).
 */
function buildBootloaderScript(): string {
  const safeMorphdom = morphdomUmdSrc.replace(/<\/script/gi, '<\\/script');
  return safeMorphdom + '\n' + BOOTLOADER_TAIL;
}

let _cachedBootloader: string | null = null;
function getBootloaderHtml(): string {
  if (_cachedBootloader !== null) return _cachedBootloader;
  _cachedBootloader = `\n${WRAP_MARKER}\n<script>${buildBootloaderScript()}</script>\n`;
  return _cachedBootloader;
}

/**
 * Wrap an HTML document with the live-update bootloader. Idempotent —
 * if the marker is already present, returns the input unchanged.
 *
 * The bootloader is appended at the end of the document. Browsers
 * tolerate trailing scripts after `</body>` / `</html>` and execute
 * them after the rest of the document is parsed.
 */
export function wrapHtmlForLive(html: string): string {
  if (typeof html !== 'string' || html.length === 0) return html;
  if (html.includes(WRAP_MARKER)) return html;
  return SYSTEM_THEME_PREAMBLE + html + getBootloaderHtml();
}

export interface LiveIframeHandle {
  /**
   * Push an update into the iframe. If the bootloader is ready,
   * delivered via postMessage (smooth morph). Otherwise reassigns
   * srcdoc (one-time flash on first update).
   */
  update: (html: string) => void;
  /** Whether the bootloader has signalled `mycelium:ready`. */
  isLive: () => boolean;
  /** Tear down listeners. Call from $effect cleanup. */
  dispose: () => void;
}

/**
 * Manage parent-side state for a live iframe. The caller provides the
 * iframe element (via `bind:this`) and the initial HTML; subsequent
 * `handle.update(newHtml)` calls deliver smoothly when possible.
 *
 * Initial paint: caller must set `iframe.srcdoc = wrapHtmlForLive(html)`
 * BEFORE calling this — that lets the bootloader start loading. We
 * then attach the parent-side message listener.
 */
export function mountLiveIframe(iframeEl: HTMLIFrameElement): LiveIframeHandle {
  let live = false;

  function handleMessage(e: MessageEvent) {
    // Trust by source-window identity. event.origin is 'null' for
    // sandboxed iframes and not a reliable signal.
    if (e.source !== iframeEl.contentWindow) return;
    const data = e?.data;
    if (!data || typeof data !== 'object') return;
    if (data.type === 'mycelium:ready') {
      live = true;
    }
  }

  window.addEventListener('message', handleMessage);

  function update(html: string) {
    if (live && iframeEl.contentWindow) {
      try {
        iframeEl.contentWindow.postMessage(
          { type: 'mycelium:update', html },
          '*',
        );
        return;
      } catch {
        // Fall through to srcdoc swap — postMessage shouldn't fail in
        // practice, but we'd rather flash than drop the update.
      }
    }
    // Bootloader not ready yet (or postMessage failed). Reassign srcdoc
    // — the new bootloader will fire `mycelium:ready` after parse and
    // subsequent updates will go smooth.
    live = false; // new srcdoc means we await a fresh ready event
    iframeEl.srcdoc = wrapHtmlForLive(html);
  }

  function dispose() {
    window.removeEventListener('message', handleMessage);
  }

  return { update, isLive: () => live, dispose };
}
