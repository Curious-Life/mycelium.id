<!--
	Remote Access — one card, three ordered steps (C3 onboarding redesign 2026-06-25).

	Collapses what used to be TWO cards (ManagedConnectSection "Get your address" +
	the old RemoteAccessSection "Remote Access") into a single ordered flow, because
	the split was confusing: the operator password lived in one card while the other
	said "set the password below first." Now:

	  1 · Operator password   — the gate Claude authenticates against (POST /remote/password)
	  2 · Your address        — radio: a free handle.mycelium.id (managed relay) OR your
	                            own domain. Step 2 is disabled until a password exists, so
	                            the password-before-connect gate (src/remote/router.js:188)
	                            is enforced by ordering, not just a disabled button.
	  3 · Go live             — managed "Connect" or own-domain "Enable" (next launch).

	Passkey hardening + your-own-relay stay as collapsed "Advanced" disclosures.

	No backend change — same loopback endpoints as before (GET /api/v1/remote/status,
	POST /api/v1/remote/password, POST /api/v1/remote/config, the managed
	available/connect/disconnect/billing/turnstile routes). One status load owns the
	whole card so the password step and the address step can never disagree about
	`passwordSet` (the divergence the two-card layout was prone to). The desktop shell
	reads remoteEnabled/remoteMode at startup and owns the tunnel + OAuth child, so a
	change takes effect on the NEXT app launch.
