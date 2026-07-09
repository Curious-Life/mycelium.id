<script lang="ts">
	import { onMount } from 'svelte';
	import { api } from '$lib/api';
	import { workspace } from '$lib/workspace/store';
	import { auth } from '$lib/stores/auth';
	import SporeField from '$lib/components/SporeField.svelte';

	interface Space {
		id: string;
		name: string;
		handle: string | null;
		settings: { essence?: string; voice?: string };
		role: string;
		knowledge_count: number;
		member_count: number;
		created_at: string;
	}

	let spaces = $state<Space[]>([]);
	let loading = $state(true);
	let showCreate = $state(false);
	// Surfaces a failed spaces fetch (was silently swallowed → looked like "no spaces").
	let loadError = $state<string | null>(null);

	// Create form
	let newName = $state('');
	let newEssence = $state('');
	let creating = $state(false);
	let createError = $state<string | null>(null);

	async function loadSpaces() {
		try {
			const res = await api('/portal/spaces');
			if (res.ok) {
				const data = await res.json();
				spaces = data.spaces || [];
				loadError = null;
			} else {
				loadError = `GET /portal/spaces — HTTP ${res.status}`;
			}
		} catch (e: any) {
			loadError = `GET /portal/spaces — ${e?.message || String(e)}`;
		} finally {
			loading = false;
		}
	}

	async function createSpace() {
		if (!newName.trim() || !newEssence.trim()) {
			createError = 'Name and essence are required';
			return;
		}
		creating = true;
		createError = null;
		try {
			const res = await api('/portal/spaces', {
				method: 'POST',
				headers: { 'Content-Type': 'application/json' },
				body: JSON.stringify({ name: newName.trim(), essence: newEssence.trim() }),
			});
			if (!res.ok) {
				const e = await res.json();
				throw new Error(e.error || 'Failed to create space');
			}
			const space = await res.json();
			newName = '';
			newEssence = '';
			showCreate = false;
			await loadSpaces();
			// Navigate to the new space in place (consistent with plain-click).
			workspace.openInActiveTab('space', { id: space.id });
		} catch (e: any) {
			createError = e.message;
		} finally {
			creating = false;
		}
	}

	// ── Tab-open gestures (browser-style). Plain click navigates in the CURRENT
	// tab (no new tab). ⌘/ctrl-click or middle-click opens a new tab directly;
	// right-click or long-press (hold) reveals the action menu. The Spaces grid is
	// the only surface that spawned a tab per item.
	let menu = $state<{ x: number; y: number; space: Space } | null>(null);
	let pressTimer: ReturnType<typeof setTimeout> | null = null;
	let longPressed = false;

	function openHere(space: Space) { workspace.openInActiveTab('space', { id: space.id }); }
	function openNewTab(space: Space) { workspace.openOrFocus('space', { id: space.id }); }

	function onCardClick(e: MouseEvent, space: Space) {
		e.preventDefault();
		if (longPressed) { longPressed = false; return; } // swallow the click trailing a long-press
		if (e.metaKey || e.ctrlKey) { openNewTab(space); return; } // ⌘/ctrl → new tab
		openHere(space);
	}
	function onCardAux(e: MouseEvent, space: Space) { // middle-click → new tab
		if (e.button === 1) { e.preventDefault(); openNewTab(space); }
	}
	function onCardContext(e: MouseEvent, space: Space) { // right-click → action menu
		e.preventDefault();
		menu = { x: e.clientX, y: e.clientY, space };
	}
	function onPressStart(e: PointerEvent, space: Space) {
		if (e.pointerType === 'mouse' && e.button !== 0) return; // left button / touch / pen only
		longPressed = false;
		const x = e.clientX, y = e.clientY;
		cancelPress();
		pressTimer = setTimeout(() => { longPressed = true; menu = { x, y, space }; }, 500);
	}
	function cancelPress() { if (pressTimer) { clearTimeout(pressTimer); pressTimer = null; } }

	onMount(loadSpaces);

</script>

<div class="relative min-h-full">
	<!-- Ambient background -->
	<div class="absolute inset-0 overflow-hidden">
		<SporeField density={80} speed={0.08} connectionDistance={60} />
	</div>

