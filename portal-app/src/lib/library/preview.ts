// Library file-preview helpers (R4-FILEPREVIEW / R4-SVGRENDER).
//
// ⚠️ SECURITY-SENSITIVE — renders UNTRUSTED file content in the portal origin.
// SVG can carry <script>/onload/foreignObject (stored-XSS) and external refs
// (phone-home / tracking). The rules here:
//   • SVG is ALWAYS sanitized here AND rendered via <img> (a blob/data URL) at
//     the call site — <img>-loaded SVG cannot execute scripts in ANY browser,
//     so script execution is neutralized regardless of sanitizer completeness;
//     sanitizeSvg additionally strips scripts, event handlers, and external
//     refs so a malicious SVG cannot phone home either.
//   • PDF/HTML are rendered in a sandboxed <iframe> (opaque origin, no
//     allow-same-origin) at the call site — never inlined with {@html}.
// Never pass raw file content to {@html} in the portal origin.

/** Kinds the Library viewer dispatches on. */
export type PreviewKind = 'text' | 'html' | 'svg' | 'image' | 'pdf' | 'video' | 'audio' | 'other';

const IMAGE_EXT = /\.(png|jpe?g|gif|webp|bmp|avif|heic|heif|ico)$/i;
const VIDEO_EXT = /\.(mp4|mov|webm|m4v|ogv)$/i;
const AUDIO_EXT = /\.(mp3|m4a|wav|ogg|flac|aac)$/i;

/** True when the doc is an HTML document (path or a sniffed full-HTML body). */
export function isHtmlDoc(path?: string | null, content?: string | null): boolean {
	if (path && /\.html?$/i.test(path)) return true;
	if (content) {
		const head = content.trimStart().slice(0, 100).toLowerCase();
		if (head.startsWith('<!doctype html') || head.startsWith('<html')) return true;
	}
	return false;
}

/** True when the doc is an SVG (by path, or a body that starts with an <svg>). */
export function isSvgDoc(path?: string | null, content?: string | null): boolean {
	if (path && /\.svg$/i.test(path)) return true;
	if (content) {
		const head = content.trimStart().slice(0, 300).toLowerCase();
		if (head.startsWith('<svg')) return true;
		if (head.startsWith('<?xml') && head.includes('<svg')) return true;
	}
	return false;
}

/** Classify a filename/mime for the media modal + doc dispatch. */
export function fileKind(name?: string | null, mime?: string | null): PreviewKind {
	const n = (name || '').toLowerCase();
	const m = (mime || '').toLowerCase();
	if (m === 'application/pdf' || /\.pdf$/i.test(n)) return 'pdf';
	if (m === 'image/svg+xml' || /\.svg$/i.test(n)) return 'svg';
	if (m.startsWith('image/') || IMAGE_EXT.test(n)) return 'image';
	if (m.startsWith('video/') || VIDEO_EXT.test(n)) return 'video';
	if (m.startsWith('audio/') || AUDIO_EXT.test(n)) return 'audio';
	if (m === 'text/html' || /\.html?$/i.test(n)) return 'html';
	return 'other';
}

// Elements that can execute script, embed HTML, or run out-of-band behavior.
const SVG_FORBIDDEN_TAGS = new Set([
	'script', 'foreignobject', 'iframe', 'object', 'embed', 'audio', 'video',
	'handler', 'listener', 'set', 'animate', 'animatemotion', 'animatetransform',
]);
// Attributes that reference an external URL and could phone home.
const URL_ATTRS = new Set(['href', 'xlink:href', 'src', 'from', 'to', 'values', 'begin', 'end']);

/**
 * Sanitize an SVG string for safe rendering. Removes script-bearing elements,
 * every on*-event handler, javascript: URLs, and external references (only
 * in-document `#id` fragment refs survive). Returns null on a parse error, a
 * non-SVG root, or when the environment has no DOMParser (SSR).
 *
 * Defense-in-depth only — the caller MUST still render the result via <img>
 * (data/blob URL), never {@html}.
 */
export function sanitizeSvg(svg: string): string | null {
	if (typeof window === 'undefined' || typeof DOMParser === 'undefined' || !svg) return null;
	let doc: Document;
	try { doc = new DOMParser().parseFromString(svg, 'image/svg+xml'); } catch { return null; }
	if (doc.getElementsByTagName('parsererror').length) return null;
	const root = doc.documentElement;
	if (!root || root.tagName.toLowerCase() !== 'svg') return null;

	const scrub = (el: Element) => {
		const tag = el.tagName.toLowerCase();
		if (SVG_FORBIDDEN_TAGS.has(tag)) { el.remove(); return; }
		// <style> can @import / url() external resources — drop such rules wholesale.
		if (tag === 'style' && el.textContent && /@import|url\s*\(|javascript:|expression\s*\(/i.test(el.textContent)) {
			el.textContent = '';
		}
		for (const attr of Array.from(el.attributes)) {
			const name = attr.name.toLowerCase();
			const val = attr.value || '';
			if (name.startsWith('on')) { el.removeAttribute(attr.name); continue; }
			if (/javascript:|data:text\/html|expression\s*\(/i.test(val)) { el.removeAttribute(attr.name); continue; }
			if (name === 'style' && /url\s*\(|expression\s*\(|javascript:/i.test(val)) { el.removeAttribute(attr.name); continue; }
			// Presentation attributes (fill/stroke/filter/mask/clip-path/marker-*/…)
			// can carry an EXTERNAL url() that fetches off-box. Keep only local
			// url(#id) fragment refs; strip any url() whose target isn't a #fragment.
			if (/url\s*\(/i.test(val) && /url\s*\(\s*['"]?\s*(?!#)[^\s)]/i.test(val)) { el.removeAttribute(attr.name); continue; }
			if (URL_ATTRS.has(name)) {
				const v = val.trim();
				// Keep only same-document fragment references (#id); strip everything else.
				if (!v.startsWith('#')) el.removeAttribute(attr.name);
			}
		}
		for (const child of Array.from(el.children)) scrub(child);
	};
	scrub(root);

	try { return new XMLSerializer().serializeToString(root); } catch { return null; }
}

/** A sanitized SVG → a self-contained data URL for `<img src>` (null if unsafe). */
export function svgToDataUrl(svg: string): string | null {
	const clean = sanitizeSvg(svg);
	if (!clean) return null;
	// Plain (charset-less) data URL + full percent-encoding — the most broadly
	// compatible <img> SVG form (encodeURIComponent escapes #, &, etc. so the
	// payload can't truncate the URL or introduce a fragment).
	return `data:image/svg+xml,${encodeURIComponent(clean)}`;
}
