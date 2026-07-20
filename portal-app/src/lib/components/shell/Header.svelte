<script lang="ts">
	import { onMount } from 'svelte';
	import { browser } from '$app/environment';
	import { navigationState } from '$lib/stores/navigation';
	import { sidebarWidth } from '$lib/stores/sidebar';
	import { theme } from '$lib/stores/theme';
	import { viewLabel } from '$lib/nav/config';
	import { workspace } from '$lib/workspace/store';
	import TabStrip from '$lib/components/workspace/TabStrip.svelte';
	import type { WsNode, LeafPane } from '$lib/workspace/types';
	import { activity, startActivityPolling, fmtAgo, isFreshError } from '$lib/stores/activity';
	import StatusPopover from './StatusPopover.svelte';

	// One consolidated activity indicator (next to chat) — ALWAYS present and always
	// clickable. A round glass "orb": grey when idle, green while any work runs
	// (chat inference, embedding, mapping, narration — local or via API), red when
	// the last job failed. Click opens the §3.8 STATUS POPOVER (StatusPopover.svelte):
	// the central account-status location (design D5/D10/D11) — the honest state rows
	// (vault · data · processing · embedding · labeling · understanding · transcription
	// · intelligence · mindscape) plus the live job list and what ran last.
	let activityOpen = $state(false);
	const active = $derived($activity.active);
	const recent = $derived($activity.recent);
	const busy = $derived(active.length > 0);
	// Red only when idle AND the most recent finished job failed (recently) — a new
	// success rolls it back to grey on its own. While busy, green wins.
	const errored = $derived(!busy && isFreshError(recent[0]));
	const orbState = $derived(busy ? 'busy' : errored ? 'error' : 'idle');
	const lastJob = $derived(recent[0] ?? null);
	const orbTitle = $derived(
		busy ? `Working — ${active.length} ${active.length === 1 ? 'process' : 'processes'}`
			: errored ? `Last job failed${lastJob ? ` — ${lastJob.stage}` : ''}`
			: lastJob ? `Idle — last: ${lastJob.stage} ${fmtAgo(lastJob.finishedAt)}`
			: 'Idle',
	);
	onMount(() => startActivityPolling());

	// Teleport a node to <body> so a `fixed` overlay escapes the header's stacking
	// context + `backdrop-filter` containing block + `overflow-hidden` clip. Without
	// this the activity panel is trapped at the header's z-10 and page navs/tooltips
	// (z-30…z-1000) paint over it. In <body> it's viewport-relative at its own z-index.
	function portal(node: HTMLElement, target: string = 'body') {
		const dest = (browser && document.querySelector(target)) || null;
		if (dest) dest.appendChild(node);
		return { destroy() { node.remove(); } };
	}

	const currentView = $derived($navigationState.primaryView);

	// Hoist the workspace tabs into the header row (one bar instead of two) for the
	// common single-pane case. When the workspace is split into multiple panes, each
	// pane keeps its own in-pane strip (Pane.svelte) and the header shows none.
	function collectLeaves(n: WsNode): LeafPane[] {
		return n.kind === 'leaf' ? [n] : [...collectLeaves(n.children[0]), ...collectLeaves(n.children[1])];
	}
	const onlyPane: LeafPane | null = $derived.by(() => {
		const leaves = collectLeaves($workspace.root);
		return leaves.length === 1 ? leaves[0] : null;
	});
	const chatOpen = $derived($navigationState.chatOpen);
	const currentTheme = $derived($theme);

	// R4-SHELLCHROME: the header's left cell tracks the sidebar column. When the
	// sidebar is open the cell takes the shared sidebar width (so its right border
	// aligns with the sidebar's border-r into one continuous divider); when it's
	// collapsed there is no column, so the cell shrinks to just the hamburger and
	// the divider drops away.
	const sidebarShown = $derived($navigationState.sidebarOpen);

	// In the native Mac shell the window has no title bar (overlay style), so the
	// header doubles as the drag strip. `data-tauri-drag-region` is the standard
	// mechanism; the mousedown fallback covers the case where the server-served
	// page (external URL) doesn't get the attribute handler wired.
	let isTauri = $state(false);
	onMount(() => { if (browser) isTauri = !!(window as any).__TAURI__ || !!(window as any).__TAURI_INTERNALS__; });

	// ── R4-SWIPEBACK: two-finger horizontal swipe → app-level Back ──────────────────────────────
	// The workspace authors its own URL with replaceState, so in-app view switches leave NO browser
	// history entry and the OS/WebKit Back gesture has nothing to return to. Map the macOS back
	// gesture onto the workspace's OWN view-history back-stack (workspace.back()). Bound at the WINDOW
	// so a swipe anywhere navigates — but GUARDED so it never hijacks a legitimate in-view horizontal
	// scroll: if the gesture starts over an element that can still scroll horizontally in that
	// direction (a wide table, a code block, the tab strip), that element keeps the gesture.
	// DIRECTION: the macOS back gesture is two fingers moving RIGHT, which (natural scrolling) emits
	// wheel events with NEGATIVE deltaX — so back = a decisive negative horizontal accumulation. This
	// is layout-agnostic (no DOM/markup change) to stay clear of S11's R4-SHELLCHROME header redesign.
	onMount(() => {
		if (!browser) return;
		const THRESHOLD = 90;   // px of sustained horizontal travel before navigating
		const RESET_MS = 200;   // a wheel-momentum gap this long ends the gesture
		let accum = 0;
		let armed = false;      // a gesture NOT owned by a horizontal scroller (i.e. eligible for back)
		let decided = false;    // ownership decided for THIS gesture (first frame)
		let fired = false;      // one navigation per gesture
		let idle: ReturnType<typeof setTimeout> | null = null;

		// Does the target (or an ancestor) still scroll horizontally in `dir` (-1 = left, +1 = right)?
		function ownedByScroller(target: EventTarget | null, dir: number): boolean {
			let el = target as HTMLElement | null;
			for (; el && el !== document.body && el !== document.documentElement; el = el.parentElement) {
				const ox = getComputedStyle(el).overflowX;
				if (!/(auto|scroll)/.test(ox) || el.scrollWidth <= el.clientWidth + 1) continue;
				const atStart = el.scrollLeft <= 0;
				const atEnd = el.scrollLeft + el.clientWidth >= el.scrollWidth - 1;
				if (dir < 0 && !atStart) return true;   // can still scroll left ⇒ it owns a leftward swipe
				if (dir > 0 && !atEnd) return true;      // can still scroll right ⇒ it owns a rightward swipe
			}
			return false;
		}
		function endSoon() {
			if (idle) clearTimeout(idle);
			idle = setTimeout(() => { accum = 0; armed = false; decided = false; fired = false; }, RESET_MS);
		}
		function onWheel(e: WheelEvent) {
			if (e.ctrlKey) return;                                   // pinch-zoom, not a swipe
			if (Math.abs(e.deltaX) <= Math.abs(e.deltaY)) return;    // horizontal-dominant only
			if (Math.abs(e.deltaX) < 1) return;
			if (!decided) { decided = true; armed = !ownedByScroller(e.target, Math.sign(e.deltaX)); }
			if (!armed) { endSoon(); return; }                       // a scroller owns it — never navigate
			// Suppress the native WebKit history swipe so back is ours alone (armed ⇒ not over a scroller,
			// so nothing legitimate is being blocked). Requires the passive:false listener below.
			if (e.cancelable) e.preventDefault();
			accum += e.deltaX;
			if (!fired && accum <= -THRESHOLD) { fired = true; workspace.back(); }
			endSoon();
		}
		window.addEventListener('wheel', onWheel, { passive: false });
		return () => { window.removeEventListener('wheel', onWheel); if (idle) clearTimeout(idle); };
	});

	function startWindowDrag(e: MouseEvent) {
		if (!isTauri || e.button !== 0) return;
		const t = e.target as HTMLElement;
		// Controls + the hoisted tab strip own their own gestures (click/drag-reorder).
		if (t.closest('button, a, input, select, textarea, [role="button"], .tab-strip')) return;
		try {
			// `withGlobalTauri` is OFF (hardening: no full Tauri API on window for the
			// remote origin), so reach the core window command through the internals
			// bridge, which Tauri injects for the granted origin regardless of the flag.
			// `core:window:allow-start-dragging` is granted in capabilities/default.json.
			(window as any).__TAURI_INTERNALS__?.invoke?.('plugin:window|start_dragging');
		} catch { /* not in Tauri / API shape differs — data-tauri-drag-region handles it */ }
	}


	function handleMenuClick() {
		navigationState.toggleSidebar();
	}

	function toggleTheme() {
		theme.toggle();
	}