<div class="relative z-10 max-w-4xl mx-auto px-4 py-8">
	<div class="flex items-center justify-between mb-6">
		<h1 class="text-xs font-medium text-[var(--color-text-tertiary)] uppercase tracking-wider">Spaces</h1>
		{#if spaces.length > 0}
			<button
				onclick={() => { showCreate = true; }}
				class="flex items-center gap-1.5 px-3 py-1.5 rounded-lg text-xs font-medium text-aurum bg-aurum/10 hover:bg-aurum/20 transition-colors"
			>
				<svg class="w-3.5 h-3.5" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M12 4v16m8-8H4" /></svg>
				Create Space
			</button>
		{/if}
	</div>

	{#if loading}
		<div class="flex items-center justify-center py-24">
			<div class="w-8 h-8 border-2 border-[var(--color-border)] border-t-[var(--color-accent)] rounded-full animate-spin"></div>
		</div>
	{:else if loadError}
		<!-- Load failed — surface it instead of looking like "no spaces" -->
		<div class="flex flex-col items-center justify-center py-24 text-center gap-3 px-6" role="alert">
			<p class="text-base font-medium text-[var(--color-status-error,#c0392b)]">Couldn't load your spaces.</p>
			<code class="text-xs text-[var(--color-text-secondary)] break-all max-w-md">{loadError}</code>
			<button class="text-sm text-[var(--color-accent)]" onclick={() => navigator.clipboard?.writeText(loadError ?? '')}>Copy error</button>
		</div>
	{:else if spaces.length === 0 && !showCreate}
		<!-- Empty state -->
		<div class="flex flex-col items-center justify-center py-24 text-center">
			<svg class="w-16 h-16 text-[var(--color-text-tertiary)] opacity-20 mb-4" fill="none" stroke="currentColor" viewBox="0 0 24 24">
				<path stroke-linecap="round" stroke-linejoin="round" stroke-width="1" d="M21 12a9 9 0 01-9 9m9-9a9 9 0 00-9-9m9 9H3m9 9a9 9 0 01-9-9m9 9c1.657 0 3-4.03 3-9s-1.343-9-3-9m0 18c-1.657 0-3-4.03-3-9s1.343-9 3-9m-9 9a9 9 0 019-9" />
			</svg>
			<p class="text-base font-medium text-[var(--color-text-primary)] mb-1">No spaces yet</p>
			<p class="text-sm text-[var(--color-text-secondary)] mb-6 max-w-xs">
				Create a space to share your knowledge as a living mind
			</p>
			<button
				onclick={() => { showCreate = true; }}
				class="px-5 py-2.5 rounded-lg text-sm font-medium bg-[var(--color-accent)] text-white hover:opacity-90 transition-opacity"
			>
				Create Space
			</button>
		</div>
	{:else}
		<!-- Space grid -->
		<div class="grid grid-cols-1 md:grid-cols-2 gap-3">
			{#each spaces as space (space.id)}
				<a
					href="/spaces/{space.id}"
					onclick={(e) => onCardClick(e, space)}
					onauxclick={(e) => onCardAux(e, space)}
					oncontextmenu={(e) => onCardContext(e, space)}
					onpointerdown={(e) => onPressStart(e, space)}
					onpointerup={cancelPress}
					onpointerleave={cancelPress}
					onpointermove={cancelPress}
					class="group card p-4 rounded-xl border border-[var(--color-border)] hover:border-[var(--color-accent)] transition-all duration-150 hover:-translate-y-px"
					style="box-shadow: none; -webkit-touch-callout: none; -webkit-user-select: none; user-select: none;"
					onmouseenter={(e) => { (e.currentTarget as HTMLElement).style.boxShadow = '0 0 20px rgba(229, 184, 76, 0.08)'; }}
					onmouseleave={(e) => { (e.currentTarget as HTMLElement).style.boxShadow = 'none'; }}
				>
					<div class="flex items-start justify-between mb-2">
						<div class="flex items-center gap-2">
							<div class="w-2 h-2 rounded-full bg-aurum"></div>
							<h3 class="text-base font-semibold text-[var(--color-text-primary)]">{space.name}</h3>
						</div>
						<span class="text-[10px] font-medium text-[var(--color-text-tertiary)] bg-[var(--color-elevated)] px-2 py-0.5 rounded-full">
							{space.role}
						</span>
					</div>
					{#if space.settings?.essence}
						<p class="text-sm text-[var(--color-text-secondary)] line-clamp-2 mb-3">{space.settings.essence}</p>
					{/if}
					<div class="flex items-center gap-4 text-[11px] font-mono text-[var(--color-text-tertiary)]">
						<span>{space.knowledge_count} knowledge</span>
						<span>{space.member_count} members</span>
					</div>
				</a>
			{/each}

			<!-- Create card -->
			<button
				onclick={() => { showCreate = true; }}
				class="p-4 rounded-xl border border-dashed border-[var(--color-border)] hover:border-[var(--color-text-tertiary)] transition-colors flex flex-col items-center justify-center text-center min-h-[120px] cursor-pointer"
			>
				<svg class="w-5 h-5 text-[var(--color-text-tertiary)] mb-2" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path stroke-linecap="round" stroke-linejoin="round" stroke-width="1.5" d="M12 4v16m8-8H4" /></svg>
				<span class="text-sm text-[var(--color-text-tertiary)]">Create a new space</span>
			</button>
		</div>
	{/if}

	<!-- Create overlay -->
	{#if showCreate}
		<div class="fixed inset-0 z-50 flex items-center justify-center p-4" style="background: rgba(10, 10, 12, 0.72); backdrop-filter: blur(20px) saturate(140%);">
			<div class="w-full max-w-lg rounded-2xl border border-white/[0.06] p-8" style="background: rgba(26, 26, 31, 0.95);">
				<h2 class="text-lg font-medium text-[var(--color-text-emphasis)] mb-1">Name your space</h2>
				<p class="text-xs text-[var(--color-text-tertiary)] mb-5">It will find its own voice from the knowledge you give it.</p>

				<input
					type="text"
					bind:value={newName}
					placeholder="e.g., Rhiza"
					class="w-full px-4 py-3 rounded-lg bg-[var(--color-bg)] text-lg text-[var(--color-text-primary)] border border-[var(--color-border)] focus:outline-none focus:border-[var(--color-accent)] mb-4"
				/>

				<p class="text-sm text-[var(--color-text-secondary)] mb-2">What does it explore?</p>
				<textarea
					bind:value={newEssence}
					placeholder="The intersection of complex systems and living networks"
					rows="3"
					class="w-full px-4 py-3 rounded-lg bg-[var(--color-bg)] text-sm text-[var(--color-text-primary)] border border-[var(--color-border)] focus:outline-none focus:border-[var(--color-accent)] resize-none mb-6"
				></textarea>

				{#if createError}
					<p class="text-xs text-coral mb-4">{createError}</p>
				{/if}

				<div class="flex items-center justify-end gap-3">
					<button
						onclick={() => { showCreate = false; createError = null; }}
						class="px-4 py-2 rounded-lg text-sm text-[var(--color-text-tertiary)] hover:text-[var(--color-text-primary)] transition-colors"
					>Cancel</button>
					<button
						onclick={createSpace}
						disabled={creating || !newName.trim() || !newEssence.trim()}
						class="px-5 py-2 rounded-lg text-sm font-medium bg-aurum text-[var(--color-bg)] hover:opacity-90 transition-opacity disabled:opacity-40"
					>
						{creating ? 'Creating...' : 'Create Space'}
					</button>
				</div>
			</div>
		</div>
	{/if}

	<!-- Space action menu (right-click / long-press) -->
	{#if menu}
		<!-- svelte-ignore a11y_no_static_element_interactions -->
		<!-- svelte-ignore a11y_click_events_have_key_events -->
		<div class="fixed inset-0 z-40" onclick={() => (menu = null)} oncontextmenu={(e) => { e.preventDefault(); menu = null; }}></div>
		<div class="fixed z-50 min-w-[168px] py-1 rounded-lg border border-[var(--color-border)] shadow-lg text-sm" style="left: {menu.x}px; top: {menu.y}px; background: var(--color-elevated);">
			<button class="w-full text-left px-3 py-1.5 hover:bg-[var(--color-hover)] text-[var(--color-text-primary)]" onclick={() => { const s = menu!.space; menu = null; openHere(s); }}>Open</button>
			<button class="w-full text-left px-3 py-1.5 hover:bg-[var(--color-hover)] text-[var(--color-text-primary)]" onclick={() => { const s = menu!.space; menu = null; openNewTab(s); }}>Open in new tab</button>
		</div>
	{/if}
</div>
</div>
