<script lang="ts">
	import Tab from './Tab.svelte';
	import { get } from 'svelte/store';
	import { REGISTRY } from '$lib/workspace/registry';
	import { workspace, tabDrag, type DropEdge } from '$lib/workspace/store';
	import type { Tab as TabT } from '$lib/workspace/types';

	let { tabs, activeTabId, paneId, onfocus, onclose, onopen, onsplit, onreorder }: {
		tabs: TabT[];
		activeTabId: string | null;
		paneId: string;
		onfocus: (id: string) => void;
		onclose: (id: string) => void;
		onopen: (viewId: string) => void;
		onsplit?: () => void;
		onreorder: (tabId: string, toIndex: number) => void;
	} = $props();

	let menuOpen = $state(false);
	const sections = Object.entries(REGISTRY).map(([id, v]) => ({ id, title: v.title }));

	function pick(id: string) {
		menuOpen = false;
		onopen(id);
	}

	// ── Drag-to-reorder (pointer-based; the app has no HTML5 DnD / shared drag
	// util). Move the dragged tab one slot whenever the pointer crosses a
	// neighbour's midpoint. <5px travel = a click (focus); past it = a drag, whose
	// trailing click we swallow so it doesn't also focus.
	let tabsEl = $state<HTMLDivElement | null>(null);
	let draggingId = $state<string | null>(null);
	let dragStartX = 0;
	let started = false;
	let justDragged = false;
	let dragEl: HTMLElement | null = null;
	let dragPointerId = -1;
	let dragStartY = 0;
	const preventSelect = (e: Event) => e.preventDefault();

	function onPointerDown(e: PointerEvent) {
		if (e.button !== 0) return;
		const target = e.target as HTMLElement;
		if (target.closest('.tab-close')) return;            // closing, not dragging
		const el = target.closest('[data-tab-id]') as HTMLElement | null;
		if (!el) return;
		draggingId = el.dataset.tabId ?? null;
		dragStartX = e.clientX;
		dragStartY = e.clientY;
		started = false;
		// Suppress text selection for the WHOLE press (not just after a threshold) — a
		// downward/diagonal pull was selecting the page instead of starting a drag.
		document.addEventListener('selectstart', preventSelect);
		document.body.style.userSelect = 'none';
		// Claim the pointer so the scrollable strip / WKWebView can't reinterpret the
		// drag as a scroll. (The SplitPane divider drag is reliable because its target
		// owns the gesture; this delegated drag needs the capture.)
		dragEl = el;
		dragPointerId = e.pointerId;
		try { el.setPointerCapture(e.pointerId); } catch { /* unsupported */ }
		window.addEventListener('pointermove', onPointerMove);
		window.addEventListener('pointerup', onPointerUp);
		window.addEventListener('pointercancel', onPointerUp);
	}
	function onPointerMove(e: PointerEvent) {
		if (draggingId == null || !tabsEl) return;
		if (!started) {
			if (Math.abs(e.clientX - dragStartX) < 5 && Math.abs(e.clientY - dragStartY) < 5) return;
			started = true;
			document.body.style.cursor = 'grabbing';
			tabDrag.set({ tabId: draggingId, fromPaneId: paneId, overPaneId: null, edge: null });
		}
		// Over our own tab strip → reorder within it (horizontal midpoint crossing).
		const sr = tabsEl.getBoundingClientRect();
		if (e.clientX >= sr.left && e.clientX <= sr.right && e.clientY >= sr.top && e.clientY <= sr.bottom) {
			tabDrag.update((d) => (d ? { ...d, overPaneId: null, edge: null } : d));
			const els = Array.from(tabsEl.querySelectorAll<HTMLElement>('[data-tab-id]'));
			const from = els.findIndex((x) => x.dataset.tabId === draggingId);
			if (from < 0) return;
			if (from < els.length - 1) {
				const r = els[from + 1].getBoundingClientRect();
				if (e.clientX > r.left + r.width / 2) return onreorder(draggingId, from + 1);
			}
			if (from > 0) {
				const r = els[from - 1].getBoundingClientRect();
				if (e.clientX < r.left + r.width / 2) return onreorder(draggingId, from - 1);
			}
			return;
		}
		// Over a pane body → an edge zone (split) or the centre (merge into that pane).
		const paneEl = (document.elementFromPoint(e.clientX, e.clientY) as HTMLElement | null)?.closest('[data-pane-id]') as HTMLElement | null;
		if (!paneEl) { tabDrag.update((d) => (d ? { ...d, overPaneId: null, edge: null } : d)); return; }
		const r = paneEl.getBoundingClientRect();
		const fx = (e.clientX - r.left) / r.width;
		const fy = (e.clientY - r.top) / r.height;
		const dl = fx, dr = 1 - fx, dt = fy, db = 1 - fy;
		const m = Math.min(dl, dr, dt, db);
		const edge: DropEdge = m >= 0.28 ? 'center' : m === dl ? 'left' : m === dr ? 'right' : m === dt ? 'top' : 'bottom';
		tabDrag.set({ tabId: draggingId, fromPaneId: paneId, overPaneId: paneEl.dataset.paneId ?? null, edge });
	}
	function onPointerUp() {
		window.removeEventListener('pointermove', onPointerMove);
		window.removeEventListener('pointerup', onPointerUp);
		window.removeEventListener('pointercancel', onPointerUp);
		document.removeEventListener('selectstart', preventSelect);
		if (dragEl && dragPointerId >= 0) { try { dragEl.releasePointerCapture(dragPointerId); } catch { /* already released */ } }
		dragEl = null;
		dragPointerId = -1;
		const d = get(tabDrag);
		if (started && d && d.overPaneId && d.edge) workspace.moveTabToEdge(d.tabId, d.overPaneId, d.edge);
		tabDrag.set(null);
		if (started) {
			document.body.style.cursor = '';
			justDragged = true;                              // swallow the trailing click
			setTimeout(() => (justDragged = false), 0);
		}
		document.body.style.userSelect = '';
		draggingId = null;
		started = false;
	}
	function onClickCapture(e: MouseEvent) {
		if (justDragged) { e.preventDefault(); e.stopPropagation(); }
	}