-->
<script lang="ts">
	import { onMount } from 'svelte';
	import { api } from '$lib/api';

	type RemoteStatus = {
		remoteEnabled: boolean;
		publicBaseUrl: string;
		operatorEmail: string;
		passwordSet: boolean;
		httpListening: boolean;
		remoteMode?: string;
		publicHost?: string;
		controlPlaneUrl?: string;
		relayAddr?: string;
		requirePasskeyForWeb?: boolean;
		passkeyEnrolled?: boolean;
	};

	let status = $state<RemoteStatus | null>(null);
	let loading = $state(true);
	let error = $state<string | null>(null);

	// Step 2 — which address: a managed handle.mycelium.id, or your own domain.
	// Defaults to 'managed' (the easiest path); load() corrects it from saved state.
	let addressMode = $state<'managed' | 'own'>('managed');

	// Step 1 — operator password (the OAuth gate). Plaintext leaves the browser once;
	// the server hands it to better-auth, which stores only a hash.
	let newPassword = $state('');
	let pwSaving = $state(false);
	let pwMsg = $state<string | null>(null);
	let pwErr = $state<string | null>(null);

	// Managed address (handle claim + connect).
	let handle = $state('');
	let availability = $state<'idle' | 'checking' | 'available' | 'taken' | 'invalid' | 'unreachable'>('idle');
	let connecting = $state(false);
	let result = $state<{ host: string; connectorUrl: string } | null>(null);
	let mgError = $state<string | null>(null);
	let checkoutUrl = $state<string | null>(null); // set on a 402 (reserve-then-pay)
	let debounce: ReturnType<typeof setTimeout> | null = null;
	let reqSeq = 0;

	// Own-domain address (public HTTPS URL + enable toggle).
	let baseUrl = $state('');
	let cfgSaving = $state(false);
	let cfgErr = $state<string | null>(null);

	// Advanced — your own relay (O9): point the managed flow at a self-hosted control
	// plane + relay instead of mycelium.id. Non-secret coords via /config.
	let showOwnRelay = $state(false);
	let cpUrl = $state('');
	let relayAddr = $state('');
	let ownRelayMsg = $state<string | null>(null);

	// Advanced — passkey hardening disclosure.
	let showAdvanced = $state(false);

	const connected = $derived(status?.remoteMode === 'managed' && !!status?.publicHost);
	const connectorUrl = $derived(status?.publicBaseUrl ? status.publicBaseUrl.replace(/\/$/, '') + '/mcp' : '');

	// Turnstile bot-gate (O2). When the control plane runs Turnstile, it returns a
	// public sitekey; we embed its /turnstile page in a CROSS-ORIGIN iframe so
	// Cloudflare's script runs in the control-plane origin, never here. The widget
	// postMessages a token up; we accept it ONLY from `tsOrigin`. No sitekey ⇒ no
	// gate ⇒ no widget (Connect works as before, e.g. self-hosted / dev).
	let tsSitekey = $state<string | null>(null);
	let tsOrigin = $state<string | null>(null);
	let tsToken = $state<string | null>(null);
	let tsFrame = $state(0); // bump to remount the iframe for a fresh (single-use) token
	const tsRequired = $derived(!!tsSitekey);
	const tsSrc = $derived(
		tsSitekey && tsOrigin
			? `${tsOrigin}/turnstile?o=${encodeURIComponent(location.origin)}&_=${tsFrame}`
			: ''
	);

	function onTsMessage(e: MessageEvent) {
		if (!tsOrigin || e.origin !== tsOrigin) return; // accept only from the control-plane origin
		const d = e.data;
		if (!d || d.source !== 'mycelium-turnstile') return;
		if (typeof d.token === 'string' && d.token) {
			tsToken = d.token;
		} else if (d.error) {
			tsToken = null;
			if (d.error === 'expired') tsFrame++; // re-render for a fresh token
		}
	}
	function resetTurnstile() {
		tsToken = null;
		if (tsRequired) tsFrame++; // tokens are single-use — remount after each attempt
	}

	async function load() {
		loading = true;
		error = null;
		try {
			const res = await api('/api/v1/remote/status');
			if (!res.ok) throw new Error(`Failed to load (${res.status})`);
			status = (await res.json()) as RemoteStatus;
			baseUrl = status.publicBaseUrl ?? '';
			cpUrl = status.controlPlaneUrl ?? '';
			relayAddr = status.relayAddr ?? '';
			if (status.remoteMode === 'own-relay') showOwnRelay = true;
			// Infer the saved address mode: managed if connected via the relay,
			// otherwise own-domain if a public URL / own-relay is configured.
			if (status.remoteMode === 'managed') addressMode = 'managed';
			else if (status.publicBaseUrl || status.remoteMode === 'own-relay') addressMode = 'own';
		} catch (e: any) {
			error = e?.message || 'Failed to load remote-access status';
		} finally {
			loading = false;
		}
	}

	onMount(() => {
		load();
		// Best-effort: discover whether the control plane gates on Turnstile.
		(async () => {
			try {
				const res = await api('/api/v1/remote/managed/turnstile');
				const d = await res.json().catch(() => ({}));
				if (res.ok && typeof d.sitekey === 'string' && d.sitekey && typeof d.origin === 'string') {
					tsSitekey = d.sitekey;
					tsOrigin = d.origin;
				}
			} catch {
				/* no widget — Connect stays enabled (gate off / unreachable) */
			}
		})();
		window.addEventListener('message', onTsMessage);
		return () => window.removeEventListener('message', onTsMessage);
	});

	async function savePassword(e: Event) {
		e.preventDefault();
		pwSaving = true; pwMsg = null; pwErr = null;
		try {
			const res = await api('/api/v1/remote/password', {
				method: 'POST',
				body: JSON.stringify({ password: newPassword }),
			});
			const data = await res.json().catch(() => ({}));
			if (!res.ok) throw new Error(data.error || 'Failed to set password');
			newPassword = '';
			pwMsg = 'Password set. This is what Claude asks for when you connect.';
			await load();
		} catch (e: any) {
			pwErr = e?.message || 'Failed to set password';
		} finally {
			pwSaving = false;
		}
	}

	async function saveConfig(patch: Record<string, unknown>) {
		cfgSaving = true; cfgErr = null;
		try {
			const res = await api('/api/v1/remote/config', { method: 'POST', body: JSON.stringify(patch) });
			const data = await res.json().catch(() => ({}));
			if (!res.ok) throw new Error(data.error || 'Failed to save');
			await load();
		} catch (e: any) {
			cfgErr = e?.message || 'Failed to save config';
		} finally {
			cfgSaving = false;
		}
	}

	const saveBaseUrl = () => saveConfig({ publicBaseUrl: baseUrl.trim() });
	const toggleEnabled = (on: boolean) => saveConfig({ remoteEnabled: on });
	const togglePasskeyRequired = (on: boolean) => saveConfig({ requirePasskeyForWeb: on });

	// O9 — own-relay: persist the self-hosted control-plane + relay coords and mark
	// the mode. The managed flow then provisions against THIS control plane.
	async function saveOwnRelay() {
		ownRelayMsg = null;
		await saveConfig({ remoteMode: 'own-relay', controlPlaneUrl: cpUrl.trim(), relayAddr: relayAddr.trim() });
		if (!cfgErr) ownRelayMsg = 'Saved. Claim a handle below against your control plane, then restart.';
	}

	function onHandleInput() {
		availability = 'idle';
		result = null;
		mgError = null;
		checkoutUrl = null;
		if (debounce) clearTimeout(debounce);
		const h = handle.trim().toLowerCase();
		if (!/^[a-z0-9][a-z0-9-]{0,30}[a-z0-9]$/.test(h)) {
			if (h) availability = 'invalid';
			return;
		}
		availability = 'checking';
		const seq = ++reqSeq;
		debounce = setTimeout(async () => {
			try {
				const res = await api(`/api/v1/remote/managed/available?handle=${encodeURIComponent(h)}`);
				const data = await res.json().catch(() => ({}));
				if (seq !== reqSeq) return; // a newer keystroke superseded this response
				// Distinguish a genuine "taken" (control plane answered) from the control
				// plane being unreachable/errored — otherwise EVERY failure reads as "taken".
				if (res.ok && data.available) availability = 'available';
				else if (res.status >= 500 || data?.error === 'control plane unreachable') availability = 'unreachable';
				else availability = 'taken';
			} catch {
				if (seq === reqSeq) availability = 'unreachable';
			}
		}, 400);
	}

	async function connect() {
		connecting = true;
		mgError = null;
		result = null;
		checkoutUrl = null;
		try {
			const body: { handle: string; turnstileToken?: string } = { handle: handle.trim().toLowerCase() };
			if (tsRequired && tsToken) body.turnstileToken = tsToken;
			const res = await api('/api/v1/remote/connect-managed', {
				method: 'POST',
				body: JSON.stringify(body),
			});
			const data = await res.json().catch(() => ({}));
			// Reserve-then-pay (O5): the handle is held; open Stripe Checkout. After
			// paying, the user re-solves the bot check and clicks Connect again
			// (now entitled). The control plane already validated the URL is https.
			if (res.status === 402 && data.checkoutUrl) {
				checkoutUrl = data.checkoutUrl;
				return;
			}
			if (!res.ok || !data.ok) throw new Error(data.error || 'Could not connect');
			result = { host: data.host, connectorUrl: data.connectorUrl };
			await load();
		} catch (e: any) {
			mgError = e?.message || 'Could not connect';
		} finally {
			connecting = false;
			resetTurnstile(); // the token is single-use whether we succeeded or failed
		}
	}

	async function disconnect() {
		connecting = true;
		mgError = null;
		try {
			await api('/api/v1/remote/disconnect', { method: 'POST' });
			result = null;
			await load();
		} catch (e: any) {
			mgError = e?.message || 'Could not disconnect';
		} finally {
			connecting = false;
		}
	}

	// Manage billing (O7): open the Stripe Customer Portal for this managed address
	// (cancel / update card / see paid_until). A 404 means "no subscription yet".
	let billingBusy = $state(false);
	async function manageBilling() {
		billingBusy = true;
		mgError = null;
		try {
			const res = await api('/api/v1/remote/managed/billing-portal');
			const data = await res.json().catch(() => ({}));
			if (res.status === 404) { mgError = 'No subscription on file yet.'; return; }
			if (!res.ok || !data.url) throw new Error(data.error || 'Could not open billing');
			window.open(data.url, '_blank', 'noopener,noreferrer');
		} catch (e: any) {
			mgError = e?.message || 'Could not open billing';
		} finally {
			billingBusy = false;
		}
	}

	const inputCls =
		'w-full px-3 py-2 text-sm bg-[var(--color-bg)] border border-[var(--color-border)] rounded text-[var(--color-text-primary)] focus:border-aurum outline-none';
	const monoInputCls =
		'w-full px-3 py-2 text-xs font-mono bg-[var(--color-bg)] border border-[var(--color-border)] rounded text-[var(--color-text-primary)] focus:border-aurum outline-none';
	const btnCls =
		'text-xs px-3 py-1.5 rounded bg-[var(--color-accent)] text-[var(--color-bg)] cursor-pointer disabled:opacity-50';
	const ghostBtnCls =
		'text-xs px-3 py-1.5 rounded border border-[var(--color-border)] text-[var(--color-text-secondary)] cursor-pointer disabled:opacity-50';
