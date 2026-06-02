<script lang="ts">
	// First-run account ceremony — create the vault and show the ONE recovery key
	// the user must save, or restore an existing vault from that key. Talks to the
	// local /api/v1/account/* surface (served even in "setup mode", before the
	// vault is open). Mirrors the /login screen's visual language.
	import { onMount } from 'svelte';
	import { goto } from '$app/navigation';

	type Mode = 'loading' | 'intro' | 'reveal' | 'restore';
	let mode = $state<Mode>('loading');
	let busy = $state(false);
	let error = $state<string | null>(null);
	let keychainAvailable = $state(true);

	let recoveryKey = $state('');
	let savedConfirmed = $state(false);
	let copied = $state(false);
	let restoreInput = $state('');

	const grouped = $derived(recoveryKey ? recoveryKey.replace(/(.{4})/g, '$1 ').trim() : '');

	onMount(async () => {
		try {
			const res = await fetch('/api/v1/account/status', { credentials: 'same-origin' });
			if (res.ok) {
				const s = await res.json();
				keychainAvailable = s.keychainAvailable !== false;
				if (s.initialized) { goto('/mindscape'); return; }
			}
		} catch { /* show intro regardless */ }
		mode = 'intro';
	});

	async function createVault() {
		busy = true; error = null;
		try {
			const res = await fetch('/api/v1/account/setup', {
				method: 'POST', credentials: 'same-origin',
				headers: { 'Content-Type': 'application/json' }, body: '{}',
			});
			const data = await res.json().catch(() => ({}));
			if (!res.ok) throw new Error(data.message || data.error || 'Setup failed');
			recoveryKey = data.recoveryKey;
			savedConfirmed = false;
			mode = 'reveal';
		} catch (e) {
			error = e instanceof Error ? e.message : 'Setup failed';
		} finally { busy = false; }
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
			goto('/mindscape');
		} catch (e) {
			error = e instanceof Error ? e.message : 'Restore failed';
		} finally { busy = false; }
	}

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
	}
</script>

<svelte:head><title>Set up — Mycelium</title></svelte:head>

<div class="min-h-screen flex flex-col bg-[var(--color-bg)]">
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

			{:else if mode === 'intro'}
				<div class="card-elevated p-8 space-y-6">
					<div class="text-center">
						<h2 class="text-lg font-medium text-[var(--color-text-primary)] mb-2">Create your vault</h2>
						<p class="text-sm text-[var(--color-text-secondary)] leading-relaxed">
							Your data is encrypted on this Mac. Setup generates a single
							<strong>recovery key</strong> — the only way to restore your vault on
							another computer. You'll save it in the next step.
						</p>
					</div>
					{#if !keychainAvailable}
						<div class="p-3 bg-coral/10 border border-coral/30 rounded-lg text-xs text-[var(--color-text-secondary)]">
							The macOS Keychain isn't available here, so the app can't store your key automatically.
						</div>
					{/if}
					<button onclick={createVault} disabled={busy || !keychainAvailable}
						class="w-full btn btn-primary py-3.5 disabled:opacity-50 disabled:cursor-not-allowed">
						{busy ? 'Creating…' : 'Create my vault'}
					</button>
					<button onclick={() => { error = null; mode = 'restore'; }}
						class="w-full text-sm text-[var(--color-text-tertiary)] hover:text-[var(--color-text-secondary)] transition-colors py-2">
						I already have a recovery key → Restore
					</button>
				</div>

			{:else if mode === 'reveal'}
				<div class="card-elevated p-8 space-y-6">
					<div class="text-center">
						<h2 class="text-lg font-medium text-[var(--color-text-primary)] mb-2">Save your recovery key</h2>
						<p class="text-sm text-[var(--color-text-secondary)] leading-relaxed">
							This is the <strong>only</strong> way to recover your vault on a new
							computer. Store it in a password manager now — it cannot be reset.
						</p>
					</div>
					<div class="p-4 rounded-lg bg-[var(--color-bg-secondary,#0001)] border border-[var(--color-border)] font-mono text-sm tracking-wide break-all text-center text-[var(--color-text-primary)] select-all">
						{grouped}
					</div>
					<div class="flex gap-3">
						<button onclick={copyKey} class="flex-1 btn py-2.5 border border-[var(--color-border)]">{copied ? 'Copied ✓' : 'Copy'}</button>
						<button onclick={downloadKey} class="flex-1 btn py-2.5 border border-[var(--color-border)]">Download</button>
					</div>
					<label class="flex items-start gap-3 text-sm text-[var(--color-text-secondary)] cursor-pointer">
						<input type="checkbox" bind:checked={savedConfirmed} class="mt-0.5" />
						<span>I've saved my recovery key somewhere safe.</span>
					</label>
					<button onclick={() => savedConfirmed && goto('/mindscape')} disabled={!savedConfirmed}
						class="w-full btn btn-primary py-3.5 disabled:opacity-50 disabled:cursor-not-allowed">
						Enter my vault
					</button>
				</div>

			{:else if mode === 'restore'}
				<div class="card-elevated p-8 space-y-6">
					<div class="text-center">
						<h2 class="text-lg font-medium text-[var(--color-text-primary)] mb-2">Restore your vault</h2>
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
					<button onclick={() => { error = null; mode = 'intro'; }}
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
