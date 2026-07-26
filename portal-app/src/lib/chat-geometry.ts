/**
 * chat-geometry — the ONE place the floating chat's size and position are bounded.
 *
 * D-065 ("Elio's bug"). Three failures shared one symptom — "resizing the width also changes the
 * height; when the height jumps up it can't be reduced and moves off-screen; sometimes the chat
 * disappears entirely":
 *
 *   1. COUPLING. Not in the arithmetic (width and height were already computed from separate
 *      edges) but in the RENDER: the resize drag wrote `el.style.width/left/bottom/transform` and
 *      `messagesBox.style.height` imperatively, then cleared them on mouseup and trusted Svelte to
 *      re-apply the reactive `style={…}` attribute. Svelte 5 routes that attribute through
 *      `set_style` (svelte/src/internal/client/dom/elements/style.js), which caches the last value
 *      on `dom[STYLE_CACHE]` and returns without touching the DOM when the newly-derived string is
 *      identical — and clearing the inline properties mutates the attribute behind that cache.
 *      (When it does write, it assigns `dom.style.cssText` wholesale, so any Svelte style write
 *      also wipes imperative properties absent from the reactive string.) A width-only drag never changes
 *      `chatHeight`, so the messages-box style string was unchanged, the write was skipped, and the
 *      element was left with NO height at all: 550px collapsed to its content height. Measured in a
 *      real browser: one right-edge drag took the chat from 720x624 (messages 550) to 402x278
 *      (messages 204) with `style="z-index: 9999;"` — width, left, bottom and transform all gone.
 *      That stripped attribute IS the "crash / the chat disappears" report: the container loses its
 *      anchoring and jumps to the viewport corner.
 *
 *      The fix is structural, in ChatFloat.svelte: every geometry value now travels as a CSS custom
 *      property on ONE element (the container). The drag and the reactive render write the SAME
 *      four properties, so a skipped write is harmless and nothing is ever cleared.
 *
 *   2. NO BOUNDS. `maxHeight = innerHeight - 100` bounded the height against the whole viewport,
 *      not against the space actually above the chat's input bar — so a top-edge drag could put the
 *      chat's top (and with it the header and the `.resize-top` grip) off-screen, where it can no
 *      longer be grabbed and reduced. The bottom-edge branch had no clamp at all on the input-bar
 *      anchor, so it could drive it negative and push the whole chat off the top of the screen.
 *      Neither the persisted size nor the persisted position was validated against the other, so a
 *      bad pair survived a reload.
 *
 * This module is pure and DOM-free so the gate can hammer it directly. Everything that can move the
 * chat — the resize drag, the move drag, the localStorage restore, and the window-resize handler —
 * goes through `clampChatGeometry`, which is total: any input, including NaN/Infinity/garbage from
 * localStorage, yields a geometry whose top edge, input bar and a grabbable horizontal strip are
 * all inside the viewport.
 */

/** Narrowest the chat may be dragged. */
export const CHAT_MIN_W = 320;
/** Widest the chat may be dragged. */
export const CHAT_MAX_W = 1200;
/** Shortest messages area, when the viewport has room for it. */
export const CHAT_MIN_H = 200;
/**
 * Absolute floor for the messages area while the chat is expanded. Without it, dragging the bottom
 * grip up drives the input-bar anchor to the viewport top and the messages box collapses to a
 * couple of pixels — measured at 2px before this floor existed. Technically still recoverable, but
 * indistinguishable from the "the chat disappeared" report, so it is treated as the same defect.
 */
export const CHAT_MIN_H_HARD = 120;
/** Minimum gap between the chat and the viewport edges. */
export const CHAT_EDGE = 16;
/**
 * Minimum gap above the chat's top edge. Sized so the 6px `.resize-top` grip (offset -3px) is
 * fully on-screen and grabbable — the whole point of the clamp is that an over-tall chat can
 * always be pulled back down.
 */
export const CHAT_TOP_MARGIN = 16;
/** The input-bar height the position anchor is defined against (position.y = input-bar top). */
export const CHAT_INPUT_BAR = 60;
/** The container's `gap-3` between the messages box and the input bar. */
export const CHAT_GAP = 12;
/** Horizontal strip that must stay on-screen so the chat can always be dragged back. */
export const CHAT_MIN_VISIBLE = 60;