</script>

<section class="card p-5">
	<h2 class="text-xs font-medium text-[var(--color-text-tertiary)] uppercase tracking-wider mb-1">Remote access</h2>
	<p class="text-xs text-[var(--color-text-tertiary)] mb-4">
		Reach this vault from Claude (mobile or web) over the internet. Three steps — set a password, pick an address, go live. Your data stays encrypted on this Mac; <strong>TLS terminates here</strong>, so a relay only ever forwards ciphertext.
	</p>

	{#if loading}
		<div class="text-sm text-[var(--color-text-tertiary)] animate-pulse">Loading…</div>
	{:else if error}
		<div class="text-xs text-red-400 mb-3 p-2 rounded bg-red-500/10">{error}</div>
	{:else if status}
		<!-- Live state -->
		<div class="flex flex-wrap gap-2 mb-5 text-[10px] uppercase tracking-wider">
			<span class="px-2 py-1 rounded {(status.remoteEnabled || connected) ? 'bg-green-500/15 text-green-400' : 'bg-[var(--color-elevated)] text-[var(--color-text-tertiary)]'}">{(status.remoteEnabled || connected) ? 'Live' : 'Off'}</span>
			<span class="px-2 py-1 rounded {status.httpListening ? 'bg-green-500/15 text-green-400' : 'bg-[var(--color-elevated)] text-[var(--color-text-tertiary)]'}">{status.httpListening ? 'Server running' : 'Server stopped'}</span>
			<span class="px-2 py-1 rounded {status.passwordSet ? 'bg-green-500/15 text-green-400' : 'bg-amber-500/15 text-amber-400'}">{status.passwordSet ? 'Password set' : 'No password yet'}</span>
		</div>

		{#if (status.remoteEnabled || connected) && !status.httpListening}
			<div class="text-xs text-amber-400 mb-4 p-2 rounded bg-amber-500/10">Enabled — restart the app to start the remote server.</div>
		{/if}

		<!-- ───────── Step 1 — Operator password (the gate) ───────── -->
		<div class="step">
			<div class="step-head">
				<span class="step-num {status.passwordSet ? 'done' : ''}">{status.passwordSet ? '✓' : '1'}</span>
				<span>Operator password</span>
			</div>
			<div class="step-body">
				<p class="text-[11px] text-[var(--color-text-tertiary)] mb-2">This is what Claude asks for when it connects. Sign-in email: <span class="font-mono">{status.operatorEmail}</span></p>
				<form onsubmit={savePassword} class="space-y-2">
					<input id="remote-pw" type="password" bind:value={newPassword} placeholder={status.passwordSet ? 'Enter a new password to change it' : 'at least 12 characters'} autocomplete="new-password" class={inputCls} />
					<div class="flex items-center gap-3">
						<button type="submit" disabled={pwSaving || newPassword.length < 12} class={btnCls}>{pwSaving ? 'Saving…' : status.passwordSet ? 'Change password' : 'Set password'}</button>
						{#if pwMsg}<span class="text-xs text-green-400">{pwMsg}</span>{/if}
						{#if pwErr}<span class="text-xs text-red-400">{pwErr}</span>{/if}
					</div>
				</form>
			</div>
		</div>

		<!-- ───────── Step 2 — Your address (gated on a password) ───────── -->
		<div class="step" class:locked={!status.passwordSet}>
			<div class="step-head">
				<span class="step-num">2</span>
				<span>Your address</span>
			</div>
			<div class="step-body">
				{#if !status.passwordSet}
					<p class="text-[11px] text-amber-400">Set an operator password first — it's the gate Claude authenticates against.</p>
				{:else}
					<!-- address-mode radio -->
					<div class="flex flex-col gap-2 mb-4">
						<label class="addr-opt {addressMode === 'managed' ? 'sel' : ''}">
							<input type="radio" name="addr" value="managed" bind:group={addressMode} class="accent-[var(--color-accent)]" />
							<span>
								<span class="text-[var(--color-text-primary)]">Free <span class="font-mono">handle.mycelium.id</span></span>
								<span class="block text-[10px] text-[var(--color-text-tertiary)]">One-click managed relay · €1/mo · nothing to host</span>
							</span>
						</label>
						<label class="addr-opt {addressMode === 'own' ? 'sel' : ''}">
							<input type="radio" name="addr" value="own" bind:group={addressMode} class="accent-[var(--color-accent)]" />
							<span>
								<span class="text-[var(--color-text-primary)]">Your own domain</span>
								<span class="block text-[10px] text-[var(--color-text-tertiary)]">Bring your own tunnel + HTTPS URL · free · you host it</span>
							</span>
						</label>
					</div>

					{#if addressMode === 'managed'}
						<!-- Managed: claim a handle.mycelium.id and connect in one step. -->
						{#if connected}
							<div class="text-xs text-green-400 mb-2 p-2 rounded bg-green-500/10">Connected as <span class="font-mono">{status.publicHost}</span></div>
							{#if connectorUrl}
								<p class="text-[10px] text-[var(--color-text-tertiary)]">Add this in Claude → Connectors: <span class="font-mono text-[var(--color-text-secondary)]">{connectorUrl}</span></p>
							{/if}
							<div class="mt-3 flex gap-2">
								<button onclick={disconnect} disabled={connecting} class={ghostBtnCls}>Disconnect</button>
								<button onclick={manageBilling} disabled={billingBusy} class={ghostBtnCls}>{billingBusy ? 'Opening…' : 'Manage billing'}</button>
							</div>
							<p class="text-[10px] text-[var(--color-text-tertiary)] mt-2 leading-relaxed">
								If a payment lapses, your tunnel keeps running through a short grace period, then stops at the next reconnect. Your handle is held for a while before the name is freed — re-subscribe any time to keep it.
							</p>
						{:else}
							<div class="flex gap-2 items-center">
								<input bind:value={handle} oninput={onHandleInput} placeholder="your-handle" autocomplete="off" spellcheck="false" class={inputCls} />
								<span class="text-xs text-[var(--color-text-tertiary)] font-mono whitespace-nowrap">.mycelium.id</span>
								<button onclick={connect} disabled={connecting || availability !== 'available' || (tsRequired && !tsToken)} class={btnCls}>{connecting ? 'Connecting…' : 'Connect'}</button>
							</div>
							<div class="text-[10px] mt-1 h-4">
								{#if availability === 'checking'}<span class="text-[var(--color-text-tertiary)]">checking…</span>
								{:else if availability === 'available'}<span class="text-green-400">✓ available</span>
								{:else if availability === 'taken'}<span class="text-red-400">taken</span>
								{:else if availability === 'unreachable'}<span class="text-amber-400">address service unreachable — can't check right now</span>
								{:else if availability === 'invalid'}<span class="text-amber-400">2–32 chars: a–z, 0–9, dashes</span>{/if}
							</div>
							{#if tsRequired && tsSrc}
								<!-- Cross-origin: Cloudflare's script runs in the control-plane origin, not in this vault portal. -->
								<div class="mt-2">
									<iframe src={tsSrc} title="Bot check" class="w-[300px] h-[72px] border-0 block" referrerpolicy="no-referrer"></iframe>
									{#if !tsToken}<p class="text-[10px] text-[var(--color-text-tertiary)] mt-1">Complete the bot check to enable Connect.</p>{/if}
								</div>
							{/if}
							{#if checkoutUrl}
								<div class="text-xs mt-3 p-2 rounded bg-aurum/10 text-[var(--color-text-secondary)]">
									<span class="font-mono">{handle.trim().toLowerCase()}.mycelium.id</span> is reserved. The managed relay is <strong>€1/mo</strong> (free if you bring your own domain or relay).
									<a href={checkoutUrl} target="_blank" rel="noopener noreferrer" class="inline-block mt-2 text-xs px-3 py-1.5 rounded bg-[var(--color-accent)] text-[var(--color-bg)] no-underline">Pay €1/mo →</a>
									<p class="text-[10px] text-[var(--color-text-tertiary)] mt-1">After paying, complete the bot check again and click Connect to finish.</p>
								</div>
							{/if}
							{#if result}
								<div class="text-xs text-green-400 mt-3 p-2 rounded bg-green-500/10">Address ready: <span class="font-mono">{result.connectorUrl}</span> — restart the app to go live.</div>
							{/if}
						{/if}
						{#if mgError}<div class="text-xs text-red-400 mt-2">{mgError}</div>{/if}
					{:else}
						<!-- Own domain: public HTTPS URL + enable toggle. -->
						<div class="space-y-2">
							<label class="block text-[10px] uppercase tracking-wider text-[var(--color-text-tertiary)]" for="remote-url">Public URL (your tunnel's HTTPS address)</label>
							<div class="flex gap-2">
								<input id="remote-url" type="url" bind:value={baseUrl} placeholder="https://mycelium.yourdomain.com" class={monoInputCls} />
								<button onclick={saveBaseUrl} disabled={cfgSaving} class={btnCls}>Save</button>
							</div>
							{#if connectorUrl}
								<p class="text-[10px] text-[var(--color-text-tertiary)]">Add this in Claude → Connectors: <span class="font-mono text-[var(--color-text-secondary)]">{connectorUrl}</span></p>
							{/if}
						</div>

						<!-- Step 3 (own-domain) — enable -->
						<div class="mt-4 pt-3 border-t border-[var(--color-border)]">
							<label class="flex items-center gap-2 text-xs text-[var(--color-text-secondary)]">
								<input type="checkbox" checked={status.remoteEnabled} disabled={cfgSaving || !status.publicBaseUrl}
									onchange={(e) => toggleEnabled((e.target as HTMLInputElement).checked)} class="accent-[var(--color-accent)]" />
								Enable remote access (starts the OAuth server on next launch)
							</label>
							{#if status.remoteEnabled}
								<button onclick={() => toggleEnabled(false)} disabled={cfgSaving} class="mt-2 {ghostBtnCls}">Disconnect (disable remote access)</button>
							{/if}
							{#if !status.publicBaseUrl}
								<p class="text-[10px] text-[var(--color-text-tertiary)] mt-1">Save a public URL first.</p>
							{/if}
						</div>
						{#if cfgErr}<div class="text-xs text-red-400 mt-2">{cfgErr}</div>{/if}
					{/if}
				{/if}
			</div>
		</div>

		<!-- ───────── Advanced disclosures ───────── -->
		<div class="mt-2 pt-4 border-t border-[var(--color-border)]">
			<button onclick={() => (showAdvanced = !showAdvanced)} class="text-[10px] uppercase tracking-wider text-[var(--color-text-tertiary)] hover:text-[var(--color-text-secondary)] cursor-pointer">
				{showAdvanced ? '▾' : '▸'} Advanced — passkey & own relay
			</button>
			{#if showAdvanced}
				<!-- Require a passkey for web sign-in (hardening). Enableable only once a
				     passkey is enrolled; auto-disables if you change your public host. -->
				<div class="mt-3">
					<label class="flex items-center gap-2 text-xs text-[var(--color-text-secondary)]">
						<input type="checkbox" checked={status.requirePasskeyForWeb} disabled={cfgSaving || !status.passkeyEnrolled}
							onchange={(e) => togglePasskeyRequired((e.target as HTMLInputElement).checked)} class="accent-[var(--color-accent)]" />
						Require a passkey for web sign-in (password alone won't work over the web)
					</label>
					{#if !status.passkeyEnrolled}
						<p class="text-[10px] text-[var(--color-text-tertiary)] mt-1">Enroll a passkey first (sign in over the web once, then “Set up a passkey”). Your local desktop access and recovery key always work.</p>
					{/if}
				</div>

				<!-- Your own relay (O9). -->
				<div class="mt-4">
					<button onclick={() => (showOwnRelay = !showOwnRelay)} class="text-[10px] uppercase tracking-wider text-[var(--color-text-tertiary)] hover:text-[var(--color-text-secondary)] cursor-pointer">
						{showOwnRelay ? '▾' : '▸'} Your own relay (control plane + FRP)
					</button>
					{#if showOwnRelay}
						<p class="text-[10px] text-[var(--color-text-tertiary)] mt-2 mb-3 leading-relaxed">
							Run the open-source <span class="font-mono">mycelium-managed</span> control plane + an FRP relay yourself, then claim a managed handle (above) against <em>your</em> control plane. No mycelium.id round-trip, no fee.
						</p>
						<div class="space-y-2">
							<label class="block text-[10px] uppercase tracking-wider text-[var(--color-text-tertiary)]" for="cp-url">Control plane URL</label>
							<input id="cp-url" type="url" bind:value={cpUrl} placeholder="https://connect.yourdomain.com" class={monoInputCls} />
							<label class="block text-[10px] uppercase tracking-wider text-[var(--color-text-tertiary)]" for="relay-addr">Relay address (host:port)</label>
							<input id="relay-addr" type="text" bind:value={relayAddr} placeholder="relay.yourdomain.com:7000" class={monoInputCls} />
							<button onclick={saveOwnRelay} disabled={cfgSaving} class={btnCls}>{cfgSaving ? 'Saving…' : 'Save own-relay'}</button>
							{#if ownRelayMsg}<div class="text-xs text-green-400">{ownRelayMsg}</div>{/if}
						</div>
					{/if}
				</div>
			{/if}
		</div>
	{/if}
</section>

<style>
	.step {
		position: relative;
		padding: 0 0 1.25rem 0;
	}
	.step-head {
		display: flex;
		align-items: center;
		gap: 0.5rem;
		font-size: 0.8125rem;
		font-weight: 500;
		color: var(--color-text-primary);
		margin-bottom: 0.5rem;
	}
	.step-num {
		display: inline-flex;
		align-items: center;
		justify-content: center;
		width: 1.25rem;
		height: 1.25rem;
		border-radius: 9999px;
		background: var(--color-elevated);
		color: var(--color-text-tertiary);
		font-size: 0.6875rem;
		font-weight: 600;
		flex: none;
	}
	.step-num.done {
		background: color-mix(in srgb, var(--color-accent) 18%, transparent);
		color: var(--color-accent);
	}
	.step-body {
		padding-left: 1.75rem;
	}
	.step.locked .step-body {
		opacity: 0.55;
	}
	.addr-opt {
		display: flex;
		align-items: flex-start;
		gap: 0.5rem;
		padding: 0.625rem 0.75rem;
		border: 1px solid var(--color-border);
		border-radius: 0.5rem;
		cursor: pointer;
		font-size: 0.75rem;
		line-height: 1.3;
	}
	.addr-opt.sel {
		border-color: var(--color-accent);
		background: color-mix(in srgb, var(--color-accent) 7%, transparent);
	}
	.addr-opt input {
		margin-top: 0.15rem;
		flex: none;
	}
</style>
