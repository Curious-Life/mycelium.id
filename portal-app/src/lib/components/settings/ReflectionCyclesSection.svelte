<!--
	Reflection Cycles settings section (Settings → Intelligence).

	The control surface for the agent's autonomous wake cycles: a master opt-in toggle,
	the timezone they fire in, a per-cycle list (schedule · status · next fire · last run)
	with on/off + inline edit of timing and instructions, and the recent check-ins the
	'chat' cycles deliver. Opt-in by design — enabling seeds the six cycles; disabling
	pauses them (edits preserved). Backed by /portal/settings/reflection (src/portal-reflection.js).
-->
<script lang="ts">
	import { onMount } from 'svelte';
	import { api } from '$lib/api';

	type Cycle = {
		id: string; name: string; schedule: string; humanSchedule: string;
		status: string; essential: boolean; outputTarget: string;
		nextRun: string | null; nextRunHuman: string; lastRun: string | null; lastStatus: string | null;
	};
	type CheckIn = { id: string; role: string; content: string; at: string | null; model: string | null };
	type ModelHealth = { configured: boolean; toolsCapable: boolean; model: string | null };
	type Run = { cycle: string | null; status: string | null; error: string | null; at: string | null };

	let enabled = $state(false);
	let timezone = $state('UTC');
	let cycles = $state<Cycle[]>([]);
	let checkins = $state<CheckIn[]>([]);
	let modelHealth = $state<ModelHealth | null>(null);
	let unread = $state(0);
	let runs = $state<Run[]>([]);
	let loading = $state(true);
	let saving = $state(false);
	let error = $state<string | null>(null);

	// Which run statuses are "problems" worth showing prominently vs routine skips.
	const isProblem = (s: string | null) => !!s && /error|failed|incapable|no-model/.test(s);

	// per-cycle inline editor
	let editingId = $state<string | null>(null);
	let editSchedule = $state('');
	let editPrompt = $state('');
	let editBusy = $state(false);
	let editErr = $state<string | null>(null);

	const browserTz = (() => { try { return Intl.DateTimeFormat().resolvedOptions().timeZone; } catch { return ''; } })();

	async function load() {
		loading = true;
		error = null;
		try {
			const res = await api('/portal/settings/reflection');
			if (!res.ok) throw new Error(`Failed to load (${res.status})`);
			const d = await res.json();
			enabled = d.enabled === true;
			timezone = d.timezone || 'UTC';
			cycles = d.cycles || [];
			modelHealth = d.modelHealth || null;
			unread = Number(d.unread) || 0;
			if (enabled) { await loadCheckins(); await loadRuns(); markSeen(); }
		} catch (e: any) {
			error = e?.message || 'Failed to load';
		} finally {
			loading = false;
		}
	}

	async function loadCheckins() {
		try {
			const res = await api('/portal/settings/reflection/messages');
			if (res.ok) checkins = (await res.json()).messages || [];
		} catch { /* non-fatal */ }
	}

	async function loadRuns() {
		try {
			const res = await api('/portal/settings/reflection/runs');
			if (res.ok) runs = (await res.json()).runs || [];
		} catch { /* non-fatal */ }
	}

	// Clear the unread badge once the user is looking at the check-ins here.
	async function markSeen() {
		try { await api('/portal/settings/reflection/seen', { method: 'POST' }); } catch { /* non-fatal */ }
	}

	onMount(load);

	async function put(body: Record<string, unknown>) {
		saving = true;
		error = null;
		try {
			const res = await api('/portal/settings/reflection', { method: 'PUT', body: JSON.stringify(body) });
			if (!res.ok) throw new Error(`Failed to save (${res.status})`);
			const d = await res.json();
			enabled = d.enabled === true;
			timezone = d.timezone || timezone;
			cycles = d.cycles || cycles;
			if (enabled) await loadCheckins();
			else checkins = [];
		} catch (e: any) {
			error = e?.message || 'Failed to save';
		} finally {
			saving = false;
		}
	}

	const toggleEnabled = () => put({ enabled: !enabled });
	const useBrowserTz = () => { if (browserTz && browserTz !== timezone) put({ timezone: browserTz }); };

	async function toggleCycle(c: Cycle) {
		editBusy = true;
		try {
			const res = await api(`/portal/settings/reflection/cycles/${c.id}`, {
				method: 'PATCH', body: JSON.stringify({ enabled: c.status !== 'active' })
			});
			if (res.ok) { const d = await res.json(); if (d.cycle) cycles = cycles.map((x) => x.id === c.id ? d.cycle : x); }
		} finally { editBusy = false; }
	}

	async function openEdit(c: Cycle) {
		editErr = null;
		editingId = c.id;
		editSchedule = c.schedule;
		editPrompt = '';
		try {
			const res = await api(`/portal/settings/reflection/cycles/${c.id}`);
			if (res.ok) editPrompt = (await res.json()).cycle?.prompt || '';
		} catch { /* leave blank */ }
	}

	function closeEdit() { editingId = null; editErr = null; }

	async function saveEdit(c: Cycle) {
		editBusy = true;
		editErr = null;
		try {
			const body: Record<string, unknown> = {};
			if (editSchedule.trim() && editSchedule.trim() !== c.schedule) body.schedule = editSchedule.trim();
			if (editPrompt.trim()) body.prompt = editPrompt.trim();
			if (!Object.keys(body).length) { closeEdit(); return; }
			const res = await api(`/portal/settings/reflection/cycles/${c.id}`, { method: 'PATCH', body: JSON.stringify(body) });
			const d = await res.json().catch(() => ({}));
			if (!res.ok) { editErr = d?.error || `Failed (${res.status})`; return; }
			if (d.cycle) cycles = cycles.map((x) => x.id === c.id ? d.cycle : x);
			closeEdit();
		} catch (e: any) {
			editErr = e?.message || 'Failed to save';
		} finally { editBusy = false; }
	}

	const statusColor = (s: string) =>
		s === 'active' ? 'text-[var(--color-accent)]' : 'text-[var(--color-text-tertiary)]';
