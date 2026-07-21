<!--
	Passkeys — manage the WebAuthn credentials that sign you in to your vault over
	the web (Face ID / Touch ID / a security key). See each passkey (name · added ·
	last used), add a new one, rename, or remove old ones.

	WHY the /api/auth surface (not /portal/passkeys): passkeys are owned by the
	@better-auth/passkey plugin on the OAuth server (:4711). A credential is bound
	to the relay origin's rpID (<handle>.mycelium.id), so the ceremony MUST run on
	that origin against better-auth's own endpoints — same pattern as the web
	login page (routes/login/+page.svelte). The edge routes /api/auth/* → :4711.

	  · list    → GET  /api/auth/passkeys            (app endpoint: enriches
	                                                   better-auth's list with the
	                                                   app-local last_used_at column)
	  · add     → GET  /api/auth/passkey/generate-register-options  → startRegistration
	              → POST /api/auth/passkey/verify-registration
	  · rename  → POST /api/auth/passkey/update-passkey   { id, name }
	  · remove  → POST /api/auth/passkey/delete-passkey   { id }

	All calls are same-origin with the better-auth session cookie; register/rename/
	delete are owner-scoped server-side by better-auth (sessionMiddleware +
	requireResourceOwnership). No vault data crosses this surface, so it uses plain
	same-origin fetch (like the login page), not the Noise /portal channel.

	FAIL-CLOSED (no lockout): the require-passkey-for-web policy is enforced as
	`requirePasskeyForWeb && passkeyEnrolled()` (server-http.js:webPasswordLoginBlocked)
	— removing the last passkey makes passkeyEnrolled() false, which AUTO-LIFTS the
	requirement, so password + the loopback recovery key remain as factors. A passkey
	is never the sole factor; we still WARN before removing the last one when the
	policy is on (it re-enables web password sign-in).

	Passkeys can only be managed from the vault's web address — on the desktop app
	(served from the loopback interface) the /api/auth surface isn't served, so we
	show guidance instead.
-->
<script lang="ts">
	import { onMount } from 'svelte';
	import { startRegistration } from '@simplewebauthn/browser';
	import { relativeTime } from '$lib/streams/sources';

	type Passkey = {
		id: string;
		name: string | null;
		createdAt: string | null;
		lastUsedAt: string | null;
		deviceType: string | null;
		backedUp: boolean;
	};

	// 'loading' → first load; 'ready' → panel; 'unavailable' → not on the web
	// address (local app); 'signin' → reachable but no web session yet.
	let phase = $state<'loading' | 'ready' | 'unavailable' | 'signin'>('loading');
	let passkeys = $state<Passkey[]>([]);
	let requirePasskeyForWeb = $state(false);
	let error = $state<string | null>(null);

	let registering = $state(false);
	let newName = $state('');

	// Inline per-row state (rename edit buffer + delete confirm).
	let renamingId = $state<string | null>(null);
	let renameBuffer = $state('');
	let renameBusy = $state(false);
	let confirmDeleteId = $state<string | null>(null);
	let deleteBusy = $state(false);

	async function load() {
		error = null;
		try {
			const res = await fetch('/api/auth/passkeys', {
				credentials: 'same-origin',
				headers: { accept: 'application/json' },
			});
			if (res.status === 401) { phase = 'signin'; return; }
			if (!res.ok) { phase = 'unavailable'; return; }
			// A JSON body confirms we hit the :4711 endpoint; anything else (e.g. the
			// SPA's index.html on a local-only build) means the surface isn't here.
			const ct = res.headers.get('content-type') || '';
			if (!ct.includes('application/json')) { phase = 'unavailable'; return; }
			const data = await res.json();
			passkeys = Array.isArray(data?.passkeys) ? data.passkeys : [];
			requirePasskeyForWeb = data?.requirePasskeyForWeb === true;
			phase = 'ready';
		} catch {
			// Network failure = the /api/auth surface isn't reachable from here (the
			// local desktop app), not a real error the operator must act on.
			phase = 'unavailable';
		}
	}

	onMount(load);

	async function register() {
		if (registering) return;
		registering = true;
		error = null;
		try {
			const label = (newName.trim() || 'This device').slice(0, 60);
			const optRes = await fetch(
				`/api/auth/passkey/generate-register-options?name=${encodeURIComponent(label)}`,
				{ credentials: 'same-origin' },
			);
			if (optRes.status === 401) { phase = 'signin'; return; }
			if (!optRes.ok) throw new Error('Could not start passkey setup');
			const options = await optRes.json();
			const credential = await startRegistration({ optionsJSON: options });
			const response: Record<string, unknown> = { ...(credential as unknown as Record<string, unknown>) };
			delete response.clientExtensionResults;
			const verRes = await fetch('/api/auth/passkey/verify-registration', {
				method: 'POST',
				headers: { 'Content-Type': 'application/json' },
				credentials: 'same-origin',
				body: JSON.stringify({ response, name: label }),
			});
			if (!verRes.ok) throw new Error('Passkey setup failed');
			newName = '';
			await load();
		} catch (e) {
			error = (e instanceof Error && e.name === 'NotAllowedError')
				? 'Passkey setup cancelled'
				: (e instanceof Error ? e.message : 'Passkey setup failed');
		} finally {
			registering = false;
		}
	}

	function startRename(pk: Passkey) {
		renamingId = pk.id;
		renameBuffer = pk.name || '';
		confirmDeleteId = null;
	}

	async function saveRename() {
		const id = renamingId;
		const name = renameBuffer.trim();
		if (!id || !name || renameBusy) return;
		renameBusy = true;
		error = null;
		try {
			const res = await fetch('/api/auth/passkey/update-passkey', {
				method: 'POST',
				headers: { 'Content-Type': 'application/json' },
				credentials: 'same-origin',
				body: JSON.stringify({ id, name: name.slice(0, 60) }),
			});
			if (!res.ok) throw new Error('Rename failed');
			renamingId = null;
			renameBuffer = '';
			await load();
		} catch (e) {
			error = e instanceof Error ? e.message : 'Rename failed';
		} finally {
			renameBusy = false;
		}
	}

	async function remove(id: string) {
		if (deleteBusy) return;
		deleteBusy = true;
		error = null;
		try {
			const res = await fetch('/api/auth/passkey/delete-passkey', {
				method: 'POST',
				headers: { 'Content-Type': 'application/json' },
				credentials: 'same-origin',
				body: JSON.stringify({ id }),
			});
			if (!res.ok) throw new Error('Could not remove passkey');
			confirmDeleteId = null;
			await load();
		} catch (e) {
			error = e instanceof Error ? e.message : 'Could not remove passkey';
		} finally {
			deleteBusy = false;
		}
	}

	// Removing the LAST passkey while require-passkey-for-web is on re-enables web
	// password sign-in (the policy is inert without a passkey) — warn, don't block.
	const isLastPasskey = $derived(passkeys.length === 1);
</script>

<section class="card p-5">
	<h2 class="text-xs font-medium text-[var(--color-text-tertiary)] uppercase tracking-wider mb-4">Passkeys</h2>

	{#if phase === 'loading'}
		<p class="text-sm text-[var(--color-text-tertiary)]">Loading…</p>

	{:else if phase === 'unavailable'}
		<p class="text-sm text-[var(--color-text-primary)]">Passkeys secure web sign-in to your vault</p>
		<p class="text-xs text-[var(--color-text-tertiary)] mt-1">
			A passkey (Face ID, Touch ID, or a security key) is bound to your vault's web address.
			Open your vault at its web address (your <span class="font-mono">handle.mycelium.id</span>)
			in a browser to add or manage passkeys. You can turn remote access on under Connections.
		</p>

	{:else if phase === 'signin'}
		<p class="text-sm text-[var(--color-text-primary)]">Sign in to manage passkeys</p>
		<p class="text-xs text-[var(--color-text-tertiary)] mt-1">
			Sign in to your vault over the web first, then return here to add or manage passkeys.
		</p>

	{:else}
		<p class="text-xs text-[var(--color-text-tertiary)] mb-4">
			Passkeys let you sign in to your vault on the web with Face ID, Touch ID, or a security key —
			no password to phish. Your recovery key and password still work as backups.
		</p>

		{#if passkeys.length === 0}
			<div class="p-3 rounded-lg bg-[var(--color-elevated)] border border-[var(--color-border)] text-sm text-[var(--color-text-tertiary)]">
				No passkeys yet. Add one below to sign in without your password.
			</div>
		{:else}
			<ul class="flex flex-col gap-2">
				{#each passkeys as pk (pk.id)}
					<li class="p-3 rounded-lg bg-[var(--color-elevated)] border border-[var(--color-border)]">
						{#if renamingId === pk.id}
							<div class="flex flex-wrap items-center gap-2">
								<input
									bind:value={renameBuffer}
									maxlength="60"
									placeholder="Passkey name"
									onkeydown={(e) => { if (e.key === 'Enter') saveRename(); if (e.key === 'Escape') { renamingId = null; } }}
									class="input flex-1 min-w-[10rem] text-sm"
								/>
								<button onclick={saveRename} disabled={renameBusy || !renameBuffer.trim()}
									class="px-3 py-1.5 rounded-lg bg-[var(--color-accent)] text-[var(--color-bg)] text-sm font-medium disabled:opacity-50">{renameBusy ? 'Saving…' : 'Save'}</button>
								<button onclick={() => { renamingId = null; renameBuffer = ''; }}
									class="px-3 py-1.5 rounded-lg text-sm text-[var(--color-text-tertiary)] hover:text-[var(--color-text-primary)]">Cancel</button>
							</div>
						{:else}
							<div class="flex items-start justify-between gap-3">
								<div class="min-w-0">
									<p class="text-sm text-[var(--color-text-primary)] truncate">
										{pk.name || 'Unnamed passkey'}
										{#if pk.backedUp}<span class="ml-2 text-[10px] uppercase tracking-wider text-[var(--color-text-tertiary)] align-middle">Synced</span>{/if}
									</p>
									<p class="text-xs text-[var(--color-text-tertiary)] mt-0.5">
										Added {pk.createdAt ? relativeTime(pk.createdAt) : '—'}
										· {pk.lastUsedAt ? `last used ${relativeTime(pk.lastUsedAt)}` : 'never used'}
									</p>
								</div>
								<div class="flex items-center gap-1 flex-shrink-0">
									<button onclick={() => startRename(pk)}
										class="px-2.5 py-1.5 rounded-lg text-sm text-[var(--color-text-tertiary)] hover:text-[var(--color-text-primary)] hover:bg-[var(--color-surface)] transition-colors">Rename</button>
									<button onclick={() => { confirmDeleteId = pk.id; renamingId = null; }}
										class="px-2.5 py-1.5 rounded-lg text-sm text-coral hover:bg-coral/10 transition-colors">Remove</button>
								</div>
							</div>

							{#if confirmDeleteId === pk.id}
								<div class="mt-3 pt-3 border-t border-[var(--color-border)]">
									{#if isLastPasskey && requirePasskeyForWeb}
										<p class="text-xs text-[var(--color-text-primary)]">
											This is your last passkey. Removing it will re-enable password sign-in on the web
											(the require-passkey setting stays off until you add a passkey again). Your recovery key
											and password still open the vault.
										</p>
									{:else}
										<p class="text-xs text-[var(--color-text-primary)]">
											Remove this passkey? You won't be able to sign in with it anymore.
											Your recovery key and password still work.
										</p>
									{/if}
									<div class="flex gap-2 mt-2">
										<button onclick={() => remove(pk.id)} disabled={deleteBusy}
											class="px-3 py-1.5 rounded-lg bg-coral text-white text-sm font-medium disabled:opacity-50">{deleteBusy ? 'Removing…' : 'Remove passkey'}</button>
										<button onclick={() => { confirmDeleteId = null; }}
											class="px-3 py-1.5 rounded-lg text-sm text-[var(--color-text-tertiary)] hover:text-[var(--color-text-primary)]">Cancel</button>
									</div>
								</div>
							{/if}
						{/if}
					</li>
				{/each}
			</ul>
		{/if}

		<div class="flex flex-wrap items-center gap-2 mt-4">
			<input
				bind:value={newName}
				maxlength="60"
				placeholder="Name (optional, e.g. “MacBook”)"
				onkeydown={(e) => { if (e.key === 'Enter') register(); }}
				class="input flex-1 min-w-[12rem] text-sm"
			/>
			<button onclick={register} disabled={registering}
				class="px-3 py-2 rounded-lg bg-[var(--color-accent)] text-[var(--color-bg)] text-sm font-medium disabled:opacity-50 whitespace-nowrap">{registering ? 'Waiting for device…' : 'Register a passkey'}</button>
		</div>
	{/if}

	{#if error}
		<p class="text-xs text-coral mt-3">{error}</p>
	{/if}
</section>