export interface Viewport {
	vw: number;
	vh: number;
}

export interface ChatGeometry {
	/** Requested messages-box width (before the viewport `min()`). */
	width: number;
	/** Requested messages-box height (before the viewport `min()`). */
	height: number;
	/** Left edge, viewport coords. */
	x: number;
	/** Input-bar TOP, viewport coords. */
	y: number;
}

/** Coerce anything (localStorage, a half-finished drag, `undefined`) to a finite number. */
export function finite(v: unknown, fallback: number): number {
	const n = typeof v === 'number' ? v : Number(v);
	return Number.isFinite(n) ? n : fallback;
}

const clamp = (lo: number, hi: number, v: number) => (hi < lo ? lo : Math.max(lo, Math.min(hi, v)));

/** A sane viewport even if the caller hands us a detached/zero window. */
export function safeViewport(vp: Partial<Viewport> | null | undefined): Viewport {
	return {
		vw: Math.max(1, finite(vp?.vw, 1024)),
		vh: Math.max(1, finite(vp?.vh, 768)),
	};
}

/** Widest the chat may be in this viewport. */
export function maxChatWidth(vp: Viewport): number {
	return Math.max(CHAT_MIN_W, Math.min(CHAT_MAX_W, vp.vw - 2 * CHAT_EDGE));
}

/** What the container's `width: min(var(--chat-w), calc(100vw - 32px))` actually resolves to. */
export function renderedChatWidth(width: number, vp: Viewport): number {
	return Math.max(1, Math.min(width, vp.vw - 2 * CHAT_EDGE));
}

/**
 * The horizontal strip that must stay on-screen. Normally `CHAT_MIN_VISIBLE`; on a viewport
 * narrower than that the requirement degenerates to the whole viewport, because demanding 60px of
 * visibility in a 40px window is unsatisfiable and would make the clamp claim failure forever.
 */
export function visibleStrip(vp: Viewport): number {
	return Math.min(CHAT_MIN_VISIBLE, vp.vw);
}

/** Lowest the input bar's top may sit (keeps the bar itself fully on-screen). */
export function maxInputBarTop(vp: Viewport): number {
	return Math.max(CHAT_EDGE, vp.vh - CHAT_INPUT_BAR - CHAT_EDGE);
}

/**
 * Highest the input bar's top may sit. While the chat is expanded this leaves room for at least
 * `CHAT_MIN_H_HARD` of messages above it, so the box can never be squeezed to nothing.
 */
export function minInputBarTop(vp: Viewport, expanded = true): number {
	if (!expanded) return CHAT_EDGE;
	return Math.min(maxInputBarTop(vp), CHAT_TOP_MARGIN + CHAT_GAP + CHAT_MIN_H_HARD);
}

/**
 * Tallest messages box whose TOP edge still clears `CHAT_TOP_MARGIN`, given where the input bar
 * sits. This is the bound the old `innerHeight - 100` was missing: height is only meaningful
 * relative to the chat's own vertical position, never to the bare viewport height.
 */
export function maxChatHeight(inputBarTop: number, vp: Viewport): number {
	const room = Math.min(inputBarTop, maxInputBarTop(vp)) - CHAT_GAP - CHAT_TOP_MARGIN;
	return Math.max(0, room);
}

/**
 * The one clamp. Total on its inputs; idempotent (clamping a clamped geometry is a no-op).
 *
 * `expanded` is false when only the input bar is rendered (the messages box is collapsed away),
 * in which case the height is carried through untouched — there is nothing on screen to bound.
 *
 * Width and height are decided INDEPENDENTLY: no width input can change the returned height, and
 * no height input can change the returned width. That independence is what D-065's first failure
 * is about, so it is asserted directly by the gate.
 */
