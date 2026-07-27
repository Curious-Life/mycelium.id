<!--
  AgentHero — "who is this?", answered once.

  Replaces three scattered answers: the old Overview identity card, the Manage row's
  identity block, and the page header's "Last: …" chip. The name is edited HERE and
  nowhere else (PUT /portal/agent-identity — the live route that MERGES, so sending
  only `name` preserves channelWrite/scopes).
-->
<script lang="ts">
	import { api } from '$lib/api';
	import { workspace } from '$lib/workspace/store';
	import { avatarHue, avatarGlyph, rel } from './agent-visual';

	let {
		agent,
		engineLabel,
		lastActivityAt = null,
		lastActivityWho = null,
		activeTasks = 0,
		reachable = true,
		personaLine = null,
		stats = [],
		onChange,
	} = $props<{
		agent: { id: string; name: string; defaultName?: string; role?: string | null; status?: string };
		engineLabel: string | null;
		lastActivityAt?: string | null;
		lastActivityWho?: string | null;
		activeTasks?: number;
		reachable?: boolean;
		personaLine?: string | null;
		stats?: { label: string; value: string; tone?: string }[];
		onChange?: () => void | Promise<void>;
	}>();

	// Name — the single edit point. Kept in sync with the prop through an $effect so a
	// save round-trip (or an external rename) re-seeds the field instead of stranding it.
	let draft = $state('');
	let editing = $state(false);
	let saving = $state(false);
	let saved = $state(false);
	let error = $state<string | null>(null);
	let input = $state<HTMLInputElement | null>(null);

	$effect(() => {
		if (!editing) draft = agent.name || '';
	});

	const dirty = $derived(draft.trim() !== (agent.name || '').trim());

	function beginEdit() {
		editing = true;
		error = null;
		queueMicrotask(() => input?.select());
	}

	function cancel() {
		editing = false;
		draft = agent.name || '';
		error = null;
	}

	async function save() {
		if (saving) return;
		if (!dirty) { editing = false; return; }
		saving = true;
		error = null;
		try {
			// A blank name clears to the server default (agentDisplayName(null)).
			const res = await api('/portal/agent-identity', {
				method: 'PUT',
				body: JSON.stringify({ name: draft.trim() || null }),
			});
			if (!res.ok) throw new Error(`HTTP ${res.status}`);
			editing = false;
			saved = true;
			setTimeout(() => { saved = false; }, 1600);
			await onChange?.();
		} catch (e) {
			error = e instanceof Error ? e.message : 'save failed';
		} finally {
			saving = false;
		}
	}

	function onKey(e: KeyboardEvent) {
		if (e.key === 'Enter') { e.preventDefault(); save(); }
		else if (e.key === 'Escape') { e.preventDefault(); cancel(); }
	}

	const offline = $derived(agent.status === 'offline');
	const statusTone = $derived(offline || !reachable ? 'var(--color-accent-coral)' : 'var(--color-accent-jade)');
	const statusText = $derived(
		offline ? 'Offline' : !reachable ? 'Unreachable' : activeTasks > 0 ? `${activeTasks} running` : 'Listening',
	);
</script>

