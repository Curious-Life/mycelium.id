<script lang="ts">
	// First-run entry (U1.3) — the WELCOME / HERO. "Get started" SILENTLY creates the
	// vault (POST /api/v1/account/setup mints the key + opens the vault) and navigates
	// into the app, where the wizard's Step 2 relocates the recovery-key backup. This
	// screen no longer reveals the key — the reveal + its strict gate moved into the
	// in-app wizard (RecoveryKeyStep.svelte), fetching the key FRESH there. This route
	// still owns the RETURNING/migrating paths (restore, restore-from-backup, unlock).
	// Talks to the local /api/v1/account/* surface (served even in "setup mode", before
	// the vault is open). Mirrors the /login screen's visual language.
	import { onMount } from 'svelte';
	import MyceliumCanvas from '$lib/components/onboarding/MyceliumCanvas.svelte';

	// 'hero' = fresh machine, no vault yet (create or restore). The old 'reveal' mode
	// is GONE — the recovery-key backup now happens in the in-app wizard.
	type Mode = 'loading' | 'hero' | 'restore-backup' | 'restore' | 'damaged';
	let mode = $state<Mode>('loading');
	let busy = $state(false);
	let error = $state<string | null>(null);
	// Why the vault couldn't open (from /account/status): null | 'key_mismatch' |
	// 'at_rest_migration_failed' | 'boot_failed'. Lets the restore screen explain
	// itself instead of looking like a blank "paste a key" prompt.
	let bootError = $state<string | null>(null);
	let keychainAvailable = $state(true);

	let restoreInput = $state('');
	// "this Mac" / "this computer" — device-aware reassurance copy.
	let deviceLabel = $state('this device');

	// Restore-from-backup (upload .myvault). Backing UP a vault lives in Settings →
	// Security, not in first-run onboarding (premature there — no data yet).
	let backupFile = $state<File | null>(null);
	let uploadingBackup = $state(false);

	// After setup/restore the vault is open but the root layout's session check
	// ran before that (it redirected us here), so a client-side nav would land on
	// a stuck "Loading…". A full navigation re-runs the layout (now initialized →
	// session established) and lands cleanly in the workspace.
	function enterVault() { window.location.assign('/mindscape'); }

	onMount(async () => {
		try { deviceLabel = /Mac/i.test(navigator.userAgent) ? 'this Mac' : 'this computer'; } catch { /* keep default */ }
		try {
			// D-130: never treat an in-flight boot as "no vault" — wait it out
			// (the awaited off-loop vault copy on a restore can take minutes).
			let s = null;
			for (;;) {
				const res = await fetch('/api/v1/account/status', { credentials: 'same-origin' });
				if (!res.ok) break;
				s = await res.json();
				if (!s.booting) break;
				await new Promise((r) => setTimeout(r, 2000));
			}
			if (s) {
				keychainAvailable = s.keychainAvailable !== false;
				bootError = s.bootError || null;
				if (s.initialized) { enterVault(); return; }
				if (s.locked) { window.location.assign('/unlock'); return; }
				// Vault files are present but the Keychain can't open them (a hand-copied
				// data dir, a key mismatch, or right after a restore-from-backup): go
				// to the recovery-key paste, which succeeds because kcv.json is on disk.
				// A DAMAGED vault is not a key problem. Routing it to the recovery-key paste
				// is the reported 2026-07-26 symptom: the owner enters the correct key,
				// nothing happens, and the screen implies the key is at fault. No key can
				// satisfy a malformed b-tree. @see the vault fail-stop design
				if (bootError === 'vault_corrupt') { mode = 'damaged'; return; }
				if (s.needsRecoveryKey || bootError) { mode = 'restore'; return; }
			}
		} catch { /* show the hero regardless */ }
		mode = 'hero';
	});

	// "Get started" — SILENTLY create the vault, then enter the app. The recovery key
	// minted here (data.recoveryKey) is DELIBERATELY IGNORED: it is already persisted
	// to the Keychain by the /setup route BEFORE boot, and the wizard's Step 2 fetches
	// it FRESH (GET /api/v1/account/recovery-key) at the backup gate. We never read it
	// into state, never render it, never log it — the reveal belongs to the wizard now.
	async function createVault() {
		busy = true; error = null;
		try {
			const res = await fetch('/api/v1/account/setup', {
				method: 'POST', credentials: 'same-origin',
				headers: { 'Content-Type': 'application/json' }, body: '{}',
			});
			if (!res.ok) {
				const data = await res.json().catch(() => ({}));
				throw new Error(data.message || data.error || 'Setup failed');
			}
			// Vault is open; the wizard's Step 2 will force the recovery-key backup.
			enterVault();
		} catch (e) {
			error = e instanceof Error ? e.message : 'Setup failed';
			busy = false;
		}
	}

	async function restoreVault() {
		const key = restoreInput.trim().replace(/\s+/g, '');
		if (key.length !== 64) { error = 'Enter your 64-character recovery key'; return; }
		busy = true; error = null;
		try {
			const res = await fetch('/api/v1/account/restore', {
				method: 'POST', credentials: 'same-origin',
				headers: { 'Content-Type': 'application/json' },
				body: JSON.stringify({ recoveryKey: key }),
			});
			const data = await res.json().catch(() => ({}));
			if (!res.ok) throw new Error(data.message || data.error || 'Restore failed');
			enterVault();
		} catch (e) {
			error = e instanceof Error ? e.message : 'Restore failed';
		} finally { busy = false; }
	}


	function onPickBackup(e: Event) {
		const input = e.target as HTMLInputElement;
		backupFile = input.files && input.files[0] ? input.files[0] : null;
		error = null;
	}

	// Upload a .myvault archive → lands db + kcv on disk, then the recovery-key
	// paste (restore mode) opens the REAL data.
	async function uploadBackup(overwrite = false) {
		if (!backupFile) { error = 'Choose a .myvault backup file.'; return; }
		uploadingBackup = true; error = null;
		try {
			const fd = new FormData();
			fd.append('file', backupFile);
			if (overwrite) fd.append('overwrite', 'true');
			const res = await fetch('/api/v1/account/restore-backup', {
				method: 'POST', credentials: 'same-origin', body: fd,
			});
			const data = await res.json().catch(() => ({}));
			if (!res.ok) throw new Error(data.message || data.error || 'Could not read that backup');
			mode = 'restore'; // files are on disk — now paste the recovery key
		} catch (e) {
			error = e instanceof Error ? e.message : 'Could not read that backup';
		} finally { uploadingBackup = false; }
	}

