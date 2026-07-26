<!--
	Pair a phone by QR — the primary, no-typing path (the phone QR-pairing design).
	Shows a QR the phone scans, then an approval card (device name + 6-digit SAS to compare),
	and a list of paired devices with per-device revoke. The pairing ceremony is LOOPBACK-ONLY
	on the server, so this panel only works from the desktop portal (that is the intended
	trust root — you approve a new device at your Mac). Companion to PhoneConnectSection
	(the manual fallback).
-->
<script lang="ts">
	import { onMount, onDestroy } from 'svelte';
	import { api } from '$lib/api';

	type Pending = { pid: string; deviceLabel: string; sas: string };
	type Device = { id: number; device_label: string; created_at: string; last_seen_at: string | null; revoked_at: string | null };

	let qrSvg = $state<string | null>(null);
	let starting = $state(false);
	let startError = $state<string | null>(null);
	let pending = $state<Pending[]>([]);
	let devices = $state<Device[]>([]);
	let poll: ReturnType<typeof setInterval> | null = null;

	async function loadDevices() {
		try {
			const res = await api('/api/v1/portal/pair/devices');
			if (res.ok) devices = (await res.json()).devices ?? [];
		} catch { /* vault not ready */ }
	}

	async function refreshPending() {
		try {
			const res = await api('/api/v1/portal/pair/pending');
			if (res.ok) pending = (await res.json()).pending ?? [];
		} catch { /* transient */ }
	}

	async function startPair() {
		starting = true;
		startError = null;
		qrSvg = null;
		try {
			const [startRes, connRes] = await Promise.all([
				api('/api/v1/portal/pair/start', { method: 'POST' }),
				api('/api/v1/portal/phone-connect')
			]);
			if (!startRes.ok) { startError = 'Could not start pairing.'; return; }
			const s = await startRes.json();
			const conn = connRes.ok ? await connRes.json() : {};
			// Reachable base URLs the phone will try, in order (secure direct first).
			const addr = [conn.tailscaleUrl, conn.relayUrl].filter(Boolean);
			// E2E dial-out relay coords (Phase 3) — present only when the box dials out.
			// The phone tunnels /e2e/* through the relay when set; else direct to addr[].
			const relay = conn.relay ?? null;
			const payload = JSON.stringify({ v: 1, pid: s.pid, epk: s.epk, addr, relay });
			const QRCode = (await import('qrcode')).default;
			qrSvg = await QRCode.toString(payload, { type: 'svg', errorCorrectionLevel: 'M', margin: 1 });
			if (!addr.length) startError = 'No reachable address yet — set up Tailscale or the relay (see “Connect your phone” below), then re-pair.';
			await refreshPending();
		} catch {
			startError = 'Pairing failed to start.';
		} finally {
			starting = false;
		}
	}

	async function approve(pid: string) {
		await api('/api/v1/portal/pair/approve', { method: 'POST', body: JSON.stringify({ pid }) });
		qrSvg = null; // this session is done
		await Promise.all([refreshPending(), loadDevices()]);
	}
	async function deny(pid: string) {
		await api('/api/v1/portal/pair/deny', { method: 'POST', body: JSON.stringify({ pid }) });
		await refreshPending();
	}
	async function revoke(id: number) {
		await api(`/api/v1/portal/pair/devices/${id}/revoke`, { method: 'POST' });
		await loadDevices();
	}

	onMount(() => {
		loadDevices();
		poll = setInterval(refreshPending, 2000); // surface a claimed phone within ~2s
	});
	onDestroy(() => { if (poll) clearInterval(poll); });

	const liveDevices = $derived(devices.filter((d) => !d.revoked_at));
</script>

<section class="card p-5">
	<h2 class="text-xs font-medium text-[var(--color-text-tertiary)] uppercase tracking-wider mb-4">Pair a phone</h2>
	<p class="text-xs text-[var(--color-text-tertiary)] mb-4">
		Open the <span class="text-[var(--color-text-secondary)]">Mycelium</span> app on your phone, tap
		<span class="text-[var(--color-text-secondary)]">Scan QR</span>, and point it at the code below — no address or token to type.
	</p>

	{#if !qrSvg}
		<button class="btn-primary text-xs px-3 py-2" onclick={startPair} disabled={starting}>
			{starting ? 'Starting…' : 'Show pairing QR'}
		</button>
	{:else}
		<div class="flex flex-col items-center gap-3 mb-2">
			<div class="bg-white p-3 rounded-lg" style="width:220px;height:220px">{@html qrSvg}</div>
			<p class="text-[11px] text-[var(--color-text-tertiary)] text-center">
				Scan with the Mycelium app. This code expires in ~2 minutes.
			</p>
			<button class="text-[11px] text-[var(--color-text-tertiary)] cursor-pointer" onclick={() => (qrSvg = null)}>Done</button>
		</div>
	{/if}

	{#if startError}
		<p class="text-[11px] text-[var(--color-danger,#e06c75)] mt-2">{startError}</p>
	{/if}

	<!-- A phone that scanned + claimed is awaiting YOUR approval. Compare the code. -->
	{#each pending as p (p.pid)}
		<div class="mt-3 p-3 rounded border border-[var(--color-border)] space-y-2">
			<p class="text-xs text-[var(--color-text-secondary)]">
				<span class="text-[var(--color-text-primary)] font-medium">{p.deviceLabel}</span> wants to link.
			</p>
			<p class="text-[11px] text-[var(--color-text-tertiary)]">Confirm this code matches the one on the phone:</p>
			<p class="font-mono text-2xl text-aurum tracking-[0.3em]">{p.sas}</p>
			<div class="flex gap-2">
				<button class="btn-primary text-xs px-3 py-1.5" onclick={() => approve(p.pid)}>Approve</button>
				<button class="text-xs px-3 py-1.5 text-[var(--color-text-tertiary)] cursor-pointer" onclick={() => deny(p.pid)}>Deny</button>
			</div>
		</div>
	{/each}

	<!-- Paired devices -->
	{#if liveDevices.length}
		<div class="mt-5">
			<h3 class="text-[10px] font-medium text-[var(--color-text-tertiary)] uppercase tracking-wider mb-2">Paired devices</h3>
			<div class="space-y-1.5">
				{#each liveDevices as d (d.id)}
					<div class="flex items-center gap-2 text-xs p-2 rounded bg-[var(--color-elevated)]">
						<span class="text-[var(--color-text-primary)] truncate">{d.device_label}</span>
						{#if d.last_seen_at}<span class="text-[10px] text-[var(--color-text-tertiary)]">· last seen {d.last_seen_at}</span>{/if}
						<button class="ml-auto text-[10px] text-[var(--color-danger,#e06c75)] cursor-pointer shrink-0" onclick={() => revoke(d.id)}>Revoke</button>
					</div>
				{/each}
			</div>
		</div>
	{/if}

	<p class="text-[10px] text-[var(--color-text-tertiary)] mt-3">
		Each phone gets its own key. Revoking one here disconnects only that device — your other devices and the recovery key are unaffected.
	</p>
</section>
