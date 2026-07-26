// Mounts the REAL ChatFloat.svelte — real Svelte compiler → real jsdom → the REAL
// src/lib/chat-geometry.ts — drives REAL mousedown/mousemove/mouseup on the REAL resize grips,
// and prints one JSON line per PROBE for scripts/verify-chat-geometry.mjs to assert on.
//
// WHY A MOUNT, NOT A REGEX (D-065). The defect was never in the arithmetic — width and height
// were already computed from separate edges. It was in WHICH DOM PROPERTIES the two writers
// touched: the drag set `el.style.width/left/bottom/transform` plus the messages-box
// `style.height`, then CLEARED them on mouseup expecting Svelte to re-apply its reactive
// `style={…}` attribute. Svelte 5 routes that attribute through `set_style`
// (svelte/src/internal/client/dom/elements/style.js), which caches the last value on
// `dom[STYLE_CACHE]` and returns without touching the DOM when the newly-derived string is
// identical, and clearing inline properties mutates the attribute behind that cache.
// A width-only drag leaves `chatHeight` alone, so the messages-box string was
// unchanged, the write was skipped, and the element ended up with NO inline style at all.
// Measured in a real browser on the pre-fix tree: one right-edge drag took the chat from 720x624
// (messages 550) to 402x278 (messages 204) with `style="z-index: 9999;"` on the container — width,
// left, bottom and transform all gone, the chat flung to the viewport corner. Every symptom the
// operator reported (a width resize changing the height, the top going off-screen, the chat
// "disappearing") is that one mechanism.
//
// A source regex over ChatFloat.svelte cannot see any of it: the arithmetic reads correct in both
// trees. Only mounting the component and DRIVING the grips shows what the element is left holding.
// [[render-must-be-mounted-not-grepped]].
//
// FIDELITY NOTE — read before trusting a green. jsdom performs no layout, so
// `getBoundingClientRect()` is all zeros and `startResize`'s anchor math would be meaningless.
// This harness therefore installs a rect model on the chat container that resolves the SAME four
// custom properties the component's own stylesheet resolves (see the `.chat-container` rules in
// ChatFloat.svelte). What is REAL here: the component, the store, chat-geometry.ts, the event
// handlers, the DOM writes, localStorage, and the style attribute. What is MODELLED: the
// px-resolution of those custom properties. The model is deliberately dumb — it reads whatever the
// element holds — so an element that LOST its properties measures as broken, which is exactly the
// regression under test. Real-browser measurements of the same drags are recorded in the PR.
//
// Run: node --conditions browser portal-app/test/mount-chat-geometry.mjs   (cwd = portal-app)
// `--conditions browser` is REQUIRED — without it Node resolves svelte's SERVER exports map and
// mount() throws lifecycle_function_unavailable.
import { JSDOM } from 'jsdom';
import { build } from 'esbuild';
import { compile } from 'svelte/compiler';
import { readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';

const PROBE = process.env.PROBE || 'widthonly';
const VW = Number(process.env.VW || 1280);
const VH = Number(process.env.VH || 800);
const GEN = '.gen-mount-chat-geometry';
const COMPONENT = 'src/lib/components/chat/ChatFloat.svelte';

// The layout constants the component's stylesheet encodes. Kept here, not imported, so a change to
// the component's chrome shows up as a harness/product disagreement rather than silently tracking.
const INPUT_BAR = 60;
const GAP = 12;

const dom = new JSDOM('<!doctype html><html><body><div id="host"></div></body></html>', {
	url: 'http://localhost/',
	pretendToBeVisual: true,
});
for (const k of Object.getOwnPropertyNames(dom.window)) {
	if (k in globalThis) continue;
	try { globalThis[k] = dom.window[k]; } catch { /* getter-only global — jsdom's is fine */ }
}
globalThis.window = dom.window;
globalThis.document = dom.window.document;
Object.defineProperty(dom.window, 'innerWidth', { value: VW, writable: true, configurable: true });
Object.defineProperty(dom.window, 'innerHeight', { value: VH, writable: true, configurable: true });
if (!dom.window.matchMedia) {
	dom.window.matchMedia = () => ({ matches: false, addEventListener() {}, removeEventListener() {} });
} else {
	// Desktop: the resize grips only exist when `isMobile` is false.
	dom.window.matchMedia = () => ({ matches: false, addEventListener() {}, removeEventListener() {} });
}

globalThis.fetch = async () => new dom.window.Response(
	JSON.stringify({ providers: [], messages: [], taskModels: {}, agents: [], conversations: [] }),
	{ status: 200, headers: { 'Content-Type': 'application/json' } },
);

// Seed a poisoned/preset geometry BEFORE mount for the persistence probes.
if (process.env.LS_SIZE) dom.window.localStorage.setItem('mycelium-chat-size', process.env.LS_SIZE);
if (process.env.LS_POS) dom.window.localStorage.setItem('mycelium-chat-position', process.env.LS_POS);

const emit = (o) => console.log(JSON.stringify(o));
mkdirSync(GEN, { recursive: true });

writeFileSync(`${GEN}/app-environment.js`, 'export const browser = true;\nexport const dev = false;\nexport const building = false;\n');
writeFileSync(`${GEN}/onboarding-data-stub.js`, 'export function signalImportCompleted() {}\nexport const importSignal = { subscribe: (f) => { f(0); return () => {}; } };\n');

const compiled = compile(readFileSync(COMPONENT, 'utf8'), { generate: 'client', name: 'ChatFloat', css: 'injected' }).js.code;
writeFileSync(`${GEN}/ChatFloat.gen.js`, compiled);

// A wrapper that owns `visible` as reactive state, so ONE ChatFloat instance stays mounted for the
// whole probe while its prop flips — exactly what (app)/+layout.svelte does with
// `<ChatFloat visible={chatOpen} />`. Unmounting and remounting instead would make the D-073
// probes lie: the expand ticket is delivered to a LIVE component, and a remount would hide a real
// failure behind a fresh baseline.
const WRAPPER = `<script>
	import ChatFloat from './ChatFloat.gen.js';
	let { ctl } = $props();
	let visible = $state(false);
	ctl.setVisible = (v) => { visible = v; };
</script>
<ChatFloat {visible} />
`;
writeFileSync(`${GEN}/Wrapper.gen.js`, compile(WRAPPER, { generate: 'client', name: 'Wrapper', css: 'injected', filename: 'Wrapper.svelte' }).js.code);
writeFileSync(
	`${GEN}/entry.js`,
	"export { default as Wrapper } from './Wrapper.gen.js';\n"
	+ "export { chatMessages } from '$lib/stores/chat';\n"
	+ "export { navigationState } from '$lib/stores/navigation';\n",
);

await build({
	entryPoints: [`${GEN}/entry.js`],
	outfile: `${GEN}/bundle.js`,
	bundle: true, format: 'esm', platform: 'browser', target: 'es2022',
	external: ['svelte', 'svelte/*'],
	alias: {
		'$lib/stores/onboarding-data.svelte': resolve(GEN, 'onboarding-data-stub.js'),
		'$app/environment': resolve(GEN, 'app-environment.js'),
		$lib: resolve('src/lib'),
	},
	define: {
		'import.meta.env.VITE_VPS_NOISE_PUB': JSON.stringify(''),
		'import.meta.env.DEV': 'false',
		'import.meta.env.PROD': 'true',
	},
	logLevel: 'silent',
});

// ── The rect model (see FIDELITY NOTE). Resolves exactly what `.chat-container:not(.chat-mobile)`
// resolves: width from --chat-w capped at 100vw-32, left/bottom from --chat-left/--chat-bottom,
// and the messages box's height from --chat-h. An element that no longer carries those properties
// falls through to the CSS defaults — which is precisely how the pre-fix tree failed. ────────────
const px = (el, name, fallback) => {
	const raw = el.style.getPropertyValue(name).trim();
	const n = parseFloat(raw);
	return Number.isFinite(n) ? n : fallback;
};
function modelRects(container) {
	const expanded = !!container.querySelector('.messages-box');
	const width = Math.min(px(container, '--chat-w', 720), dom.window.innerWidth - 32);
	// A NEGATIVE --chat-h is not a short box: `height: min(-1450px, …)` is an invalid declaration
	// that a browser DROPS, so the element falls back to its content height. Modelling it as a
	// literal negative number would hide that, so it is reported as NaN and the gate treats a
	// non-finite messages height as broken.
	const rawH = px(container, '--chat-h', 550);
	const height = expanded ? (rawH < 0 ? Number.NaN : Math.min(rawH, dom.window.innerHeight - 32)) : 0;
	const bottomOffset = px(container, '--chat-bottom', 24);
	const leftRaw = container.style.getPropertyValue('--chat-left').trim();
	// `--chat-translate` is the fifth writer-shared property and the stylesheet resolves it as
	// `transform: translateX(var(--chat-translate, -50%))`. Modelling `left` without it was a hole
	// (independent review, finding 5): `--chat-left: 280px` with a stale `--chat-translate: -50%`
	// measures as left 280 here but renders at -180 in a browser — and a left/transform
	// disagreement is precisely the class of failure D-065 was.
	const translateRaw = (container.style.getPropertyValue('--chat-translate').trim() || '-50%');
	const anchorLeft = leftRaw === '' ? (dom.window.innerWidth - width) / 2
		: leftRaw.endsWith('%') ? (parseFloat(leftRaw) / 100) * dom.window.innerWidth
			: (parseFloat(leftRaw) || 0);
	const translatePx = translateRaw.endsWith('%')
		? (parseFloat(translateRaw) / 100) * width
		: (parseFloat(translateRaw) || 0);
	const left = anchorLeft + translatePx;
	const totalH = (expanded ? (Number.isFinite(height) ? height : 0) + GAP : 0) + INPUT_BAR;
	const bottom = dom.window.innerHeight - bottomOffset;
	return { left, right: left + width, width, bottom, top: bottom - totalH, height: totalH, messagesHeight: height, expanded };
}
function installRects(container) {
	container.getBoundingClientRect = () => {
		const r = modelRects(container);
		return { x: r.left, y: r.top, left: r.left, right: r.right, top: r.top, bottom: r.bottom, width: r.width, height: r.height, toJSON() { return this; } };
	};
	// The grips are absolutely positioned on the messages box / input bar. Their exact rects do
	// not matter: startResize reads only the CONTAINER's rect and the pointer deltas.
	for (const h of container.querySelectorAll('.resize-handle')) {
		h.getBoundingClientRect = () => ({ x: 0, y: 0, left: 0, right: 0, top: 0, bottom: 0, width: 6, height: 6, toJSON() { return this; } });
	}
}

const mouse = (type, x, y, target) => {
	const e = new dom.window.MouseEvent(type, { bubbles: true, cancelable: true, clientX: x, clientY: y });
	(target || dom.window).dispatchEvent(e);
};

try {
	const mod = await import(pathToFileURL(resolve(GEN, 'bundle.js')).href);
	const { mount, flushSync } = await import('svelte');
	const D = dom.window.document;
	const tick = (ms = 0) => new Promise((r) => setTimeout(r, ms));

	const ctl = {};
	mount(mod.Wrapper, { target: D.getElementById('host'), props: { ctl } });
	flushSync();

	const open = async (v) => { ctl.setVisible(v); flushSync(); await tick(30); flushSync(); };

	// The geometry probes need the chat OPEN on an empty thread — its auto-expand path.
	const geometryProbe = !['firstmessage', 'firstmessage_old', 'collapsehonoured'].includes(PROBE);
	if (geometryProbe) await open(true);

	const container = () => D.querySelector('.chat-container');
	if (geometryProbe && !container()) throw new Error('the chat container never rendered');
	if (container()) installRects(container());

	/** Drag a grip by (dx, dy) in `steps` real mousemoves, exactly as a user would. */
	async function drag(selector, dx, dy, steps = 6) {
		installRects(container());
		const grip = D.querySelector(selector);
		if (!grip) throw new Error(`no grip ${selector}`);
		const r = container().getBoundingClientRect();
		// Start the pointer on the edge the grip owns, so the deltas are meaningful.
		const x0 = selector.includes('left') ? r.left : selector.includes('right') ? r.right : (r.left + r.right) / 2;
		const y0 = selector.includes('top') ? r.top : selector.includes('bottom') ? r.bottom : (r.top + r.bottom) / 2;
		mouse('mousedown', x0, y0, grip);
		flushSync();
		installRects(container());
		for (let i = 1; i <= steps; i++) mouse('mousemove', x0 + (dx * i) / steps, y0 + (dy * i) / steps);
		mouse('mouseup', x0 + dx, y0 + dy);
		flushSync();
		await tick(5);
		flushSync();
		installRects(container());
	}

	function report(label) {
		const c = container();
		if (!c) return { label, gone: true };
		const r = modelRects(c);
		return {
			label,
			gone: false,
			// ⭐ THE PROOF the pre-fix tree could not produce: the style attribute still holds the
			// geometry. It regressed to exactly "z-index: 9999;" when the drag cleared it.
			styleAttr: c.getAttribute('style') || '',
			chatW: px(c, '--chat-w', NaN),
			chatH: px(c, '--chat-h', NaN),
			chatLeft: c.style.getPropertyValue('--chat-left').trim(),
			chatBottom: px(c, '--chat-bottom', NaN),
			expanded: r.expanded,
			// What a user would SEE.
			rect: { left: r.left, top: r.top, right: r.right, bottom: r.bottom, width: r.width },
			messagesHeight: r.messagesHeight,
			// The messages box must carry NO inline geometry — the property it used to own is
			// the one the drag cleared and Svelte never restored.
			messagesInlineStyle: (c.querySelector('.messages-box')?.getAttribute('style')) ?? null,
			ls: {
				size: dom.window.localStorage.getItem('mycelium-chat-size'),
				pos: dom.window.localStorage.getItem('mycelium-chat-position'),
			},
		};
	}

	const steps = [];
	const thrown = [];
	const origError = dom.window.console.error;
	dom.window.console.error = (...a) => { thrown.push(String(a[0])); origError.apply(dom.window.console, a); };

	if (PROBE === 'widthonly') {
		steps.push(report('start'));
		await drag('.input-resize-right', 150, 0);
		steps.push(report('right grip +150'));
		await drag('.input-resize-left', -120, 0);
		steps.push(report('left grip -120'));
		await drag('.input-resize-right', -400, 0);
		steps.push(report('right grip -400'));
	} else if (PROBE === 'topgrip') {
		steps.push(report('start'));
		await drag('.resize-top', 0, -2000);
		steps.push(report('top grip UP 2000'));
		await drag('.resize-top', 0, 300);
		steps.push(report('top grip DOWN 300'));
	} else if (PROBE === 'bottomgrip') {
		steps.push(report('start'));
		await drag('.input-resize-bottom', 0, -2000);
		steps.push(report('bottom grip UP 2000'));
		await drag('.input-resize-bottom', 0, 2000);
		steps.push(report('bottom grip DOWN 2000'));
	} else if (PROBE === 'fuzz') {
		steps.push(report('start'));
		const grips = ['.resize-top', '.resize-left', '.resize-right', '.resize-top-left', '.resize-top-right',
			'.input-resize-left', '.input-resize-right', '.input-resize-bottom', '.input-resize-bottom-left', '.input-resize-bottom-right'];
		let seed = 12345;
		const rnd = () => ((seed = (seed * 1103515245 + 12345) & 0x7fffffff) / 0x7fffffff) * 2 - 1;
		for (let i = 0; i < 120; i++) {
			await drag(grips[i % grips.length], Math.round(rnd() * 900), Math.round(rnd() * 900), 3);
			if (!container()) break;
		}
		steps.push(report('after 120 randomized drags'));
	} else if (PROBE === 'collapsedbottomgrip') {
		// The input bar's grips are rendered whenever the chat is on DESKTOP — expanded or not —
		// so `.input-resize-bottom` is draggable while collapsed, deriving a height for a box that
		// is not on screen. Independent review measured `--chat-h: -1450px` persisted as
		// `{"height":-1450}` here; a negative length is an invalid CSS declaration that the browser
		// drops, so the box falls back to its content height on the next expand.
		mod.chatMessages.set([
			{ id: 'm1', role: 'assistant', content: 'hello', timestamp: new Date().toISOString() },
		]);
		flushSync();
		await tick(20);
		flushSync();
		steps.push(report('start'));
		const closeBtn = D.querySelector('button[aria-label="Close chat"]');
		if (!closeBtn) throw new Error('no "Close chat" toggle');
		closeBtn.click();
		flushSync();
		await tick(20);
		flushSync();
		installRects(container());
		steps.push(report('collapsed'));
		await drag('.input-resize-bottom', 0, -2000);
		steps.push(report('collapsed, bottom grip UP 2000'));
		await drag('.input-resize-bottom', 0, 2000);
		steps.push(report('collapsed, bottom grip DOWN 2000'));
		const openBtn = D.querySelector('button[aria-label="View chat history"]');
		if (!openBtn) throw new Error('no "View chat history" toggle');
		openBtn.click();
		flushSync();
		await tick(30);
		flushSync();
		installRects(container());
		steps.push(report('re-expanded'));
	} else if (PROBE === 'viewportshrinkgrow') {
		// A viewport narrowing is TRANSIENT — a phone visit, a rotation, one Ctrl+ zoom, the iOS
		// URL bar. The clamp may render smaller, but overwriting the user's chosen size with the
		// smaller value is permanent damage: independent review measured 1280 → 390 → 1280 leaving
		// the chat stuck at 358px wide, persisted.
		steps.push(report('start @1280'));
		const setVw = (v) => {
			Object.defineProperty(dom.window, 'innerWidth', { value: v, writable: true, configurable: true });
			dom.window.dispatchEvent(new dom.window.Event('resize'));
			flushSync();
		};
		setVw(390);
		await tick(10);
		flushSync();
		installRects(container());
		steps.push(report('viewport 1280 → 390'));
		setVw(1280);
		await tick(10);
		flushSync();
		installRects(container());
		steps.push(report('viewport back to 1280'));
	} else if (PROBE === 'collapsedthenexpand') {
		// The clamp is asked for `expanded: isExpanded`, so while the chat is COLLAPSED (only the
		// input bar on screen) there is no messages box to leave room for and the anchor may sit
		// right at the top edge. Expanding then has to put the box SOMEWHERE — above an anchor
		// with no room above it. Collapsing, dragging to the top, and expanding again is the
		// sequence that finds it.
		// A non-empty thread, or the auto-expand ("expand if the thread is empty") re-opens the
		// chat the moment the collapse lands and the sequence can't be driven at all.
		mod.chatMessages.set([
			{ id: 'm1', role: 'assistant', content: 'hello', timestamp: new Date().toISOString() },
		]);
		flushSync();
		await tick(20);
		flushSync();
		steps.push(report('start'));
		const closeBtn = D.querySelector('button[aria-label="Close chat"]');
		if (!closeBtn) throw new Error('no "Close chat" toggle');
		closeBtn.click();
		flushSync();
		await tick(20);
		flushSync();
		installRects(container());
		steps.push(report('collapsed'));
		// Drag the collapsed chat to the very top of the viewport.
		const grab = D.querySelector('button[aria-label="Drag to move"]');
		if (!grab) throw new Error('no drag handle');
		const r0 = container().getBoundingClientRect();
		mouse('mousedown', r0.left + 20, r0.top + 20, grab);
		flushSync();
		installRects(container());
		for (let i = 1; i <= 8; i++) mouse('mousemove', r0.left + 20, r0.top + 20 - (2000 * i) / 8);
		mouse('mouseup', r0.left + 20, r0.top + 20 - 2000);
		flushSync();
		await tick(10);
		flushSync();
		installRects(container());
		steps.push(report('collapsed, dragged to the top'));
		// Re-expand.
		const openBtn = D.querySelector('button[aria-label="View chat history"]');
		if (!openBtn) throw new Error('no "View chat history" toggle to re-expand with');
		openBtn.click();
		flushSync();
		await tick(30);
		flushSync();
		installRects(container());
		steps.push(report('re-expanded'));
	} else if (PROBE === 'persisted') {
		// Nothing to drive — the assertion is what mount() made of LS_SIZE / LS_POS.
		steps.push(report('after mount with the seeded localStorage'));
	} else if (PROBE === 'windowresize') {
		steps.push(report('start'));
		await drag('.resize-top', 0, -2000);
		steps.push(report('grown tall'));
		Object.defineProperty(dom.window, 'innerHeight', { value: 420, writable: true, configurable: true });
		dom.window.dispatchEvent(new dom.window.Event('resize'));
		flushSync();
		await tick(10);
		flushSync();
		steps.push(report('viewport 800 → 420'));
	} else if (PROBE === 'firstmessage' || PROBE === 'firstmessage_old' || PROBE === 'collapsehonoured') {
		// D-073 — replay the onboarding order EXACTLY: the wizard POSTs the greeting, pulls it
		// into the store with loadHistory, and only THEN opens the chat. By that point the
		// thread is no longer empty, so ChatFloat's auto-expand ("expand if the thread is
		// empty") does not fire and the chat opens showing only its input bar.
		mod.chatMessages.set([
			{ id: 'greet-1', role: 'assistant', content: "I'm Ada. Who are you?", timestamp: new Date().toISOString() },
		]);
		flushSync();
		await tick(20);
		flushSync();
		// `visible` is what (app)/+layout.svelte passes down from navigationState.chatOpen.
		if (PROBE === 'firstmessage_old') mod.navigationState.setChatOpen(true);
		else mod.navigationState.openChatExpanded();
		await open(true);
		await tick(30);
		flushSync();
		const box = D.querySelector('.messages-box');
		const text = (box?.textContent || '').replace(/\s+/g, ' ').trim();
		steps.push({
			label: 'chat opened for the first message',
			messagesBoxRendered: !!box,
			greetingVisible: text.includes("I'm Ada"),
			visibleText: text.slice(0, 200),
		});

		if (PROBE === 'collapsehonoured') {
			// The user closes the chat, then another message arrives. It must STAY closed.
			const closeBtn = D.querySelector('button[aria-label="Close chat"]');
			if (!closeBtn) throw new Error('no "Close chat" toggle to collapse with');
			closeBtn.click();
			flushSync();
			await tick(20);
			flushSync();
			const collapsed = !D.querySelector('.messages-box');
			mod.chatMessages.set([
				{ id: 'greet-1', role: 'assistant', content: "I'm Ada. Who are you?", timestamp: new Date().toISOString() },
				{ id: 'later', role: 'assistant', content: 'a later message', timestamp: new Date().toISOString() },
			]);
			flushSync();
			await tick(30);
			flushSync();
			steps.push({
				label: 'user collapsed, then a later message arrived',
				collapsedAfterUserClick: collapsed,
				stillCollapsed: !D.querySelector('.messages-box'),
			});
		}
	} else {
		throw new Error(`unknown PROBE ${PROBE}`);
	}

	dom.window.console.error = origError;
	emit({ ok: true, probe: PROBE, vw: VW, vh: dom.window.innerHeight, steps, consoleErrors: thrown.slice(0, 5) });
	process.exit(0);
} catch (e) {
	emit({ ok: false, probe: PROBE, error: String(e?.stack || e) });
	process.exit(0);
}