</script>

<div class="tab-strip" role="tablist">
	<div class="tabs" bind:this={tabsEl} onpointerdown={onPointerDown} onclickcapture={onClickCapture}>
		{#each tabs as tab (tab.id)}
			<Tab
				{tab}
				active={tab.id === activeTabId}
				dragging={tab.id === draggingId}
				onfocus={() => onfocus(tab.id)}
				onclose={() => onclose(tab.id)}
			/>
		{/each}
	</div>

	<div class="actions">
		<div class="new-wrap">
			<button class="strip-btn" title="Open a view" aria-label="Open a view" aria-haspopup="menu" aria-expanded={menuOpen} onclick={() => (menuOpen = !menuOpen)}>+</button>
			{#if menuOpen}
				<button class="menu-backdrop" tabindex="-1" aria-label="Close menu" onclick={() => (menuOpen = false)}></button>
				<div class="menu" role="menu">
					{#each sections as s}
						<button class="menu-item" role="menuitem" onclick={() => pick(s.id)}>{s.title}</button>
					{/each}
				</div>
			{/if}
		</div>
		{#if onsplit}
			<button class="strip-btn split" title="Split this pane" aria-label="Split this pane" onclick={onsplit}>
				<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
					<rect x="3" y="4" width="18" height="16" rx="1.5" /><line x1="12" y1="4" x2="12" y2="20" />
				</svg>
			</button>
		{/if}
	</div>
</div>

<style>
	.tab-strip {
		display: flex; align-items: stretch; height: 36px; min-height: 36px;
		background: var(--color-surface); border-bottom: 1px solid var(--color-border);
	}
	.tabs { display: flex; overflow-x: auto; scrollbar-width: none; flex: 1; min-width: 0; }
	.tabs::-webkit-scrollbar { display: none; }
	.actions { display: flex; align-items: stretch; flex-shrink: 0; }
	.new-wrap { position: relative; display: flex; align-items: stretch; }
	.strip-btn {
		flex-shrink: 0; width: 34px; border: none; background: none; cursor: pointer;
		color: var(--color-text-tertiary); font-size: 1.15rem; line-height: 1;
		display: flex; align-items: center; justify-content: center;
	}
	.strip-btn.split { font-size: 1rem; }
	.strip-btn:hover { color: var(--color-text-primary); background: var(--color-elevated); }
	.menu-backdrop { position: fixed; inset: 0; z-index: 40; background: transparent; border: none; cursor: default; }
	.menu {
		position: absolute; top: 38px; right: 4px; z-index: 50; min-width: 160px;
		background: var(--color-elevated); border: 1px solid var(--color-border);
		border-radius: var(--radius-md, 8px); box-shadow: var(--shadow-lg, 0 10px 30px rgba(0,0,0,0.4));
		padding: 4px; display: flex; flex-direction: column;
	}
	.menu-item {
		text-align: left; padding: 7px 10px; border: none; background: none; cursor: pointer;
		color: var(--color-text-primary); font-size: 0.82rem; border-radius: 6px;
	}
	.menu-item:hover { background: var(--color-surface); }
</style>
