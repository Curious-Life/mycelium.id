<script lang="ts">
	// Wizard Step 2 — Back up your recovery key (U1.3). THE ONE UNSKIPPABLE GATE:
	// a lost key = a permanently unrecoverable vault. Relocated out of /setup into
	// the wizard (the fresh vault was already silently created at the hero).
	//
	// ── SECURITY (CLAUDE.md §1/§4). This component reveals the single most
	// sensitive value in the system. Invariants held here:
	//  • The key is fetched FRESH at this gate (GET /api/v1/account/recovery-key,
	//    loopback-gated, reads the Keychain) — it is NEVER threaded through Step 1,
	//    so the raw key is out of JS memory during the handle step.
	//  • The key NEVER leaves this component: not logged, not sent anywhere. The
	//    password-manager save reads the key SERVER-SIDE (POST /recovery-key/save
	//    only carries {target}); the client never transmits the key back. The verify
	//    compare is purely client-side. The flag write carries NO key.
	//  • Pass is DELIBERATELY STRICT (do NOT soften): a real store-save (savedTo) OR
	//    the re-entry challenge (retype the 64-char key while it is off screen). A
	//    ticked box or a Download ALONE does not pass — that is how vaults get lost.
	//  • On pass we set the DURABLE `recovery_key_backed_up` flag and only THEN
	//    advance. A failed flag write does NOT advance (fail-closed) — the gate
	//    re-shows on relaunch until the flag lands.
	import { onMount } from 'svelte';
	import { api } from '$lib/api';

	// alreadyBackedUp: the durable flag is already set (a prior session passed this
	// gate but quit before finishing the wizard). Then there is nothing to reveal —
	// confirm + continue, no re-fetch of the key (less exposure).
	let { onNext, alreadyBackedUp = false }: { onNext: () => void; alreadyBackedUp?: boolean } = $props();

	type Phase = 'loading' | 'show' | 'verify' | 'no-key' | 'done-already' | 'load-error';
	let phase = $state<Phase>('loading');

	let recoveryKey = $state('');
	let keychainAvailable = $state(true);

	let copied = $state(false);
	let downloaded = $state(false);
	// One-click save into the OS store (server-side hand-off; key never returns to
	// the browser). A success counts as a real save (the savedTo pass path).
	let saving = $state<'keychain' | '1password' | null>(null);
	let savedTo = $state<'keychain' | '1password' | null>(null);
	let saveError = $state<string | null>(null);

	// Re-entry challenge: key HIDDEN, retype it to prove it is really saved.
	let verifyInput = $state('');
	const normalizedVerify = $derived(verifyInput.trim().replace(/\s+/g, '').toLowerCase());
	const verifyMatches = $derived(normalizedVerify.length === 64 && normalizedVerify === recoveryKey.toLowerCase());

	const grouped = $derived(recoveryKey ? recoveryKey.replace(/(.{4})/g, '$1 ').trim() : '');

	// The final commit: set the durable flag, then advance. Shown while the write is
	// in flight; a failure holds the gate (never advances) and surfaces the reason.
	let committing = $state(false);
	let commitError = $state<string | null>(null);

	onMount(async () => {
		if (alreadyBackedUp) { phase = 'done-already'; return; }
		try {
			// Read keychain availability (parity with /setup): if the OS store can't
			// hold the key, disable that save button and lean on the re-entry challenge.
			try {
				const st = await fetch('/api/v1/account/status', { credentials: 'same-origin' });
				if (st.ok) { const s = await st.json(); keychainAvailable = s.keychainAvailable !== false; }
			} catch { /* keep default true; the save button surfaces any real failure */ }

			// Fetch the key FRESH at the gate. Loopback-gated + no-store server-side.
			const res = await fetch('/api/v1/account/recovery-key', { credentials: 'same-origin' });
			if (res.status === 404) {
				// no_key: a passphrase lock stripped the plaintext key from the Keychain.
				// A FRESH onboarding has no lock so this cannot happen on the happy path;
				// but the gate must not ASSUME the key is fetchable. The vault is already
				// passphrase-protected (the user set that lock deliberately), so there is
				// nothing to reveal — let them past rather than brick the app.
				phase = 'no-key';
				return;
			}
			if (!res.ok) { phase = 'load-error'; return; }
			const data = await res.json().catch(() => ({}));
			if (typeof data.recoveryKey !== 'string' || data.recoveryKey.length !== 64) { phase = 'load-error'; return; }
			recoveryKey = data.recoveryKey;
			phase = 'show';
		} catch {
			phase = 'load-error';
		}
	});

	async function copyKey() {
		try { await navigator.clipboard.writeText(recoveryKey); copied = true; setTimeout(() => (copied = false), 1800); } catch { /* */ }
	}

	function downloadKey() {
		const body =
			'Mycelium recovery key\n\n' +
			'Keep this secret and safe. It is the ONLY way to recover your vault on a\n' +
			'new computer. Anyone with this key can read your vault. It cannot be reset.\n\n' +
			`Recovery key:\n${recoveryKey}\n\nSaved ${new Date().toISOString()}\n`;
		const url = URL.createObjectURL(new Blob([body], { type: 'text/plain' }));
		const a = document.createElement('a');
		a.href = url; a.download = 'mycelium-recovery-key.txt';
		document.body.appendChild(a); a.click(); a.remove();
		setTimeout(() => URL.revokeObjectURL(url), 1000);
		downloaded = true;
		setTimeout(() => (downloaded = false), 2500);
	}

	// One-click save to the OS store. The key is read SERVER-SIDE and handed to the
	// store — it never leaves the box via the browser. A success makes the key
	// retrievable, so it satisfies the pass gate (savedTo lets Continue skip the
	// re-entry challenge). "Keychain" = Keychain Access; 1Password needs the `op` CLI.
	async function saveKey(target: 'keychain' | '1password') {
		saving = target; saveError = null;
		try {
			const res = await fetch('/api/v1/account/recovery-key/save', {
				method: 'POST', credentials: 'same-origin',
				headers: { 'Content-Type': 'application/json' },
				body: JSON.stringify({ target }),
			});
			const data = await res.json().catch(() => ({}));
			if (!res.ok) throw new Error(data.message || data.error || 'Could not save');
			savedTo = target;
		} catch (e) {
			saveError = e instanceof Error ? e.message : 'Could not save';
		} finally { saving = null; }
	}

	// The ONLY way past this gate: record the durable backup flag, then advance.
	// Fail-closed — a failed write holds the gate and says why.
	async function commitAndAdvance() {
		if (committing) return;
		committing = true; commitError = null;
		try {
			const res = await api('/portal/onboarding/recovery-key-backed-up', { method: 'POST' });
			const data = await res.json().catch(() => ({}));
			if (!res.ok || data.ok !== true) throw new Error('write_failed');
			onNext();
		} catch {
			commitError = "Couldn't record your backup. Check the app is running and try again.";
		} finally { committing = false; }
	}
