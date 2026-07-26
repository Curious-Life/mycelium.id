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
	//  • Pass is DELIBERATELY STRICT (do NOT soften): the ONLY pass path is the
	//    re-entry challenge (retype the 64-char key while it is off screen). Copy /
	//    Download / Print-QR / a same-machine Keychain copy do NOT pass on their
	//    own — a Keychain copy is not an off-machine backup, and a bare download is
	//    unproven; that is how vaults get lost (D-027).
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

	// Reveal is HIDDEN BY DEFAULT (shoulder-surf protection). Copy / Download /
	// Print-QR operate on the in-memory key regardless — they are deliberate user
	// actions — but the key is only PRINTED ON SCREEN once the user asks.
	let revealed = $state(false);

	let copied = $state(false);
	let downloaded = $state(false);

	// Print / QR — a scannable QR of the 64-hex (into a phone manager) + a
	// print-friendly sheet. The QR is generated ENTIRELY CLIENT-SIDE (the `qrcode`
	// package, already bundled) — the key never leaves the box, no remote asset,
	// no network (CSP `img-src 'self' data:`; CLAUDE.md §1). Data URL stays in
	// memory only; never logged, never persisted.
	let showQr = $state(false);
	let qrDataUrl = $state('');
	let qrError = $state<string | null>(null);

	// One-click save a COPY to this Mac's Keychain (server-side hand-off; the key
	// never returns to the browser). This is an ON-DEVICE CONVENIENCE, NOT a
	// backup — it lives on this machine only. It therefore does NOT satisfy the
	// backup gate: the re-entry challenge below is the only pass path. (D-027:
	// the former "Save to 1Password" op-CLI button was removed — it blamed the
	// user for a per-process authorization limit a GUI app cannot satisfy.)
	let saving = $state<'keychain' | null>(null);
	let savedTo = $state<'keychain' | null>(null);
	let saveError = $state<string | null>(null);

	// Re-entry challenge: key HIDDEN, retype it to prove it is really saved.
	let verifyInput = $state('');
	const normalizedVerify = $derived(verifyInput.trim().replace(/\s+/g, '').toLowerCase());
	const verifyMatches = $derived(normalizedVerify.length === 64 && normalizedVerify === recoveryKey.toLowerCase());

	const grouped = $derived(recoveryKey ? recoveryKey.replace(/(.{4})/g, '$1 ').trim() : '');
	// A fixed-width mask so the box doesn't jump when revealed.
	const masked = $derived('•••• •••• •••• •••• •••• •••• •••• ••••');

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

	// Render a scannable QR of the recovery key + reveal the print/QR panel. The
	// QR is generated client-side (no network, no remote asset). The key stays in
	// memory only — the data URL is never logged or persisted.
	async function toggleQr() {
		if (showQr) { showQr = false; return; }
		qrError = null;
		try {
			if (!qrDataUrl) {
				const QRCode = (await import('qrcode')).default;
				qrDataUrl = await QRCode.toDataURL(recoveryKey, { errorCorrectionLevel: 'M', margin: 2, width: 240 });
			}
			showQr = true;
		} catch {
			qrError = 'Could not render a QR code — use Copy or Download instead.';
		}
	}

	// Print a paper copy. Uses the in-page @media print sheet + the browser's own
	// print dialog (no window.open, which a WKWebView swallows — D-010; no iframe,
	// which the CSP frame-src blocks). Printing sends the key ONLY to the user's
	// printer — the point of an offline backup.
	//
	// BY DESIGN: the @media print rule below is GLOBAL — it hides every other node
	// (`body *`) so ANY print issued while this step is mounted renders the key
	// sheet, not the app. That is deliberate (a Cmd-P here should produce the
	// backup sheet, never a screenshot of the wizard), and the step is short-lived
	// and modal. If this component is ever made non-modal or long-lived, scope the
	// rule instead — otherwise it would hijack an unrelated print. (Review note.)
	function printKey() {
		try { window.print(); } catch { /* the print panel is the browser's; nothing to surface */ }
	}

	// One-click save a COPY to this Mac's Keychain. The key is read SERVER-SIDE and
	// handed to Keychain Access — it never leaves the box via the browser. This is
	// an ON-DEVICE CONVENIENCE, NOT a backup (it is gone if the Mac is lost), so it
	// does NOT satisfy the backup gate: the re-entry challenge is the only pass path.
	async function saveKey(target: 'keychain') {
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

		<!-- Hidden by default; the user reveals it to read/transcribe. -->
		<div class="keybox" class:masked={!revealed}>{revealed ? grouped : masked}</div>

		<div class="btn-row">
			<button class="ghost" onclick={() => (revealed = !revealed)}>{revealed ? 'Hide' : 'Reveal'}</button>
			<button class="ghost" onclick={copyKey}>{copied ? 'Copied ✓' : 'Copy'}</button>
		</div>
		<div class="btn-row">
			<button class="ghost" onclick={downloadKey}>{downloaded ? 'Downloaded ✓' : 'Download .txt'}</button>
			<button class="ghost" onclick={toggleQr}>{showQr ? 'Hide QR' : 'Print / QR'}</button>
		</div>

		{#if showQr}
			<div class="qr-panel">
				{#if qrDataUrl}
					<img class="qr-img" src={qrDataUrl} alt="QR code of your recovery key — scan it into your password manager" />
				{/if}
				<p class="hint">Scan this into your phone's password manager, or print a paper copy and store it off this Mac.</p>
				<button class="ghost qr-print" onclick={printKey}>Print</button>
			</div>
		{/if}
		{#if qrError}<p class="hint bad">{qrError}</p>{/if}

		<div class="btn-row">
			<button class="ghost" onclick={() => saveKey('keychain')} disabled={saving !== null || !keychainAvailable}>
				{saving === 'keychain' ? 'Saving…' : savedTo === 'keychain' ? 'Copied to this Mac ✓' : 'Copy to this Mac’s Keychain'}
			</button>
		</div>
		<p class="hint">
			Copying to this Mac’s Keychain is a convenience — <strong>not a backup</strong>. It lives on
			this computer, so it’s gone if the Mac is lost. Keep a copy <strong>off this machine</strong>
			(download the file, print it, or copy it into a password manager that syncs). There is no reset.
		</p>
		{#if !keychainAvailable}
			<p class="hint">The Keychain isn't available here — re-enter your key below to confirm you've saved it.</p>
		{/if}
		{#if saveError}<p class="hint bad">{saveError}</p>{/if}
		{#if commitError}<p class="hint bad">{commitError}</p>{/if}

		<div class="actions">
			<!-- The ONLY pass path: an explicit "I've saved it" → re-enter the key
			     (proves it is really saved off-screen). No store-save auto-advances;
			     a same-machine Keychain copy is not an off-machine backup. -->
			<button class="primary" onclick={() => { verifyInput = ''; commitError = null; phase = 'verify'; }}>
				I've saved it — continue
			</button>
			<p class="sub-hint">Next: re-enter the key to confirm you can get back in.</p>
		</div>

		<!-- Print-only sheet: window.print() shows just this (the @media print rule
		     below hides the app chrome). The key + QR go only to the user's printer. -->
		<div class="rk-print-sheet" aria-hidden="true">
			<h2>Mycelium recovery key</h2>
			<p>Keep this secret and offline. It is the only way to recover your vault on a new
				computer. Anyone with it can read your vault. It cannot be reset.</p>
			{#if qrDataUrl}<img class="rk-print-qr" src={qrDataUrl} alt="" />{/if}
			<pre class="rk-print-key">{grouped}</pre>
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
	.keybox.masked { color: var(--color-text-tertiary); letter-spacing: 0.08em; user-select: none; -webkit-user-select: none; }
	.btn-row { display: flex; gap: 0.5rem; margin-top: 0.7rem; }
	.qr-panel {
		margin-top: 0.8rem; padding: 0.9rem; border-radius: 11px;
		border: 1px solid var(--glass-input-border, rgba(255, 255, 255, 0.14));
		display: flex; flex-direction: column; align-items: center; gap: 0.5rem;
	}
	.qr-img { width: 200px; height: 200px; border-radius: 8px; background: #fff; padding: 8px; }
	.qr-print { align-self: stretch; }
	/* The print sheet is invisible on screen; @media print isolates it. */
	.rk-print-sheet { display: none; }
	@media print {
		:global(body *) { visibility: hidden !important; }
		.rk-print-sheet, .rk-print-sheet * { visibility: visible !important; }
		.rk-print-sheet {
			display: block !important; position: fixed; inset: 0; margin: 0; padding: 2.5rem;
			background: #fff !important; color: #000 !important; text-align: center;
		}
		.rk-print-sheet h2 { font-size: 1.4rem; margin: 0 0 0.8rem; }
		.rk-print-sheet p { font-size: 0.95rem; line-height: 1.5; max-width: 30rem; margin: 0 auto 1.2rem; }
		.rk-print-qr { width: 260px; height: 260px; margin: 0 auto 1.2rem; display: block; }
		.rk-print-key {
			font-family: monospace; font-size: 1.15rem; letter-spacing: 0.06em;
			word-break: break-all; white-space: pre-wrap; margin: 0 auto; max-width: 30rem;
		}
	}
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
	.hint strong { color: var(--color-text-primary); font-weight: 600; }
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