</script>

<!-- The whole bar is a window-drag handle in the native shell (no native title
     bar). Buttons/links inside are not drag regions, so they stay clickable.
     The mousedown only initiates an OS window-drag — there is no keyboard
     equivalent and no fitting ARIA role, so the static-interaction rule is
     intentionally ignored here. -->
<!-- R4-SHELLCHROME: the top bar is SPLIT into two cells that align with the two
     columns below — a LEFT cell the width of the sidebar column (holding the
     hamburger) and a RIGHT cell over the content (the tabs + actions). The left
     cell's right border continues the Sidebar's `border-r` straight up to the very
     top, so the window reads as two columns (sidebar | content) top-to-bottom: the
     hamburger belongs to the sidebar column, the tabs to the content column. This
     REVERSES the previous "one continuous undivided surface" treatment. The bar
     still takes --color-bg (the app-shell background) with no bottom border, so the
     ONLY seam is that intended vertical divider — the Sidebar keeps its own panel
     colour + border-r, and the two borders meet as one line. `items-stretch` makes
     each cell full-height so the divider runs the whole header height. In the
     native shell the bar doubles as the window-drag strip (no title bar); the
     button/links/tabs keep their own click/drag gestures. -->
<!-- svelte-ignore a11y_no_static_element_interactions -->
<header
	data-tauri-drag-region
	onmousedown={startWindowDrag}
	class="app-header h-10 flex items-stretch bg-[var(--color-bg)] relative z-10 overflow-hidden flex-shrink-0"
