// open-external.ts — open a URL in the user's REAL system browser (D-010).
//
// THE BUG THIS FIXES. The app's webview loads a REMOTE origin
// (http://127.0.0.1:8787) inside a Tauri WKWebView. In that context
// `window.open(url, '_blank')` is swallowed — the OS browser never opens, the call
// returns null, and every sign-in surface fell straight to its "couldn't open a
// browser — copy the link" fallback. The operator's report ("why can't the app open
// a browser?") is exactly that: the DEGRADED copy-paste path was the ONLY path.
//
// THE FIX. Tauri v2 ships an `opener` plugin whose `open_url` command hands the URL
// to the OS default browser from the native side (main.rs registers
// tauri_plugin_opener::init(); capabilities/default.json grants opener:allow-open-url
// + opener:allow-default-urls for the remote origin). We invoke it RAW — the webview
// is a remote origin with no bundled @tauri-apps/api, so we reach the IPC directly
// via __TAURI_INTERNALS__.invoke, the same pattern the theme strip uses
// (src/lib/stores/theme.ts). The command name + arg key are the plugin's contract:
// `plugin:opener|open_url` with `{ url }`.
//
// FAIL-SAFE LADDER. If the plugin is absent (dev in a plain browser), rejects
// (permission/scope misconfig), or we're not in Tauri at all, we fall back to
// window.open, and only report failure when BOTH are unavailable — so the caller's
// first-class copy-paste affordance still takes over. A wrong capability therefore
// degrades to TODAY's behaviour, never worse.
//
// @returns true iff a browser was opened; false ⇒ show the copy-paste path.
export async function openExternal(url: string): Promise<boolean> {
	if (typeof window === 'undefined' || !url) return false;

	// 1) Tauri opener plugin — the real system browser.
	try {
		const invoke = (window as any).__TAURI_INTERNALS__?.invoke;
		if (invoke) {
			// Resolves on a successful hand-off to the OS; rejects if the plugin/permission
			// is missing → caught, and we fall through to the web path.
			await invoke('plugin:opener|open_url', { url });
			return true;
		}
	} catch {
		/* not registered / permission denied / scope mismatch → try window.open */
	}

	// 2) Plain browser (dev / non-Tauri). A Tauri webview can return null here.
	try {
		const w = window.open(url, '_blank', 'noopener,noreferrer');
		if (w) return true;
	} catch {
		/* both paths unavailable */
	}

	return false;
}