</script>

<div class="card p-5">
	<div class="flex items-start justify-between gap-3">
		<div>
			<h3 class="text-base font-semibold text-[var(--color-text-primary)]">Reflection cycles</h3>
			<p class="mt-1 text-sm text-[var(--color-text-secondary)]">
				Your agent's rhythms between conversations — morning &amp; evening check-ins, periodic
				reflection, an end-of-day triage, a nightly integration pass, and a weekly review. These
				run on their own, on this machine, so the agent has continuity and can say
				<em>“something I've been thinking about.”</em> Off by default; the reflective cycles use your
				cloud model, so they have a running cost.
			</p>
		</div>
		{#if !loading}
			<label class="flex items-center gap-2 cursor-pointer whitespace-nowrap {saving ? 'opacity-60' : ''}">
				<span class="text-xs {enabled ? 'text-[var(--color-accent)]' : 'text-[var(--color-text-tertiary)]'}">{enabled ? 'On' : 'Off'}</span>
				<input type="checkbox" checked={enabled} disabled={saving} onchange={toggleEnabled} />
			</label>
		{/if}
	</div>

	{#if loading}
		<p class="mt-4 text-sm text-[var(--color-text-secondary)]">Loading…</p>
	{:else if !enabled}
		<div class="mt-4 rounded-lg border border-[var(--color-border)] p-3">
			<p class="text-xs text-[var(--color-text-secondary)]">
				Turn this on to give your agent its wake cycles. You can pause any individual cycle or change
				its timing and focus once it's running — or just ask your agent in chat to adjust them.
			</p>
		</div>
	{:else}
		<!-- model-health banner: cycles need a tool-capable model to read the day + write memory -->
		{#if modelHealth && !modelHealth.configured}
			<div class="mt-4 rounded-lg border border-amber-500/40 bg-amber-500/10 p-3">
				<p class="text-xs text-[var(--color-text-primary)]">
					<span class="font-medium">No model set for reflection.</span>
					Your cycles are on, but they can't run until you pick a model in
					Settings → Intelligence (the “Reflection cycles” task).
				</p>
			</div>
		{:else if modelHealth && !modelHealth.toolsCapable}
			<div class="mt-4 rounded-lg border border-amber-500/40 bg-amber-500/10 p-3">
				<p class="text-xs text-[var(--color-text-primary)]">
					<span class="font-medium">Your reflection model can't read your memory.</span>
					{modelHealth.model ? `“${modelHealth.model}” doesn't support tool use` : 'The selected model doesn’t support tool use'},
					so check-ins are skipped rather than guessing. Pick a tool-capable model in Settings → Intelligence.
				</p>
			</div>
		{/if}

		<!-- timezone -->
		<div class="mt-4 flex items-center justify-between gap-3 rounded-lg border border-[var(--color-border)] p-3">
			<p class="text-xs text-[var(--color-text-secondary)]">
				Cycles run in your local time: <span class="font-medium text-[var(--color-text-primary)]">{timezone}</span>
			</p>
			{#if browserTz && browserTz !== timezone}
				<button class="text-xs text-[var(--color-accent)] hover:underline whitespace-nowrap" disabled={saving} onclick={useBrowserTz}>
					Use this device ({browserTz})
				</button>
			{/if}
		</div>

		<!-- per-cycle list -->
		<div class="mt-3 space-y-2">
			{#each cycles as c (c.id)}
				<div class="rounded-lg border border-[var(--color-border)] p-3">
					<div class="flex items-start justify-between gap-3">
						<div class="min-w-0">
							<div class="flex items-center gap-2">
								<span class="text-sm font-medium text-[var(--color-text-primary)]">{c.name}</span>
								{#if c.essential}<span class="text-[0.6rem] uppercase tracking-wide text-[var(--color-text-tertiary)]">check-in</span>{/if}
							</div>
							<div class="mt-0.5 text-xs text-[var(--color-text-secondary)]">
								{c.humanSchedule}
								<span class={statusColor(c.status)}>· {c.status}</span>
								{#if c.status === 'active' && c.nextRunHuman}· next {c.nextRunHuman}{/if}
								{#if c.lastStatus}· last {c.lastStatus}{/if}
							</div>
						</div>
						<div class="flex items-center gap-3 whitespace-nowrap">
							<button class="text-xs text-[var(--color-text-secondary)] hover:text-[var(--color-accent)]"
								onclick={() => (editingId === c.id ? closeEdit() : openEdit(c))}>
								{editingId === c.id ? 'Close' : 'Edit'}
							</button>
							<label class="flex items-center gap-1 cursor-pointer">
								<input type="checkbox" checked={c.status === 'active'} disabled={editBusy} onchange={() => toggleCycle(c)} />
							</label>
						</div>
					</div>

					{#if editingId === c.id}
						<div class="mt-3 space-y-2 border-t border-[var(--color-border)] pt-3">
							<label class="block">
								<span class="block text-xs text-[var(--color-text-secondary)] mb-1">Schedule</span>
								<input class="w-full rounded border border-[var(--color-border)] bg-transparent px-2 py-1 text-xs"
									bind:value={editSchedule} placeholder="daily:8 · weekly:0:10 · every:4h" />
							</label>
							<label class="block">
								<span class="block text-xs text-[var(--color-text-secondary)] mb-1">Instructions</span>
								<textarea class="w-full rounded border border-[var(--color-border)] bg-transparent px-2 py-1 text-xs font-mono"
									rows="8" bind:value={editPrompt}></textarea>
							</label>
							{#if editErr}<p class="text-xs text-red-500">{editErr}</p>{/if}
							<div class="flex gap-2">
								<button class="rounded bg-[var(--color-accent)] px-3 py-1 text-xs text-white disabled:opacity-60"
									disabled={editBusy} onclick={() => saveEdit(c)}>Save</button>
								<button class="text-xs text-[var(--color-text-secondary)]" onclick={closeEdit}>Cancel</button>
							</div>
						</div>
					{/if}
				</div>
			{/each}
		</div>

		<!-- cycle health: recent runs (content-free), problems surfaced -->
		{#if runs.length}
			<div class="mt-4">
				<h4 class="text-xs font-medium text-[var(--color-text-tertiary)] uppercase tracking-wider mb-2">Recent activity</h4>
				<div class="flex flex-wrap gap-1.5">
					{#each runs.slice(0, 12) as run}
						<span class="rounded px-1.5 py-0.5 text-[0.6rem] border {isProblem(run.status) ? 'border-red-500/40 text-red-500' : 'border-[var(--color-border)] text-[var(--color-text-tertiary)]'}"
							title={`${run.cycle ?? ''} · ${run.at ? new Date(run.at).toLocaleString() : ''}${run.error ? ' · ' + run.error : ''}`}>
							{run.cycle ?? 'cycle'}: {run.status ?? '—'}
						</span>
					{/each}
				</div>
			</div>
		{/if}

		<!-- recent check-ins -->
		{#if checkins.length}
			<div class="mt-4">
				<h4 class="text-xs font-medium text-[var(--color-text-tertiary)] uppercase tracking-wider mb-2">
					Recent check-ins{#if unread > 0}<span class="ml-2 rounded-full bg-[var(--color-accent)] px-1.5 py-0.5 text-[0.6rem] text-white">{unread} new</span>{/if}
				</h4>
				<div class="space-y-2">
					{#each checkins.slice(-5).reverse() as m (m.id)}
						<div class="rounded-lg border border-[var(--color-border)] p-3">
							<p class="text-sm text-[var(--color-text-primary)] whitespace-pre-wrap">{m.content}</p>
							{#if m.at}<p class="mt-1 text-[0.6rem] text-[var(--color-text-tertiary)]">{new Date(m.at).toLocaleString()}{m.model ? ` · ${m.model}` : ''}</p>{/if}
						</div>
					{/each}
				</div>
			</div>
		{/if}
	{/if}

	{#if error}
		<p class="mt-3 text-sm text-red-500">{error}</p>
	{/if}
</div>
