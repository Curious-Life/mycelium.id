<!--
	Keep-the-Mac-awake settings section.

	Mycelium's background work (enrichment, reflection cycles, scheduled tasks,
	channel daemons) only keeps running through a screen lock if the Mac doesn't
	SYSTEM-sleep. A screen lock or dark display is fine; idle sleep freezes
	everything. This toggle has the app hold a power assertion while it runs.
	Reads/writes GET/POST /portal/system/keep-awake (src/portal-system.js).
	Default ON (macOS). Mirrors AgentCaptureSection's `card p-5` pattern.
-->
<script lang="ts">
	import { onMount } from 'svelte';
	import { api } from '$lib/api';

	let enabled = $state(true);
	let active = $state(false);
	let supported = $state(true);
	let onAC = $state<boolean | null>(null);
	let loading = $state(true);
	let saving = $state(false);
	let error = $state<string | null>(null);

	type Status = { enabled?: boolean; active?: boolean; supported?: boolean; onAC?: boolean | null };

	async function load() {
		loading = true;
		error = null;
		try {
			const res = await api('/portal/system/keep-awake');
			if (!res.ok) throw new Error(`Failed to load (${res.status})`);
			const d = (await res.json()) as Status;
			enabled = d.enabled !== false;
			active = d.active === true;
			supported = d.supported !== false;
			onAC = d.onAC ?? null;
		} catch (e: any) {
			error = e?.message || 'Failed to load';
		} finally {
			loading = false;
		}
	}

	onMount(load);

	// Save on toggle — one click activates, no separate Save step.
	async function toggle() {
		const next = !enabled;
		saving = true;
		error = null;
		try {
			const res = await api('/portal/system/keep-awake', {
				method: 'POST',
				body: JSON.stringify({ enabled: next })
			});
			if (!res.ok) throw new Error(`Failed to save (${res.status})`);
			const d = (await res.json()) as Status;
			enabled = d.enabled !== false;
			active = d.active === true;
			onAC = d.onAC ?? null;
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
			<h3 class="text-base font-semibold text-[var(--color-text-primary)]">Keep this Mac awake</h3>
			<p class="mt-1 text-sm text-[var(--color-text-secondary)]">
				Locking your screen doesn't stop Mycelium — but your Mac going to <em>sleep</em> does, which
				freezes enrichment, scheduled tasks, reflection cycles, and connected channels until it wakes.
				When on, Mycelium holds your Mac awake (the screen can still turn off) for as long as it's
				running, and releases it automatically when it stops.
			</p>
		</div>
		{#if !loading && supported}
			<span class="text-xs whitespace-nowrap {active ? 'text-[var(--color-accent)]' : 'text-[var(--color-text-tertiary)]'}">
				{active ? 'Holding ●' : 'Off'}
			</span>
		{/if}
	</div>

	{#if loading}
		<p class="mt-4 text-sm text-[var(--color-text-secondary)]">Loading…</p>
	{:else if !supported}
		<div class="mt-4 rounded-lg border border-[var(--color-border)] p-3">
			<p class="text-xs text-[var(--color-text-secondary)]">
				This setting is macOS-only. On other platforms, keep the machine from sleeping via the OS power settings.
			</p>
		</div>
	{:else}
		<div class="mt-4 space-y-2">
			<label class="flex items-start gap-3 cursor-pointer rounded-lg border border-[var(--color-border)] p-3 hover:border-[var(--color-accent)] transition-colors {saving ? 'opacity-60' : ''}">
				<input type="checkbox" class="mt-0.5" checked={enabled} disabled={saving} onchange={toggle} />
				<span>
					<span class="block text-sm font-medium text-[var(--color-text-primary)]">Keep awake while Mycelium runs</span>
					<span class="block text-xs text-[var(--color-text-secondary)]">
						Recommended — without it, background processing pauses whenever the Mac idle-sleeps.
					</span>
				</span>
			</label>
		</div>

		<!-- Honest caveats so the choice is informed. -->
		<div class="mt-3 rounded-lg border border-amber-500/40 bg-amber-500/10 p-3">
			<p class="text-xs text-[var(--color-text-secondary)]">
				{#if onAC === false}
					<span class="font-semibold text-amber-600 dark:text-amber-400">On battery now.</span>
					Keeping awake prevents idle-sleep and <span class="font-medium">will use battery</span>. For
					unattended 24/7 running, keep the Mac plugged in.
				{:else}
					<span class="font-semibold text-amber-600 dark:text-amber-400">Two limits to know:</span>
					on battery this uses power (it blocks idle-sleep), and <span class="font-medium">closing the lid</span>
					still sleeps a laptop unless it's plugged in with an external display. For always-on, keep it plugged in and the lid open.
				{/if}
			</p>
		</div>
	{/if}

	{#if error}
		<p class="mt-3 text-sm text-red-500">{error}</p>
	{/if}
</div>
