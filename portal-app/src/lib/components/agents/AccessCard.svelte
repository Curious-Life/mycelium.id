<!--
  AccessCard — "what may it see, and may it write?"

  The scopes + channel-write controls lifted out of the old Overview tab. Both PUT
  /portal/agent-identity, which MERGES, so each control sends only its own field.
-->
<script lang="ts">
	import { api } from '$lib/api';
	import AgentCard from './AgentCard.svelte';

	let { identity = null, loading = false, onChange } = $props<{
		identity?: { name: string; channelWrite: boolean; scopes: string[]; allScopes: string[] } | null;
		loading?: boolean;
		onChange?: () => void | Promise<void>;
	}>();

	const SCOPE_LABELS: Record<string, string> = {
		personal: 'Personal',
		org: 'Work',
		wealth: 'Finances',
		health: 'Health',
	};

	let saving = $state(false);
	let error = $state<string | null>(null);

	async function put(body: Record<string, unknown>) {
		if (saving) return;
		saving = true;
		error = null;
		try {
			const res = await api('/portal/agent-identity', { method: 'PUT', body: JSON.stringify(body) });
			if (!res.ok) throw new Error(`HTTP ${res.status}`);
			await onChange?.();
		} catch (e) {
			error = e instanceof Error ? e.message : 'save failed';
		} finally {
			saving = false;
		}
	}

	function toggleScope(scope: string) {
		if (!identity) return;
		const has = identity.scopes.includes(scope);
		const next = has ? identity.scopes.filter((s: string) => s !== scope) : [...identity.scopes, scope];
		if (next.length === 0) return; // never empty — full access is the floor
		put({ scopes: next });
	}
</script>

<AgentCard title="Access" loading={loading}>
	<p class="lead">Which areas of your vault this agent may read.</p>
	<div class="scopes">
		{#each (identity?.allScopes || []) as scope (scope)}
			{@const on = identity?.scopes.includes(scope)}
			<button
				class="scope"
				class:on
				disabled={saving}
				aria-pressed={on}
				onclick={() => toggleScope(scope)}
			>{SCOPE_LABELS[scope] || scope}</button>
		{/each}
	</div>

	<div class="write">
		<div class="write-copy">
			<span class="write-title">Vault writes from channels</span>
			<p>
				Let it save notes, remember facts and capture from your 1:1 DMs.
				Group messages and other people can never write.
			</p>
		</div>
		<button
			class="switch"
			class:on={identity?.channelWrite}
			disabled={saving || !identity}
			role="switch"
			aria-checked={!!identity?.channelWrite}
			aria-label="Vault writes from channels"
			onclick={() => identity && put({ channelWrite: !identity.channelWrite })}
		><span class="knob"></span></button>
	</div>

	{#if error}<p class="err">{error}</p>{/if}
</AgentCard>

<style>
	.lead { margin: 0.5rem 0 0.6rem; font-size: 0.72rem; color: var(--color-text-tertiary); }
	.scopes { display: flex; flex-wrap: wrap; gap: 0.35rem; }
	.scope {
		padding: 0.3rem 0.65rem;
		border-radius: 999px;
		border: 1px solid var(--color-border);
		background: transparent;
		color: var(--color-text-tertiary);
		font: inherit;
		font-size: 0.75rem;
		cursor: pointer;
		transition: color var(--duration-fast) var(--ease-out), border-color var(--duration-fast) var(--ease-out), background var(--duration-fast) var(--ease-out);
	}
	.scope:hover:not(:disabled) { color: var(--color-text-primary); border-color: var(--color-text-tertiary); }
	.scope.on {
		border-color: rgb(var(--agent-rgb) / 0.55);
		background: rgb(var(--agent-rgb) / 0.14);
		color: var(--color-text-primary);
	}
	.scope:disabled { opacity: 0.6; cursor: default; }

	.write {
		display: flex;
		align-items: flex-start;
		gap: 0.75rem;
		margin-top: 0.9rem;
		padding-top: 0.85rem;
		border-top: 1px solid var(--color-border);
	}
	.write-copy { flex: 1; min-width: 0; }
	.write-title { font-size: 0.78rem; color: var(--color-text-primary); }
	.write-copy p { margin: 0.2rem 0 0; font-size: 0.7rem; line-height: 1.45; color: var(--color-text-tertiary); }

	.switch {
		position: relative;
		flex-shrink: 0;
		width: 2.35rem;
		height: 1.35rem;
		padding: 0;
		border: 0;
		border-radius: 999px;
		background: var(--color-border);
		cursor: pointer;
		transition: background var(--duration-fast) var(--ease-out);
	}
	.switch.on { background: var(--color-accent-jade); }
	.switch:disabled { opacity: 0.6; cursor: default; }
	.knob {
		position: absolute;
		top: 0.175rem;
		left: 0.175rem;
		width: 1rem;
		height: 1rem;
		border-radius: 999px;
		background: #fff;
		box-shadow: var(--shadow-sm);
		transition: transform var(--duration-fast) var(--ease-out);
	}
	.switch.on .knob { transform: translateX(1rem); }

	.err { margin: 0.6rem 0 0; font-size: 0.7rem; color: var(--color-accent-coral); }
</style>