>
	<!-- LEFT CELL — the hamburger, sized to the sidebar column so its right border
	     lines up with the Sidebar's border-r into one continuous divider up to the
	     very top. Desktop-only: on mobile the hamburger is hidden (the drawer opens
	     from the bottom tab bar) so this cell folds away. When the sidebar is
	     collapsed there is no column, so the cell shrinks to just the hamburger and
	     drops the divider. The width transition mirrors the Sidebar's so the two
	     move together on resize + toggle. -->
	<div
		class="header-left hidden md:flex items-center flex-shrink-0 pl-2 sm:pl-3"
		class:has-divider={sidebarShown}
		style={sidebarShown ? `width: ${$sidebarWidth}px` : ''}
		data-tauri-drag-region
	>
		<button
			onclick={handleMenuClick}
			class="p-1 hover:bg-[var(--color-elevated)] rounded-md transition-colors text-[var(--color-text-tertiary)] hover:text-[var(--color-text-primary)] flex-shrink-0"
			aria-label="Toggle menu"
		>
			<svg class="w-[18px] h-[18px]" fill="none" stroke="currentColor" viewBox="0 0 24 24">
				<path stroke-linecap="round" stroke-linejoin="round" stroke-width="1.5" d="M4 6h16M4 12h16M4 18h16" />
			</svg>
		</button>
	</div>

	<!-- RIGHT CELL — over the content column: the workspace tabs (desktop) or the
	     page title (mobile), plus the always-present right-side actions. -->
	<div class="header-right flex-1 flex items-center min-w-0 px-2 sm:px-3 gap-1.5 sm:gap-2">
		<!-- Mobile: page title -->
		<h2 class="md:hidden text-sm font-medium text-[var(--color-text-primary)] truncate">
			{viewLabel(currentView)}
		</h2>

		<!-- Workspace tabs, hoisted into the header (desktop, single pane). Falls
		     back to a flex spacer on mobile / when the workspace is split into
		     multiple panes (each pane then keeps its own in-pane strip). -->
		{#if onlyPane}
			<div class="hidden md:flex flex-1 min-w-0 self-stretch overflow-hidden">
				<TabStrip
					inline
					tabs={onlyPane.tabs}
					activeTabId={onlyPane.activeTabId}
					paneId={onlyPane.id}
					onfocus={(id) => workspace.focusTab(id)}
					onclose={(id) => workspace.closeTab(id)}
					onopen={(viewId) => workspace.openInPane(onlyPane.id, viewId)}
					onreorder={(tabId, toIndex) => workspace.moveTabWithinPane(onlyPane.id, tabId, toIndex)}
				/>
			</div>
			<div class="flex-1 md:hidden" data-tauri-drag-region></div>
		{:else}
			<div class="flex-1" data-tauri-drag-region></div>
		{/if}

		<!-- Right side actions -->
	<div class="flex items-center gap-1 sm:gap-2 flex-shrink-0">
		<!-- Activity orb — ALWAYS visible next to chat, ALWAYS clickable. A round
		     glass disc: grey idle · green working · red on a failed job. Click for
		     the live job list + what ran last and when. The single source of truth
		     for pipeline / inference / background-job status (local or via API). -->
		<div class="relative">
			<button
				onclick={() => (activityOpen = !activityOpen)}
				class="activity-orb {orbState}"
				title={orbTitle}
				aria-label={orbTitle}
				aria-expanded={activityOpen}
			>
				<span class="orb-core"></span>
			</button>
			{#if activityOpen}
				<!-- Portaled to <body> so it renders ABOVE page navs/tooltips (z-30…z-1000)
				     instead of being trapped in the header's stacking context. -->
				<!-- svelte-ignore a11y_no_static_element_interactions -->
				<!-- svelte-ignore a11y_click_events_have_key_events -->
				<div use:portal>
					<div class="fixed inset-0 z-[9998]" onclick={() => (activityOpen = false)}></div>
						<!-- §3.8: the panel content (status rows + live jobs + history) lives in
						     StatusPopover.svelte — ONE mountable component, so the render is provable
						     by the mount harness (portal-app/test/mount-status-popover.mjs) instead of
						     being trapped in the Header's chrome. It mounts on open and unmounts on
						     close — which is also what scopes its readiness poll to the open popover. -->
					<div class="fixed top-[2.75rem] right-2 sm:right-3 z-[9999] min-w-[280px] max-w-[340px] rounded-xl border border-[var(--color-border)] bg-[var(--color-surface)] p-1.5 shadow-lg" style="backdrop-filter: blur(14px) saturate(150%); -webkit-backdrop-filter: blur(14px) saturate(150%);">
							<StatusPopover />
				</div>
				</div>
			{/if}
		</div>

		<!-- Chat agent toggle (Cmd/Ctrl+J) — opens the floating tool-using agent. -->
		<button
			onclick={() => navigationState.toggleChat()}
			class="w-7 h-7 rounded-full border flex items-center justify-center transition-all duration-150 {chatOpen
				? 'border-[var(--color-accent)] bg-[var(--color-accent)] text-white'
				: 'border-[var(--color-border)] bg-[var(--color-elevated)] text-[var(--color-text-secondary)] hover:text-[var(--color-text-primary)] hover:bg-[var(--color-surface)] hover:border-[var(--color-accent)]'}"
			title="Chat with your vault (⌘J)"
			aria-label="Toggle chat"
			aria-pressed={chatOpen}
		>
			<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
				<path d="M21 11.5a8.38 8.38 0 0 1-.9 3.8 8.5 8.5 0 0 1-7.6 4.7 8.38 8.38 0 0 1-3.8-.9L3 21l1.9-5.7a8.38 8.38 0 0 1-.9-3.8 8.5 8.5 0 0 1 4.7-7.6 8.38 8.38 0 0 1 3.8-.9h.5a8.48 8.48 0 0 1 8 8v.5z" />
			</svg>
		</button>

		<!-- Theme toggle -->
		<button
			onclick={toggleTheme}
			class="w-7 h-7 rounded-full border border-[var(--color-border)] bg-[var(--color-elevated)] flex items-center justify-center text-[var(--color-text-secondary)] hover:text-[var(--color-text-primary)] hover:bg-[var(--color-surface)] hover:border-[var(--color-accent)] transition-all duration-150"
			title={currentTheme === 'dark' ? 'Switch to light mode' : 'Switch to dark mode'}
			aria-label="Toggle theme"
		>
			{#if currentTheme === 'dark'}
				<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
					<path d="M21 12.79A9 9 0 1 1 11.21 3 7 7 0 0 0 21 12.79z" />
				</svg>
			{:else}
				<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
					<circle cx="12" cy="12" r="5" />
					<line x1="12" y1="1" x2="12" y2="3" />
					<line x1="12" y1="21" x2="12" y2="23" />
					<line x1="4.22" y1="4.22" x2="5.64" y2="5.64" />
					<line x1="18.36" y1="18.36" x2="19.78" y2="19.78" />
					<line x1="1" y1="12" x2="3" y2="12" />
					<line x1="21" y1="12" x2="23" y2="12" />
					<line x1="4.22" y1="19.78" x2="5.64" y2="18.36" />
					<line x1="18.36" y1="5.64" x2="19.78" y2="4.22" />
				</svg>
			{/if}
		</button>
		</div>
	</div>
</header>

<style>
	/* R4-SHELLCHROME — the header's left cell (the sidebar column at the top). Its
	   right border is the SAME 1px hairline as the Sidebar's border-r; since the cell
	   sits directly above the sidebar at the same left edge and the same width (both
	   border-box), the two borders stack into ONE continuous vertical divider from
	   the very top down. The border is present only when the sidebar column is (the
	   `has-divider` class), and the width transition matches the Sidebar's so they
	   move in lockstep on resize + open/close. */
	.header-left {
		transition: width 0.2s ease-out;
	}
	.header-left.has-divider {
		border-right: 1px solid var(--color-border);
	}

	/* The activity orb — a small round pane of glass with a glowing core. The
	   --orb custom property carries the state colour; everything (ring, fill,
	   glow, core) is derived from it so a state change is a single-token swap. */
	.activity-orb {
		--orb: var(--color-text-tertiary);
		position: relative;
		width: 1.75rem;
		height: 1.75rem;
		border-radius: 9999px;
		display: inline-flex;
		align-items: center;
		justify-content: center;
		cursor: pointer;
		border: 1px solid color-mix(in srgb, var(--orb) 40%, var(--color-border));
		background: radial-gradient(circle at 50% 38%,
			color-mix(in srgb, var(--orb) 24%, transparent),
			color-mix(in srgb, var(--orb) 7%, transparent) 70%);
		backdrop-filter: blur(10px) saturate(140%);
		-webkit-backdrop-filter: blur(10px) saturate(140%);
		transition: border-color 0.2s ease, box-shadow 0.2s ease, background 0.2s ease;
	}
	.activity-orb:hover {
		border-color: color-mix(in srgb, var(--orb) 70%, var(--color-border));
	}
	.orb-core {
		width: 0.5rem;
		height: 0.5rem;
		border-radius: 9999px;
		background: var(--orb);
		box-shadow: 0 0 6px -1px var(--orb);
		transition: background 0.2s ease;
	}
	.activity-orb.idle .orb-core { opacity: 0.55; box-shadow: none; }
	.activity-orb.busy {
		--orb: #34d399;
		box-shadow: 0 0 11px -3px color-mix(in srgb, #34d399 70%, transparent);
	}
	.activity-orb.busy .orb-core { animation: orb-pulse 1.6s ease-in-out infinite; }
	.activity-orb.error {
		--orb: #f87171;
		box-shadow: 0 0 11px -3px color-mix(in srgb, #f87171 70%, transparent);
	}
	@keyframes orb-pulse {
		0%, 100% { transform: scale(0.8); opacity: 0.7; }
		50% { transform: scale(1.18); opacity: 1; }
	}
	@media (prefers-reduced-motion: reduce) {
		.activity-orb.busy .orb-core { animation: none; }
	}
</style>
