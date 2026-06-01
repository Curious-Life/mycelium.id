<script lang="ts">
	import { onMount } from 'svelte';
	import { api } from '$lib/api';

	// ── Types ─────────────────────────────────────────────────────────────
	interface FleetSummary {
		total: number;
		passing: number;
		warning: number;
		failing: number;
		dark: number;
	}
	interface FleetEntry {
		vps_id: string;
		handle: string;
		provisioned_at: number;
		last_report_at: number | null;
		last_report_age_hours: number | null;
		status: 'pass' | 'warn' | 'fail' | 'dark' | string;
		fatal_count: number;
		warn_count: number;
		arch_version: string | null;
		mycelium_version: string | null;
		metadata: Record<string, unknown>;
	}
	interface FleetStatus {
		summary: FleetSummary;
		fleet: FleetEntry[];
		generated_at: number;
	}
	interface CheckFailure {
		category: string;
		id: string;
		message: string;
		severity: 'fatal' | 'warning' | 'info' | string;
		status: 'fail' | 'warn' | 'skip' | 'pass' | string;
	}
	interface Report {
		id: string;
		reported_at: number;
		arch_version: string | null;
		mycelium_version: string | null;
		summary: { pass: number; warn: number; fail: number; skip: number; fatal_fail: number };
		failures: CheckFailure[];
	}
	interface History {
		vps_id: string;
		handle: string;
		reports: Report[];
	}
	interface GuardianSnapshot {
		guardians: Array<{
			id: string;
			kind: string;
			boundary?: string;
			process?: string;
			counters: { checks: number; allows: number; denies: number };
			recent_denies: Array<{ at: number; reason: string; ip_prefix?: string; method?: string; path?: string }>;
		}>;
		generated_at: number;
	}

	// ── State ─────────────────────────────────────────────────────────────
	let gateOk = $state<boolean | null>(null);
	let gateError = $state<string>('');
	let status = $state<FleetStatus | null>(null);
	let statusError = $state<string>('');
	let selectedHandle = $state<string | null>(null);
	let history = $state<History | null>(null);
	let historyError = $state<string>('');
	let guardians = $state<GuardianSnapshot | null>(null);
	let guardiansError = $state<string>('');
	let loading = $state(false);

	// ── Formatting helpers ────────────────────────────────────────────────
	function fmtAge(hours: number | null): string {
		if (hours === null) return 'never';
		if (hours < 1) return `${Math.round(hours * 60)}m`;
		if (hours < 24) return `${hours.toFixed(1)}h`;
		return `${(hours / 24).toFixed(1)}d`;
	}
	function fmtDate(ms: number | null): string {
		if (!ms) return '—';
		return new Date(ms).toLocaleString();
	}
	function statusColor(s: string): string {
		if (s === 'pass') return 'text-emerald-400';
		if (s === 'warn') return 'text-amber-400';
		if (s === 'fail') return 'text-red-400';
		return 'text-slate-500';
	}
	function severityColor(s: string): string {
		if (s === 'fatal') return 'text-red-400';
		if (s === 'warning') return 'text-amber-400';
		return 'text-slate-400';
	}

	// Group failures by category for drill-down rendering.
	function groupByCategory(failures: CheckFailure[]): Map<string, CheckFailure[]> {
		const grouped = new Map<string, CheckFailure[]>();
		for (const f of failures || []) {
			const cat = f.category || 'uncategorised';
			if (!grouped.has(cat)) grouped.set(cat, []);
			grouped.get(cat)!.push(f);
		}
		return grouped;
	}

	// ── Data fetching ─────────────────────────────────────────────────────
	async function probeGate(): Promise<boolean> {
		try {
			const res = await api('/portal/fleet/gate');
			if (res.ok) {
				gateOk = true;
				return true;
			}
			const body = await res.json().catch(() => ({}));
			gateError = body.error || `HTTP ${res.status}`;
			gateOk = false;
			return false;
		} catch (e) {
			gateError = e instanceof Error ? e.message : String(e);
			gateOk = false;
			return false;
		}
	}

	async function loadStatus() {
		try {
			const res = await api('/portal/fleet/status');
			if (!res.ok) {
				const body = await res.json().catch(() => ({}));
				statusError = body.error || `HTTP ${res.status}`;
				return;
			}
			status = await res.json();
		} catch (e) {
			statusError = e instanceof Error ? e.message : String(e);
		}
	}

	async function loadHistory(handle: string) {
		selectedHandle = handle;
		history = null;
		historyError = '';
		loading = true;
		try {
			const res = await api(
				`/portal/fleet/vps/${encodeURIComponent(handle)}/history`
			);
			if (!res.ok) {
				const body = await res.json().catch(() => ({}));
				historyError = body.error || `HTTP ${res.status}`;
				return;
			}
			history = await res.json();
		} catch (e) {
			historyError = e instanceof Error ? e.message : String(e);
		} finally {
			loading = false;
		}
	}

	async function loadGuardians() {
		try {
			const res = await api('/portal/fleet/guardians');
			if (!res.ok) {
				const body = await res.json().catch(() => ({}));
				guardiansError = body.error || `HTTP ${res.status}`;
				return;
			}
			guardians = await res.json();
		} catch (e) {
			guardiansError = e instanceof Error ? e.message : String(e);
		}
	}

	onMount(async () => {
		const gate = await probeGate();
		if (!gate) return;
		await Promise.all([loadStatus(), loadGuardians()]);
	});