</script>

<div class="step-body">
	{#if phase === 'loading'}
		<h1 class="title">Back up your recovery key</h1>
		<p class="lede">Fetching your key…</p>

	{:else if phase === 'done-already'}
		<h1 class="title">Recovery key backed up</h1>
		<p class="lede">Your recovery key is already saved. You're all set.</p>
		<div class="actions">
			<button class="primary" disabled={committing} onclick={onNext}>Continue</button>
		</div>

	{:else if phase === 'no-key'}
		<h1 class="title">Back up your recovery key</h1>
		<p class="lede">
			Your recovery key is protected by your passphrase and can't be shown here.
			Keep that passphrase safe — it unlocks your vault.
		</p>
		{#if commitError}<p class="hint bad">{commitError}</p>{/if}
		<div class="actions">
			<button class="primary" disabled={committing} onclick={commitAndAdvance}>
				{committing ? 'Saving…' : 'Continue'}
			</button>
		</div>

	{:else if phase === 'load-error'}
		<h1 class="title">Back up your recovery key</h1>
		<p class="lede">We couldn't load your recovery key just now. This step can't be skipped — please try again.</p>
		<div class="actions">
			<button class="primary" onclick={() => { phase = 'loading'; location.reload(); }}>Try again</button>
		</div>

	{:else if phase === 'show'}
		<h1 class="title">Back up your recovery key</h1>
		<p class="lede">
			This is the <strong>only</strong> way to recover your vault on a new computer.
			Save it now — it can't be reset.
		</p>

		<div class="keybox">{grouped}</div>

		<div class="btn-row">
			<button class="ghost" onclick={copyKey}>{copied ? 'Copied ✓' : 'Copy'}</button>
			<button class="ghost" onclick={downloadKey}>{downloaded ? 'Downloaded ✓' : 'Download'}</button>
		</div>
		<div class="btn-row">
			<button class="ghost" onclick={() => saveKey('keychain')} disabled={saving !== null || !keychainAvailable}>
				{saving === 'keychain' ? 'Saving…' : savedTo === 'keychain' ? 'Saved to Keychain ✓' : 'Save to Keychain'}
			</button>
			<button class="ghost" onclick={() => saveKey('1password')} disabled={saving !== null}>
				{saving === '1password' ? 'Saving…' : savedTo === '1password' ? 'Saved to 1Password ✓' : 'Save to 1Password'}
			</button>
		</div>

		{#if !keychainAvailable}
			<p class="hint">The Keychain isn't available here — re-enter your key below to confirm you've saved it.</p>
		{/if}
		{#if savedTo !== '1password'}
			<!-- Saving to 1Password needs the `op` CLI installed + signed in (Finder-
			     launched apps don't inherit the shell PATH). A real install link (ON-2). -->
			<p class="hint">
				Saving to 1Password needs the
				<a href="https://developer.1password.com/docs/cli/get-started/" target="_blank" rel="noopener noreferrer">1Password CLI</a>
				installed &amp; signed in.
			</p>
		{/if}
		{#if saveError}<p class="hint bad">{saveError}</p>{/if}
		{#if commitError}<p class="hint bad">{commitError}</p>{/if}

		<div class="actions">
			{#if savedTo}
				<!-- A real save proves the key is retrievable → skip the re-entry challenge. -->
				<button class="primary" disabled={committing} onclick={commitAndAdvance}>
					{committing ? 'Saving…' : 'Saved — continue'}
				</button>
			{:else}
				<button class="primary" onclick={() => { verifyInput = ''; commitError = null; phase = 'verify'; }}>
					I've saved it — continue
				</button>
				<p class="sub-hint">Next: re-enter the key to confirm you can get back in.</p>
			{/if}
		</div>

	{:else if phase === 'verify'}
		<h1 class="title">Confirm your recovery key</h1>
		<p class="lede">
			Enter the recovery key you just saved. This proves you can really get back
			in — there is no reset if it's lost.
		</p>

		<input
			class="key-input"
			bind:value={verifyInput}
			type="text" autocomplete="off" spellcheck="false" data-1p-ignore data-lpignore="true"
			placeholder="Paste or type your recovery key"
			aria-label="Re-enter your recovery key"
			onkeydown={(e) => { if (e.key === 'Enter' && verifyMatches && !committing) commitAndAdvance(); }} />
		<div class="verify-hint">
			{#if normalizedVerify.length === 0}
				&nbsp;
			{:else if verifyMatches}
				<span class="ok">Matches ✓</span>
			{:else if normalizedVerify.length === 64}
				<span class="bad">That key doesn't match.</span>
			{:else}
				<span>{normalizedVerify.length}/64 characters</span>
			{/if}
		</div>
		{#if commitError}<p class="hint bad">{commitError}</p>{/if}

		<div class="actions">
			<button class="primary" disabled={!verifyMatches || committing} onclick={commitAndAdvance}>
				{committing ? 'Saving…' : 'Confirm & continue'}
			</button>
			<button class="link-btn" onclick={() => { phase = 'show'; commitError = null; }}>← Show my key again</button>
		</div>
	{/if}
</div>

<style>
	.step-body { display: flex; flex-direction: column; }
	.title {
		font-family: var(--font-serif, 'Geist', system-ui, sans-serif);
		font-size: 1.55rem; font-weight: 400; line-height: 1.15; letter-spacing: -0.015em;
		color: var(--color-text-primary); margin: 0 0 0.6rem;
	}
	.lede { font-size: 0.92rem; line-height: 1.55; color: var(--color-text-secondary); margin: 0 0 1.3rem; }
	.lede strong { color: var(--color-text-primary); font-weight: 600; }
	.keybox {
		padding: 0.9rem 1rem; border-radius: 11px;
		background: var(--glass-input-bg, rgba(0, 0, 0, 0.2));
		border: 1px solid var(--glass-input-border, rgba(255, 255, 255, 0.14));
		font-family: var(--font-mono, 'JetBrains Mono', monospace);
		font-size: 0.9rem; letter-spacing: 0.04em; line-height: 1.6;
		text-align: center; word-break: break-all;
		color: var(--color-text-primary); user-select: all; -webkit-user-select: all;
	}
	.btn-row { display: flex; gap: 0.5rem; margin-top: 0.7rem; }
	.ghost {
		flex: 1; padding: 0.55rem 0.6rem; border-radius: 9px;
		border: 1px solid var(--glass-input-border, rgba(255, 255, 255, 0.14));
		background: transparent; color: var(--color-text-primary);
		font-family: inherit; font-size: 0.82rem; cursor: pointer;
		transition: border-color 0.15s ease, opacity 0.15s ease;
	}
	.ghost:hover:not(:disabled) { border-color: var(--color-accent-aurum, #e5b84c); }
	.ghost:disabled { opacity: 0.5; cursor: default; }
	.hint { font-size: 0.75rem; line-height: 1.45; color: var(--color-text-tertiary); margin: 0.7rem 0 0; }
	.hint.bad { color: var(--color-coral, #e5736b); }
	.hint a { color: var(--color-text-secondary); text-decoration: underline; }
	.hint a:hover { color: var(--color-text-primary); }
	.sub-hint { font-size: 0.75rem; color: var(--color-text-tertiary); margin: 0.6rem 0 0; text-align: center; }
	.key-input {
		width: 100%; padding: 0.6rem 0.8rem; border-radius: 11px;
		background: var(--glass-input-bg, rgba(0, 0, 0, 0.2));
		border: 1px solid var(--glass-input-border, rgba(255, 255, 255, 0.14));
		font-family: var(--font-mono, 'JetBrains Mono', monospace);
		font-size: 0.9rem; letter-spacing: 0.03em; color: var(--color-text-primary);
		outline: none; transition: border-color 0.15s ease;
	}
	.key-input:focus { border-color: var(--color-accent-aurum, #e5b84c); }
	.verify-hint { min-height: 1.2rem; margin-top: 0.5rem; font-size: 0.76rem; text-align: center; color: var(--color-text-tertiary); }
	.verify-hint .ok { color: var(--color-accent-aurum, #e5b84c); }
	.verify-hint .bad { color: var(--color-coral, #e5736b); }
	.actions { margin-top: 1.5rem; display: flex; flex-direction: column; gap: 0.4rem; }
	.primary {
		display: inline-flex; align-items: center; justify-content: center; gap: 0.5rem;
		padding: 0.7rem 1.3rem; border-radius: 9px; border: none;
		background: var(--color-accent-aurum, #e5b84c); color: #0a0a0c;
		font-family: inherit; font-size: 0.9rem; font-weight: 500; cursor: pointer;
		transition: transform 0.15s ease, box-shadow 0.2s ease, opacity 0.15s ease;
	}
	.primary:hover:not(:disabled) { transform: translateY(-1px); box-shadow: 0 6px 20px rgba(229, 184, 76, 0.25); }
	.primary:disabled { opacity: 0.5; cursor: default; }
	.link-btn {
		background: none; border: none; padding: 0.4rem; font-family: inherit;
		font-size: 0.8rem; color: var(--color-text-tertiary); cursor: pointer;
	}
	.link-btn:hover { color: var(--color-text-secondary); }
</style>