</script>

<svelte:head><title>Set up — Mycelium</title></svelte:head>

<div class="min-h-screen flex flex-col bg-[var(--color-bg)]">
	<!-- The living hyphal-network hero (decorative, self-contained — no external
	     fetch). Behind the card; pointer-events:none so it never intercepts clicks. -->
	<div class="absolute inset-0 pointer-events-none opacity-70"><MyceliumCanvas /></div>
	<div class="absolute inset-0 bg-gradient-to-br from-azure/5 via-transparent to-amethyst/5 pointer-events-none"></div>
	<main class="flex-1 flex items-center justify-center p-6 relative overflow-y-auto">
		<div class="w-full max-w-md">
			<div class="text-center mb-6">
				<h1 class="text-3xl font-light text-[var(--color-text-primary)] mb-2 lowercase tracking-wide">mycelium</h1>
				<p class="text-aurum text-3xl font-semibold uppercase" style="letter-spacing: 0.45em; padding-left: 0.45em;">Vault</p>
			</div>

			{#if error}
				<div class="mb-6 p-4 bg-coral/10 border border-coral/30 rounded-lg text-[var(--color-text-primary)] text-sm">{error}</div>
			{/if}

			{#if mode === 'loading'}
				<div class="h-48 flex items-center justify-center text-[var(--color-text-tertiary)] animate-pulse">Loading…</div>

			{:else if mode === 'hero'}
				<!-- Welcome / hero — the true entry (U1.3). "Get started" SILENTLY creates
				     the vault and enters the app; the recovery-key backup is the wizard's
				     Step 2 (relocated). The reveal no longer lives on this pre-app route. -->
				<div class="card-elevated p-8 space-y-6 text-center">
					<div>
						<h2 class="text-xl font-medium text-[var(--color-text-primary)] mb-2">See your mind take shape</h2>
						<p class="text-sm text-[var(--color-text-secondary)] leading-relaxed">
							Private, encrypted on {deviceLabel} — only you can read it.
						</p>
					</div>
					{#if !keychainAvailable}
						<div class="p-3 bg-coral/10 border border-coral/30 rounded-lg text-xs text-[var(--color-text-secondary)] text-left">
							The macOS Keychain isn't available here, so the app can't store your key automatically.
						</div>
					{/if}
					<button onclick={createVault} disabled={busy || !keychainAvailable}
						class="w-full btn btn-primary py-3.5 disabled:opacity-50 disabled:cursor-not-allowed">
						{busy ? 'Creating your vault…' : 'Get started'}
					</button>
					<button onclick={() => { error = null; backupFile = null; mode = 'restore-backup'; }}
						class="w-full text-sm text-[var(--color-text-tertiary)] hover:text-[var(--color-text-secondary)] transition-colors py-2">
						Restore from a backup
					</button>
					<button onclick={() => { error = null; mode = 'restore'; }}
						class="w-full text-xs text-[var(--color-text-tertiary)] hover:text-[var(--color-text-secondary)] transition-colors">
						I've already copied my vault files here → enter recovery key
					</button>
				</div>

			{:else if mode === 'restore-backup'}
				<div class="card-elevated p-8 space-y-6">
					<div class="text-center">
						<h2 class="text-lg font-medium text-[var(--color-text-primary)] mb-2">Restore from a backup</h2>
						<p class="text-sm text-[var(--color-text-secondary)] leading-relaxed">
							Choose the <code>.myvault</code> backup file you saved. Next you'll paste your
							recovery key to unlock it.
						</p>
					</div>
					<input type="file" accept=".myvault,application/octet-stream" onchange={onPickBackup}
						class="block w-full text-sm text-[var(--color-text-secondary)] file:mr-3 file:py-2 file:px-4 file:rounded-lg file:border file:border-[var(--color-border)] file:bg-transparent file:text-[var(--color-text-primary)]" />
					<p class="text-xs text-[var(--color-text-tertiary)] leading-relaxed">
						Coming from the hosted Mycelium? That export (a <code>.zip</code>) is imported
						<em>after</em> setup — create a new vault first, then drop the export into
						Import inside the app.
					</p>
					<button onclick={() => uploadBackup(false)} disabled={uploadingBackup || !backupFile}
						class="w-full btn btn-primary py-3.5 disabled:opacity-50 disabled:cursor-not-allowed">
						{uploadingBackup ? 'Reading backup…' : 'Continue'}
					</button>
					<button onclick={() => { error = null; mode = 'hero'; }}
						class="w-full text-sm text-[var(--color-text-tertiary)] hover:text-[var(--color-text-secondary)] transition-colors py-2">
						← Back
					</button>
				</div>

			{:else if mode === 'damaged'}
				<div class="card-elevated p-8 space-y-6">
					<div class="text-center">
						<div class="rounded-lg border border-[#E5B84C]/40 bg-[#E5B84C]/10 p-3 mb-4 text-sm text-left text-[var(--color-text-secondary)] leading-relaxed">
							<strong class="text-[var(--color-text-primary)]">Your vault file is damaged.</strong>
							This is <strong class="text-[var(--color-text-primary)]">not</strong> a key problem — your recovery key is fine, and re-entering it will not help.
							Mycelium has stopped writing to the file so the damage cannot spread.
						</div>
						<h2 class="text-lg font-medium text-[var(--color-text-primary)] mb-2">Your data has not been deleted</h2>
						<p class="text-sm text-[var(--color-text-secondary)] leading-relaxed">
							The vault is still on disk exactly as it was — nothing has been overwritten, moved or repaired.
							Recovery needs the vault-repair tools rather than this screen.
						</p>
					</div>
					<div class="rounded-lg border border-[var(--color-border)] p-4 text-left space-y-2">
						<p class="text-sm text-[var(--color-text-primary)] font-medium">What to do next</p>
						<ol class="text-sm text-[var(--color-text-secondary)] leading-relaxed list-decimal ml-4 space-y-1">
							<li>Do <strong>not</strong> delete the data folder or start a new vault — that discards the recoverable file.</li>
							<li>Restore the most recent snapshot if you have one.</li>
							<li>Otherwise run the vault-repair tools (<code class="font-mono text-xs">scripts/vault-repair/</code>) against a copy.</li>
						</ol>
					</div>
					<button onclick={() => { error = null; mode = 'restore'; }}
						class="w-full text-xs text-[var(--color-text-tertiary)] hover:text-[var(--color-text-secondary)] transition-colors">
						I've already copied my vault files here → enter recovery key
					</button>
				</div>

			{:else if mode === 'restore'}
				<div class="card-elevated p-8 space-y-6">
					<div class="text-center">
						{#if bootError}<div class="rounded-lg border border-[#E5B84C]/40 bg-[#E5B84C]/10 p-3 mb-4 text-sm text-left text-[var(--color-text-secondary)] leading-relaxed">{#if bootError === "key_mismatch"}<strong class="text-[var(--color-text-primary)]">Your vault is here, but the saved key couldn’t open it.</strong> Usually it was re-keyed or copied from another setup. Paste your recovery key below — your data is safe.{:else if bootError === "at_rest_migration_failed"}<strong class="text-[var(--color-text-primary)]">Your vault didn’t finish encrypting at rest.</strong> Paste your recovery key to reopen it. A plaintext backup was kept, so nothing is lost.{:else}<strong class="text-[var(--color-text-primary)]">Your vault exists but couldn’t open on startup.</strong> Paste your recovery key to unlock it.{/if}</div>{/if}<h2 class="text-lg font-medium text-[var(--color-text-primary)] mb-2">{bootError ? "Unlock your vault" : "Restore your vault"}</h2>
						<p class="text-sm text-[var(--color-text-secondary)] leading-relaxed">
							Paste the 64-character recovery key you saved when you first set up Mycelium.
						</p>
					</div>
					<input bind:value={restoreInput} type="password" placeholder="Paste your recovery key"
						autocomplete="off" spellcheck="false" data-1p-ignore data-lpignore="true"
						class="input w-full text-sm font-mono tracking-wide" />
					<button onclick={restoreVault} disabled={busy || restoreInput.trim().replace(/\s+/g, '').length < 64}
						class="w-full btn btn-primary py-3.5 disabled:opacity-50 disabled:cursor-not-allowed">
						{busy ? 'Restoring…' : 'Restore vault'}
					</button>
					<button onclick={() => { error = null; mode = 'hero'; }}
						class="w-full text-sm text-[var(--color-text-tertiary)] hover:text-[var(--color-text-secondary)] transition-colors py-2">
						← Back
					</button>
				</div>
			{/if}

			<div class="mt-8 text-center">
				<p class="text-xs text-[var(--color-text-tertiary)]"><span class="opacity-40">Encrypted on this device</span> · mycelium.id</p>
			</div>
		</div>
	</main>
</div>