</script>

<svelte:head>
	<title>Fleet — Mycelium</title>
</svelte:head>

<div class="h-full overflow-y-auto">
<div class="max-w-7xl mx-auto px-6 py-8">
	<header class="mb-8">
		<h1 class="text-2xl font-semibold text-[var(--color-text-primary)]">Fleet</h1>
		<p class="text-sm text-[var(--color-text-tertiary)] mt-1">
			Multi-VPS health, attestation checks, and Worker-side guardians.
		</p>
	</header>

	{#if gateOk === null}
		<div class="text-[var(--color-text-tertiary)] animate-pulse">Checking access…</div>
	{:else if gateOk === false}
		<div class="rounded-lg border border-red-900/50 bg-red-950/20 p-6 text-sm">
			<div class="text-red-400 font-medium">Access denied</div>
			<div class="text-slate-400 mt-2">
				{gateError}
			</div>
			<div class="text-slate-500 mt-3 text-xs">
				Fleet is only visible to the configured owner on operator VPSes.
			</div>
		</div>
	{:else}
		<!-- Roll-up cards -->
		{#if status}
			<section class="grid grid-cols-2 md:grid-cols-5 gap-4 mb-8">
				<div class="rounded-lg border border-slate-800 bg-slate-900/40 p-4">
					<div class="text-xs uppercase tracking-wider text-slate-500">Total</div>
					<div class="text-2xl font-semibold text-slate-100 mt-1">{status.summary.total}</div>
				</div>
				<div class="rounded-lg border border-emerald-900/50 bg-emerald-950/20 p-4">
					<div class="text-xs uppercase tracking-wider text-emerald-500">Passing</div>
					<div class="text-2xl font-semibold text-emerald-300 mt-1">{status.summary.passing}</div>
				</div>
				<div class="rounded-lg border border-amber-900/50 bg-amber-950/20 p-4">
					<div class="text-xs uppercase tracking-wider text-amber-500">Warning</div>
					<div class="text-2xl font-semibold text-amber-300 mt-1">{status.summary.warning}</div>
				</div>
				<div class="rounded-lg border border-red-900/50 bg-red-950/20 p-4">
					<div class="text-xs uppercase tracking-wider text-red-500">Failing</div>
					<div class="text-2xl font-semibold text-red-300 mt-1">{status.summary.failing}</div>
				</div>
				<div class="rounded-lg border border-slate-800 bg-slate-900/40 p-4">
					<div class="text-xs uppercase tracking-wider text-slate-500">Dark</div>
					<div class="text-2xl font-semibold text-slate-400 mt-1">{status.summary.dark}</div>
				</div>
			</section>
		{/if}

		<!-- VPS list -->
		<section class="mb-10">
			<h2 class="text-sm font-semibold uppercase tracking-wider text-[var(--color-text-tertiary)] mb-3">
				VPSes
			</h2>
			{#if statusError}
				<div class="text-sm text-red-400 p-4 border border-red-900/50 rounded bg-red-950/20">
					{statusError}
				</div>
			{:else if !status}
				<div class="text-sm text-slate-500 p-4 animate-pulse">Loading…</div>
			{:else if status.fleet.length === 0}
				<div class="text-sm text-slate-500 p-4 border border-slate-800 rounded">
					No VPSes reporting yet. Fleet-attest cron may not be configured on any customer
					instance.
				</div>
			{:else}
				<div class="rounded-lg border border-slate-800 overflow-hidden">
					<table class="w-full text-sm">
						<thead class="bg-slate-900/60 text-xs uppercase tracking-wider text-slate-500">
							<tr>
								<th class="text-left px-4 py-2">Handle</th>
								<th class="text-left px-4 py-2">Status</th>
								<th class="text-right px-4 py-2">Fatal</th>
								<th class="text-right px-4 py-2">Warn</th>
								<th class="text-left px-4 py-2">Last report</th>
								<th class="text-left px-4 py-2">Version</th>
								<th></th>
							</tr>
						</thead>
						<tbody>
							{#each status.fleet as vps (vps.vps_id)}
								<tr class="border-t border-slate-800 hover:bg-slate-900/30 transition-colors">
									<td class="px-4 py-3 font-mono text-slate-300">{vps.handle}</td>
									<td class="px-4 py-3 {statusColor(vps.status)} font-medium">
										{vps.status}
									</td>
									<td class="px-4 py-3 text-right {vps.fatal_count > 0 ? 'text-red-400' : 'text-slate-500'}">
										{vps.fatal_count}
									</td>
									<td class="px-4 py-3 text-right {vps.warn_count > 0 ? 'text-amber-400' : 'text-slate-500'}">
										{vps.warn_count}
									</td>
									<td class="px-4 py-3 text-slate-400">{fmtAge(vps.last_report_age_hours)}</td>
									<td class="px-4 py-3 font-mono text-xs text-slate-500">
										{vps.arch_version || '—'}
									</td>
									<td class="px-4 py-3">
										<button
											onclick={() => loadHistory(vps.handle)}
											class="text-xs text-[var(--color-accent)] hover:underline"
										>
											Details →
										</button>
									</td>
								</tr>
							{/each}
						</tbody>
					</table>
				</div>
			{/if}
		</section>

		<!-- Drill-down: selected VPS history -->
		{#if selectedHandle}
			<section class="mb-10">
				<div class="flex items-baseline justify-between mb-3">
					<h2 class="text-sm font-semibold uppercase tracking-wider text-[var(--color-text-tertiary)]">
						{selectedHandle} — check details
					</h2>
					<button
						onclick={() => { selectedHandle = null; history = null; historyError = ''; }}
						class="text-xs text-slate-500 hover:text-slate-300"
					>
						close
					</button>
				</div>

				{#if loading}
					<div class="text-sm text-slate-500 animate-pulse p-4">Loading…</div>
				{:else if historyError}
					<div class="text-sm text-red-400 p-4 border border-red-900/50 rounded bg-red-950/20">
						{historyError}
					</div>
				{:else if history && history.reports.length > 0}
					{@const latest = history.reports[0]}
					<div class="rounded-lg border border-slate-800 bg-slate-900/40 p-4 mb-3 text-xs text-slate-500">
						Reported {fmtDate(latest.reported_at)} ·
						arch {latest.arch_version || '—'} ·
						mycelium {latest.mycelium_version || '—'} ·
						{latest.summary.pass} pass · {latest.summary.warn} warn ·
						{latest.summary.fail} fail ({latest.summary.fatal_fail} fatal) ·
						{latest.summary.skip} skip
					</div>

					{#if latest.failures.length === 0}
						<div class="text-sm text-emerald-400 p-4 border border-emerald-900/50 rounded bg-emerald-950/20">
							All checks passing on this VPS.
						</div>
					{:else}
						{@const grouped = groupByCategory(latest.failures)}
						<div class="space-y-4">
							{#each [...grouped.entries()] as [category, checks] (category)}
								<div class="rounded-lg border border-slate-800 overflow-hidden">
									<div class="bg-slate-900/60 px-4 py-2 text-xs uppercase tracking-wider text-slate-400">
										{category} ({checks.length})
									</div>
									<ul class="divide-y divide-slate-800">
										{#each checks as c (c.id)}
											<li class="px-4 py-3 flex items-start gap-3">
												<span
													class="text-xs font-semibold uppercase {severityColor(c.severity)} w-16 flex-shrink-0 pt-0.5"
												>
													{c.severity}
												</span>
												<div class="flex-1 min-w-0">
													<div class="text-xs font-mono text-slate-400">{c.id}</div>
													<div class="text-sm text-slate-200 mt-1 break-words">{c.message}</div>
												</div>
											</li>
										{/each}
									</ul>
								</div>
							{/each}
						</div>
					{/if}
				{:else}
					<div class="text-sm text-slate-500 p-4 border border-slate-800 rounded">
						No reports.
					</div>
				{/if}
			</section>
		{/if}

		<!-- Guardians -->
		<section>
			<h2 class="text-sm font-semibold uppercase tracking-wider text-[var(--color-text-tertiary)] mb-3">
				Worker guardians
			</h2>
			{#if guardiansError}
				<div class="text-sm text-red-400 p-4 border border-red-900/50 rounded bg-red-950/20">
					{guardiansError}
				</div>
			{:else if !guardians}
				<div class="text-sm text-slate-500 animate-pulse p-4">Loading…</div>
			{:else if !guardians.guardians?.length}
				<div class="text-sm text-slate-500 p-4 border border-slate-800 rounded">
					No guardians registered.
				</div>
			{:else}
				<div class="rounded-lg border border-slate-800 overflow-hidden">
					<table class="w-full text-sm">
						<thead class="bg-slate-900/60 text-xs uppercase tracking-wider text-slate-500">
							<tr>
								<th class="text-left px-4 py-2">Guardian</th>
								<th class="text-left px-4 py-2">Kind</th>
								<th class="text-right px-4 py-2">Checks</th>
								<th class="text-right px-4 py-2">Allows</th>
								<th class="text-right px-4 py-2">Denies</th>
							</tr>
						</thead>
						<tbody>
							{#each guardians.guardians as g (g.id)}
								<tr class="border-t border-slate-800 hover:bg-slate-900/30">
									<td class="px-4 py-3 font-mono text-xs text-slate-300">{g.id}</td>
									<td class="px-4 py-3 text-xs text-slate-400">{g.kind}</td>
									<td class="px-4 py-3 text-right text-slate-300">{g.counters.checks}</td>
									<td class="px-4 py-3 text-right text-emerald-400">{g.counters.allows}</td>
									<td class="px-4 py-3 text-right {g.counters.denies > 0 ? 'text-red-400' : 'text-slate-500'}">
										{g.counters.denies}
									</td>
								</tr>
							{/each}
						</tbody>
					</table>
				</div>

				<!-- Recent denies (scrubbed in Worker) -->
				{@const denies = guardians.guardians.flatMap((g) =>
					(g.recent_denies || []).map((d) => ({ ...d, guardian: g.id }))
				).sort((a, b) => b.at - a.at).slice(0, 10)}
				{#if denies.length > 0}
					<div class="mt-4">
						<div class="text-xs uppercase tracking-wider text-slate-500 mb-2">
							Recent denies ({denies.length})
						</div>
						<ul class="space-y-1 text-xs">
							{#each denies as d (d.guardian + d.at)}
								<li class="font-mono text-slate-400 flex gap-3">
									<span class="text-slate-600">{fmtDate(d.at)}</span>
									<span class="text-slate-300">{d.guardian}</span>
									<span class="text-red-400">{d.reason}</span>
									{#if d.method || d.path}
										<span class="text-slate-600">
											{d.method || ''} {d.path || ''}
										</span>
									{/if}
									{#if d.ip_prefix}
										<span class="text-slate-600">({d.ip_prefix})</span>
									{/if}
								</li>
							{/each}
						</ul>
					</div>
				{/if}
			{/if}
		</section>
	{/if}
</div>
</div>
