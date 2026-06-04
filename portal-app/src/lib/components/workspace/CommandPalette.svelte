<script lang="ts">
	// ⌘K command palette: fuzzy/substring over registry sections + recents → open
	// or focus as a workspace tab. Modeled on WelcomeModal's modal shape (backdrop
	// dialog, Escape / backdrop close). No fuzzy lib — substring match (no new dep).
	import { workspace } from '$lib/workspace/store';
	import { REGISTRY } from '$lib/workspace/registry';

	let { open = $bindable(false) }: { open?: boolean } = $props();

	interface Cmd {
		id: string;
		label: string;
		sub: string;
		run: () => void;
	}

	// Rebuilt each open (recents change). Sections always; recents only when they
	// add something a section row doesn't (i.e. carry params like a specific doc).
	function buildCommands(): Cmd[] {
		const sections: Cmd[] = Object.entries(REGISTRY).map(([id, v]) => ({
			id: `open:${id}`,
			label: v.title,
			sub: 'Open',
			run: () => workspace.openOrFocus(id),
		}));
		const recents: Cmd[] = $workspace.recents
			.filter((r) => r.params && Object.keys(r.params).length > 0)
			.slice(0, 6)
			.map((r, i) => ({
				id: `recent:${i}:${r.viewId}`,
				label: r.title,
				sub: 'Recent',
				run: () => workspace.openOrFocus(r.viewId, r.params),
			}));
		return [...sections, ...recents];
	}

	let query = $state('');
	let selectedIndex = $state(0);
	let inputEl = $state<HTMLInputElement | null>(null);

	const all = $derived(open ? buildCommands() : []);
	const filtered = $derived.by(() => {
		const q = query.trim().toLowerCase();
		return q ? all.filter((c) => `${c.label} ${c.sub}`.toLowerCase().includes(q)) : all;
	});

	// Reset + focus on open; keep selection in range as the filter narrows.
	$effect(() => {
		if (open) {
			query = '';
			selectedIndex = 0;
			queueMicrotask(() => inputEl?.focus());
		}
	});
	$effect(() => {
		if (selectedIndex > filtered.length - 1) selectedIndex = Math.max(0, filtered.length - 1);
	});

	function run(cmd: Cmd | undefined) {
		if (!cmd) return;
		open = false;
		cmd.run();
	}

	function onKeydown(e: KeyboardEvent) {
		if (e.key === 'Escape') {
			e.preventDefault();
			open = false;
		} else if (e.key === 'ArrowDown') {
			e.preventDefault();
			selectedIndex = Math.min(selectedIndex + 1, filtered.length - 1);
		} else if (e.key === 'ArrowUp') {
			e.preventDefault();
			selectedIndex = Math.max(selectedIndex - 1, 0);
		} else if (e.key === 'Enter') {
			e.preventDefault();
			run(filtered[selectedIndex]);
		}
	}
</script>

{#if open}
	<!-- svelte-ignore a11y_click_events_have_key_events a11y_no_static_element_interactions -->
	<div class="cp-backdrop" role="presentation" onclick={() => (open = false)}>
		<div
			class="cp-panel"
			role="dialog"
			aria-modal="true"
			aria-label="Command palette"
			onclick={(e) => e.stopPropagation()}
		>
			<input
				bind:this={inputEl}
				bind:value={query}
				class="cp-input"
				type="text"
				placeholder="Search views and recents…"
				autocomplete="off"
				autocapitalize="off"
				spellcheck="false"
				onkeydown={onKeydown}
			/>
			<div class="cp-list" role="listbox" aria-label="Commands">
				{#each filtered as cmd, i (cmd.id)}
					<button
						class="cp-item"
						class:selected={i === selectedIndex}
						role="option"
						aria-selected={i === selectedIndex}
						onmousemove={() => (selectedIndex = i)}
						onclick={() => run(cmd)}
					>
						<span class="cp-label">{cmd.label}</span>
						<span class="cp-sub">{cmd.sub}</span>
					</button>
				{/each}
				{#if filtered.length === 0}
					<div class="cp-empty">No matches</div>
				{/if}
			</div>
		</div>
	</div>
{/if}

<style>
	.cp-backdrop {
		position: fixed;
		inset: 0;
		z-index: 1000;
		display: flex;
		align-items: flex-start;
		justify-content: center;
		padding-top: 14vh;
		background: rgba(10, 10, 12, 0.55);
		animation: cp-fade 0.1s ease-out;
	}
	.cp-panel {
		width: min(560px, 92vw);
		max-height: 60vh;
		display: flex;
		flex-direction: column;
		overflow: hidden;
		background: var(--color-elevated);
		border: 1px solid var(--color-border);
		border-radius: var(--radius-md, 12px);
		box-shadow: var(--shadow-lg, 0 24px 60px rgba(0, 0, 0, 0.5));
	}
	.cp-input {
		flex-shrink: 0;
		padding: 14px 16px;
		border: none;
		border-bottom: 1px solid var(--color-border);
		background: transparent;
		color: var(--color-text-primary);
		font-size: 0.95rem;
		outline: none;
	}
	.cp-input::placeholder {
		color: var(--color-text-tertiary);
	}
	.cp-list {
		overflow-y: auto;
		padding: 6px;
	}
	.cp-item {
		display: flex;
		align-items: center;
		justify-content: space-between;
		gap: 12px;
		width: 100%;
		padding: 9px 12px;
		border: none;
		border-radius: 8px;
		background: none;
		color: var(--color-text-primary);
		font-size: 0.85rem;
		text-align: left;
		cursor: pointer;
	}
	.cp-item.selected {
		background: var(--color-surface);
	}
	.cp-label {
		overflow: hidden;
		text-overflow: ellipsis;
		white-space: nowrap;
	}
	.cp-sub {
		flex-shrink: 0;
		font-size: 0.7rem;
		color: var(--color-text-tertiary);
		text-transform: uppercase;
		letter-spacing: 0.04em;
	}
	.cp-empty {
		padding: 16px;
		text-align: center;
		font-size: 0.82rem;
		color: var(--color-text-tertiary);
	}
	@keyframes cp-fade {
		from {
			opacity: 0;
		}
		to {
			opacity: 1;
		}
	}
</style>
