<!--
	Memory capture settings section.

	The opt-in control for AUTO-capturing connected-agent conversations (Claude
	Code, the model gateway, opencode/openclaw/hermes) into the vault. DEFAULT OFF
	— these captures can contain secrets, so this is the consent surface for the
	captureMessage gate (src/ingest/capture.js). Reads/writes GET/PUT
	/portal/agent-capture (src/portal-providers.js). Mirrors AIAccessSection's
	`card p-5` pattern.
-->
<script lang="ts">
	import { onMount } from 'svelte';
	import { api } from '$lib/api';

	let enabled = $state(false);
	let redactSecrets = $state(false);
	let loading = $state(true);
	let saving = $state(false);
	let savedAt = $state(0);
	let error = $state<string | null>(null);

	async function load() {
		loading = true;
		error = null;
		try {
			const res = await api('/portal/agent-capture');
			if (!res.ok) throw new Error(`Failed to load (${res.status})`);
			const d = (await res.json()) as { enabled?: boolean; redactSecrets?: boolean };
			enabled = d.enabled === true;
			redactSecrets = d.redactSecrets === true;
		} catch (e: any) {
			error = e?.message || 'Failed to load capture settings';
		} finally {
			loading = false;
		}
	}

	onMount(load);

	async function save() {
		saving = true;
		error = null;
		try {
			const res = await api('/portal/agent-capture', {
				method: 'PUT',
				body: JSON.stringify({ enabled, redactSecrets })
			});
			if (!res.ok) throw new Error(`Failed to save (${res.status})`);
			savedAt = Date.now();
		} catch (e: any) {
			error = e?.message || 'Failed to save';
		} finally {
			saving = false;
		}
	}
</script>

<div class="card p-5">
	<div class="flex items-start justify-between gap-3">
		<div>
			<h3 class="text-base font-semibold text-[var(--color-text-primary)]">Memory capture</h3>
			<p class="mt-1 text-sm text-[var(--color-text-secondary)]">
				Automatically save conversations from connected agents (Claude Code, the model
				gateway, opencode, openclaw, hermes) into your vault, so your assistant remembers
				across tools. Both your messages and the assistant's replies are captured.
			</p>
		</div>
		{#if savedAt}
			<span class="text-xs text-[var(--color-accent)] whitespace-nowrap">Saved ✓</span>
		{/if}
	</div>

	<!-- Secrets disclosure — always visible, so the choice is informed. -->
	<div class="mt-4 rounded-lg border border-amber-500/40 bg-amber-500/10 p-3">
		<p class="text-xs text-[var(--color-text-secondary)]">
			<span class="font-semibold text-amber-600 dark:text-amber-400">⚠ May contain secrets.</span>
			Captured conversations can include API keys, tokens, file contents, and command output.
			They're stored <span class="font-medium">encrypted in your own vault</span> and never
			leave your machine — but treat capture as keeping a full transcript. Off by default;
			your own notes and connector messages are never affected by this setting.
		</p>
	</div>

	{#if loading}
		<p class="mt-4 text-sm text-[var(--color-text-secondary)]">Loading…</p>
	{:else if error}
		<p class="mt-4 text-sm text-red-500">{error}</p>
	{:else}
		<div class="mt-4 space-y-2">
			<label class="flex items-start gap-3 cursor-pointer rounded-lg border border-[var(--color-border)] p-3 hover:border-[var(--color-accent)] transition-colors">
				<input type="checkbox" class="mt-0.5" bind:checked={enabled} />
				<span>
					<span class="block text-sm font-medium text-[var(--color-text-primary)]">Capture agent conversations</span>
					<span class="block text-xs text-[var(--color-text-secondary)]">When off, connected agents can still read your vault, but nothing they exchange is saved.</span>
				</span>
			</label>

			<label class="flex items-start gap-3 rounded-lg border border-[var(--color-border)] p-3 transition-colors {enabled ? 'cursor-pointer hover:border-[var(--color-accent)]' : 'opacity-50'}">
				<input type="checkbox" class="mt-0.5" bind:checked={redactSecrets} disabled={!enabled} />
				<span>
					<span class="block text-sm font-medium text-[var(--color-text-primary)]">Scrub obvious secrets before saving</span>
					<span class="block text-xs text-[var(--color-text-secondary)]">Best-effort redaction of common API keys, tokens, and JWTs. Reduces — does not guarantee — secret-free captures.</span>
				</span>
			</label>
		</div>

		<div class="mt-4">
			<button
				onclick={save}
				disabled={saving}
				class="px-4 py-2 rounded-lg bg-[var(--color-accent)] text-white text-sm font-medium hover:opacity-90 disabled:opacity-50"
			>
				{saving ? 'Saving…' : 'Save'}
			</button>
		</div>
	{/if}
</div>