export function clampChatGeometry(
	g: Partial<ChatGeometry> | null | undefined,
	viewport: Partial<Viewport> | null | undefined,
	opts: { expanded?: boolean; prefer?: 'position' | 'size' } = {},
): ChatGeometry {
	const vp = safeViewport(viewport);
	const expanded = opts.expanded !== false;
	// Which of the two the caller is holding fixed when they conflict. A RESIZE (and a restore
	// from localStorage) holds the position and lets the size yield; a MOVE holds the size and
	// lets the travel stop short. Either way the top edge ends up on-screen.
	const prefer = opts.prefer === 'size' ? 'size' : 'position';

	// ── width ── depends on the width input and the viewport only.
	const width = clamp(CHAT_MIN_W, maxChatWidth(vp), finite(g?.width, 720));

	const yMax = maxInputBarTop(vp);
	let y = clamp(minInputBarTop(vp, expanded), yMax, finite(g?.y, vp.vh - 24 - CHAT_INPUT_BAR));
	// ── height ── depends on the height input, y, and the viewport. Never on width.
	let height = finite(g?.height, 550);

	// The tallest a messages box may be anywhere in this viewport, independent of where the chat
	// currently sits. Used as the bound while COLLAPSED, when there is no on-screen box to measure
	// against but the value is still headed for `--chat-h` and for localStorage.
	const hardMax = Math.max(0, yMax - CHAT_GAP - CHAT_TOP_MARGIN);
	const hFloor = Math.min(CHAT_MIN_H_HARD, hardMax);

	if (!expanded) {
		// ⚠️ A COLLAPSED chat still has a height — it is committed to state, written to
		// `--chat-h`, and persisted. Leaving it unbounded here was a real defect: the input bar's
		// `.input-resize-bottom` grip is rendered whenever the chat is on desktop, expanded or
		// not, and while collapsed it derived its height from an anchor for a box that is not on
		// screen. Measured: collapse, then drag that grip up 2000px ⇒ `--chat-h: -1450px`
		// persisted as `{"height":-1450}`. A negative length makes the stylesheet's
		// `height: min(var(--chat-h), …)` an INVALID declaration, which a browser drops — the box
		// falls back to its content height, which is D-065's original 550→204 collapse arriving by
		// another route. Found by independent adversarial review of this fix.
		height = clamp(hFloor, hardMax, height);
	} else if (prefer === 'size') {
		// Keep the height; stop the chat travelling far enough up to push its own top off.
		height = clamp(Math.min(CHAT_MIN_H, hardMax), hardMax, height);
		y = clamp(Math.min(yMax, Math.max(CHAT_EDGE, height + CHAT_GAP + CHAT_TOP_MARGIN)), yMax, y);
	} else {
		const hMax = maxChatHeight(y, vp);
		// On a viewport too short for CHAT_MIN_H, the floor collapses with it rather than
		// overflowing — an unreachable top is the failure we are removing, not a shorter chat.
		height = clamp(Math.min(CHAT_MIN_H, hMax), hMax, height);
	}

	// ── x ── the rendered width (post viewport `min()`) decides how far it may overhang. On a
	// viewport narrower than the strip itself the rule degenerates to "at least all of it", which
	// is the most a 40px-wide window can offer.
	const renderedW = renderedChatWidth(width, vp);
	const strip = visibleStrip(vp);
	const x = clamp(
		-(renderedW - strip),
		vp.vw - strip,
		finite(g?.x, Math.round((vp.vw - renderedW) / 2)),
	);

	return { width, height, x, y };
}

/** True when the geometry is fully reachable: top on-screen, input bar on-screen, grabbable strip. */
export function isChatReachable(
	g: ChatGeometry,
	viewport: Viewport,
	opts: { expanded?: boolean } = {},
): boolean {
	const vp = safeViewport(viewport);
	const expanded = opts.expanded !== false;
	if (!Number.isFinite(g.x) || !Number.isFinite(g.y) || !Number.isFinite(g.width) || !Number.isFinite(g.height)) {
		return false;
	}
	if (g.y < minInputBarTop(vp, expanded) || g.y > maxInputBarTop(vp)) return false;
	if (expanded && g.y - CHAT_GAP - g.height < 0) return false;
	const renderedW = renderedChatWidth(g.width, vp);
	const strip = visibleStrip(vp);
	if (g.x + renderedW < strip) return false;
	if (g.x > vp.vw - strip) return false;
	return true;
}