<header class="hero">
	<div class="wash" aria-hidden="true"></div>

	<div class="top">
		<div class="avatar-wrap">
			<span class="avatar" style="--hue:{avatarHue(agent.id)}deg" aria-hidden="true">{avatarGlyph(agent.id)}</span>
			<span class="ring" style:background={statusTone} class:pulse={activeTasks > 0}></span>
		</div>

		<div class="identity">
			<div class="name-row">
				{#if editing}
					<input
						bind:this={input}
						class="name-input"
						bind:value={draft}
						onkeydown={onKey}
						onblur={save}
						placeholder={agent.defaultName || agent.id}
						maxlength="50"
						aria-label="Agent name"
					/>
					<button class="linkish" onmousedown={(e) => e.preventDefault()} onclick={cancel}>cancel</button>
				{:else}
					<h1>{agent.name}</h1>
					<button class="edit" onclick={beginEdit} title="Rename your agent" aria-label="Rename your agent">
						<svg viewBox="0 0 16 16" width="13" height="13" aria-hidden="true"><path d="M11.5 1.9 14.1 4.5 5.6 13H3v-2.6zM12.6.8l.9-.9 2.6 2.6-.9.9z" fill="currentColor"/></svg>
					</button>
				{/if}
				{#if saving}<span class="flash">Saving…</span>
				{:else if saved}<span class="flash ok">Saved ✓</span>{/if}
			</div>

			<div class="meta">
				<span class="pill status">
					<span class="dot" style:background={statusTone} class:pulse={activeTasks > 0}></span>
					{statusText}
				</span>
				{#if engineLabel}
					<span class="pill" title="Which engine powers this agent">{engineLabel}</span>
				{/if}
				{#if lastActivityAt}
					<span class="quiet" title={new Date(lastActivityAt).toLocaleString()}>
						last turn {rel(lastActivityAt)}{lastActivityWho ? ` · ${lastActivityWho}` : ''}
					</span>
				{:else}
					<span class="quiet">no turns yet</span>
				{/if}
			</div>

			<p class="persona" class:empty={!personaLine}>
				{personaLine || 'No character set yet — give your agent a personality.'}
				<button class="linkish" onclick={() => workspace.openFromRoute('character', { id: agent.id })}>
					{personaLine ? 'refine character →' : 'write one →'}
				</button>
			</p>

			{#if error}<p class="err">{error}</p>{/if}
		</div>
	</div>

	{#if stats.length}
		<dl class="stats">
			{#each stats as s (s.label)}
				<div class="stat">
					<dt>{s.label}</dt>
					<dd style:color={s.tone || 'var(--color-text-primary)'}>{s.value}</dd>
				</div>
			{/each}
		</dl>
	{/if}
</header>

<style>
	.hero {
		position: relative;
		overflow: hidden;
		border: 1px solid var(--color-border);
		border-radius: 16px;
		background: var(--color-surface);
		padding: 1.25rem 1.35rem 1.1rem;
	}
	/* The one decorative flourish: a wash in the agent's own accent. --agent-rgb is set
	   on the page root, so it is a channel triplet and stays theme-aware. */
	.wash {
		position: absolute;
		inset: 0;
		pointer-events: none;
		background:
			radial-gradient(90% 120% at 6% -20%, rgb(var(--agent-rgb) / 0.16), transparent 62%),
			radial-gradient(70% 100% at 100% 0%, rgb(var(--color-accent-aurum-rgb) / 0.05), transparent 60%);
	}

	.top { position: relative; display: flex; gap: 1.1rem; align-items: flex-start; }

	.avatar-wrap { position: relative; flex-shrink: 0; }
	.avatar {
		display: grid;
		place-items: center;
		width: 62px;
		height: 62px;
		border-radius: 18px;
		font-size: 1.75rem;
		/* A saturated identity mark in BOTH themes — white glyph stays correct. */
		background: linear-gradient(135deg, hsl(var(--hue) 60% 55%), hsl(calc(var(--hue) + 40deg) 55% 42%));
		color: #fff;
	}
	.ring {
		position: absolute;
		right: -2px;
		bottom: -2px;
		width: 14px;
		height: 14px;
		border-radius: 999px;
		border: 2.5px solid var(--color-surface);
	}

	.identity { min-width: 0; flex: 1; display: flex; flex-direction: column; gap: 0.35rem; }

	.name-row { display: flex; align-items: center; gap: 0.5rem; min-height: 2rem; }
	h1 {
		margin: 0;
		font-size: 1.5rem;
		line-height: 1.15;
		letter-spacing: -0.01em;
		color: var(--color-text-emphasis);
	}
	.edit {
		display: grid;
		place-items: center;
		width: 1.5rem;
		height: 1.5rem;
		border: 0;
		border-radius: 6px;
		background: transparent;
		color: var(--color-text-tertiary);
		cursor: pointer;
		opacity: 0;
		transition: opacity var(--duration-fast) var(--ease-out), color var(--duration-fast) var(--ease-out);
	}
	.hero:hover .edit, .edit:focus-visible { opacity: 1; }
	.edit:hover { color: var(--color-accent); background: var(--color-hover); }
	.name-input {
		flex: 1;
		min-width: 0;
		max-width: 22rem;
		padding: 0.15rem 0.45rem;
		font: inherit;
		font-size: 1.5rem;
		letter-spacing: -0.01em;
		color: var(--color-text-emphasis);
		background: var(--color-bg);
		border: 1px solid var(--color-accent);
		border-radius: 8px;
	}
	.name-input:focus { outline: none; }
	.flash { font-size: 0.7rem; color: var(--color-text-tertiary); }
	.flash.ok { color: var(--color-accent-jade); }

	.meta { display: flex; flex-wrap: wrap; align-items: center; gap: 0.4rem 0.6rem; }
	.pill {
		display: inline-flex;
		align-items: center;
		gap: 0.35rem;
		padding: 0.18rem 0.55rem;
		border-radius: 999px;
		border: 1px solid var(--color-border);
		background: var(--color-elevated);
		font-size: 0.7rem;
		color: var(--color-text-secondary);
		white-space: nowrap;
	}
	.pill.status { border-color: transparent; }
	.dot { width: 0.45rem; height: 0.45rem; border-radius: 999px; flex-shrink: 0; }
	.dot.pulse, .ring.pulse { animation: breathe 1.8s var(--ease-in-out) infinite; }
	@keyframes breathe { 0%, 100% { opacity: 1; } 50% { opacity: 0.35; } }
	@media (prefers-reduced-motion: reduce) {
		.dot.pulse, .ring.pulse { animation: none; }
	}
	.quiet { font-size: 0.7rem; color: var(--color-text-tertiary); }

	.persona {
		margin: 0.15rem 0 0;
		font-size: 0.82rem;
		line-height: 1.45;
		color: var(--color-text-secondary);
	}
	.persona.empty { color: var(--color-text-tertiary); font-style: italic; }
	.linkish {
		border: 0;
		background: transparent;
		padding: 0 0 0 0.35rem;
		font: inherit;
		font-size: 0.75rem;
		font-style: normal;
		color: var(--color-accent);
		cursor: pointer;
		white-space: nowrap;
	}
	.linkish:hover { text-decoration: underline; }
	.err { margin: 0; font-size: 0.72rem; color: var(--color-accent-coral); }

	.stats {
		position: relative;
		display: flex;
		flex-wrap: wrap;
		gap: 0.5rem;
		margin: 1rem 0 0;
		padding-top: 0.9rem;
		border-top: 1px solid var(--color-border);
	}
	.stat {
		flex: 0 1 9rem;
		min-width: 7rem;
		padding: 0.45rem 0.7rem;
		border-radius: 10px;
		background: rgb(var(--agent-rgb) / 0.07);
	}
	.stat dt { font-size: 0.58rem; text-transform: uppercase; letter-spacing: 0.07em; color: var(--color-text-tertiary); }
	.stat dd { margin: 0.1rem 0 0; font-size: 0.95rem; font-weight: 500; font-variant-numeric: tabular-nums; }

	@media (max-width: 560px) {
		.top { flex-direction: column; }
		h1, .name-input { font-size: 1.25rem; }
		.edit { opacity: 1; }
	}
</style>
