<script lang="ts">
	// Settings → Data · Delete your data (delete-by-source / "undo an import").
	// Destructive → TYPE-TO-CONFIRM: the user must type the exact source key, which
	// is echoed to the server as `confirm` (the server refuses a mismatch). The
	// delete runs as an async background job (src/portal-data.js) with live
	// progress + cancel, mirroring the import sweep. On completion the parent views
	// (library/timeline/mindscape) are told to refresh via a window event.
	import { onDestroy, onMount } from 'svelte';
	import { browser } from '$app/environment';
	import { dataSummary, startDelete, pollDelete, cancelDelete, type DataSummary, type DeleteProgress } from '$lib/data/delete';

	// ── Destroy the entire vault (factory reset) — Tauri desktop only ────────────
	// Strongest confirmation in the app: type the phrase AND paste the recovery key
	// (verified server-side vs the live master), so a session alone can never nuke
	// the vault. The node route wipes everything; then we invoke the Tauri command
	// which restarts the app to onboarding. Hidden in the browser (no relaunch).
	const DESTROY_PHRASE = 'destroy my vault';
	let isTauri = $state(false);
	let showDestroy = $state(false);        // two-step: reveal the confirm panel
	let destroyKey = $state('');
	let destroyPhrase = $state('');
	let destroyBusy = $state(false);
	let destroyErr = $state<string | null>(null);
	let destroyDone = $state(false);
	// Honest post-destroy reporting: steps that did NOT succeed are shown, never
	// swallowed. `handleBlocked` is the pre-flight 409 — the vault is still fully
	// intact at that point, so the user can retry or knowingly proceed.
	let handleBlocked = $state<{ reason?: string } | null>(null);
	let destroyWarnings = $state<string[]>([]);
	const destroyArmed = $derived(destroyPhrase === DESTROY_PHRASE && destroyKey.trim().length >= 8 && !destroyBusy);
	onMount(() => {
		if (browser) isTauri = !!((window as any).__TAURI_INTERNALS__ || (window as any).__TAURI__);
	});
	function relaunch() {
		const invoke = (window as any).__TAURI_INTERNALS__?.invoke;
		if (typeof invoke === 'function') { try { invoke('destroy_and_relaunch'); } catch { /* app is restarting */ } }
	}
	async function destroyVault(force = false) {
		if (!destroyArmed && !force) return;
		const key = destroyKey.trim();
		destroyBusy = true; destroyErr = null;
		try {
			const res = await fetch('/api/v1/account/destroy', {
				method: 'POST', headers: { 'content-type': 'application/json' }, credentials: 'same-origin',
				body: JSON.stringify({ recoveryKey: key, phrase: DESTROY_PHRASE, ...(force ? { force: true } : {}) }),
			});
			const d = await res.json().catch(() => ({}));
			// 409 = handle release failed and NOTHING was deleted. Keep the typed
			// inputs so the user can simply retry once they are back online.
			if (res.status === 409 && d?.canForce) {
				handleBlocked = d.handleRelease || {};
				destroyErr = d.error || 'Could not release your handle — nothing was deleted.';
				return;
			}
			if (!res.ok || !d.ok) throw new Error(d.error || 'Destroy failed — nothing was deleted.');
			handleBlocked = null;
			// Collect the steps that did NOT fully succeed, so "destroyed" never
			// over-claims. Everything clean → relaunch straight away as before.
			const warn: string[] = [];
			if (d.handleRelease?.applicable && !d.handleRelease?.released) {
				warn.push('Your public handle could NOT be released — it stays registered and can no longer be freed (the key that signs the release is gone).');
			}
			const failedConnectors = Array.isArray(d.connectors?.failed) ? d.connectors.failed : [];
			// A locked/unopened vault can't read its own connector tokens, so nothing
			// was revoked upstream — say that plainly rather than naming a fake id.
			if (failedConnectors.some((f: any) => f.reason === 'vault-not-open')) {
				warn.push('Your vault was not open, so no connected accounts could be revoked. Any accounts you linked (Google, Notion, …) may still have access — remove Mycelium from their security settings.');
			}
			const named = failedConnectors.filter((f: any) => f.id && f.id !== '*');
			if (named.length) {
				warn.push(`These connected accounts could NOT be revoked and still have access — remove Mycelium from their security settings: ${named.map((f: any) => f.id).join(', ')}.`);
			}
			if (d.failed > 0) warn.push(`${d.failed} item(s) could not be deleted.`);
			destroyWarnings = warn;
			destroyDone = true;
			// Vault + keys are gone. Relaunch to onboarding via the Tauri command —
			// but only automatically when there is nothing the user needs to read.
			if (!warn.length) relaunch();
		} catch (e: any) {
			destroyErr = e?.message || 'Destroy failed.';
		} finally {
			destroyBusy = false;
			if (!handleBlocked) { destroyKey = ''; destroyPhrase = ''; }
		}
	}

	let summary = $state<DataSummary | null>(null);
	let loadError = $state<string | null>(null);
	let confirmKey = $state<string | null>(null);   // which row is in confirm mode
	let confirmText = $state('');
	let job = $state<DeleteProgress | null>(null);   // live progress of the running delete
	let runningKey = $state<string | null>(null);
	let resultMsg = $state<Record<string, string>>({});
	let pollTimer: ReturnType<typeof setTimeout> | null = null;

	async function load() {
		try { summary = await dataSummary(); loadError = null; }
		catch (e: any) { loadError = e?.message || 'Could not load your data summary.'; }
	}
	load();

	const deletableSources = $derived((summary?.sources ?? []).filter((s) => s.deletable && (s.messages + s.documents) > 0));

	// Delete-by-type cards (Phase 2). These reach NATIVE data by design ("delete
	// all my chat history / documents / media"), so the copy is loud + the same
	// type-to-confirm guard applies. Only shown when the count is non-zero.
	const TYPE_META: Record<string, { label: string; note: string }> = {
		documents: { label: 'All documents', note: 'Every document in your library — including ones you wrote.' },
		media: { label: 'All media & attachments', note: 'Every imported/received image, audio, video and file.' },
		chat: { label: 'All chat history', note: 'Every chat message — your own conversations with the agent too.' },
	};
	const typeCards = $derived(
		(['documents', 'media', 'chat'] as const)
			.map((k) => ({ key: k, count: (summary?.types as any)?.[k] ?? 0, ...TYPE_META[k] }))
			.filter((c) => c.count > 0),
	);

	function openConfirm(key: string) { confirmKey = key; confirmText = ''; }
	function closeConfirm() { confirmKey = null; confirmText = ''; }

	function pct(): number {
		if (!job || !job.total) return 0;
		return Math.min(100, Math.round((job.processed / job.total) * 100));
	}

	// One delete driver for both modes. `key` is the source family (mode='source')
	// or the data type (mode='type'); it is also the exact type-to-confirm token.
	async function runDelete(mode: 'source' | 'type', key: string) {
		if (confirmText !== key) return; // guard: exact type-to-confirm
		runningKey = key;
		confirmKey = null;
		resultMsg = { ...resultMsg, [key]: '' };
		try {
			job = await startDelete(mode, key, confirmText);
			await new Promise<void>((resolve) => {
				const tick = async () => {
					try { job = await pollDelete(); } catch { /* keep last snapshot */ }
					if (job && job.status === 'running') pollTimer = setTimeout(tick, 800);
					else resolve();
				};
				pollTimer = setTimeout(tick, 500);
			});
			const d = job;
			if (d?.status === 'error') {
				resultMsg = { ...resultMsg, [key]: d.error || 'Delete failed.' };
			} else {
				const stopped = d?.status === 'cancelled';
				const n = d?.deleted ?? 0;
				const extra = d?.blobs ? ` · ${d.blobs} file${d.blobs === 1 ? '' : 's'} removed` : '';
				resultMsg = { ...resultMsg, [key]: `${stopped ? 'Stopped —' : 'Deleted'} ${n.toLocaleString()} item${n === 1 ? '' : 's'}${extra}.` };
				// Tell the rest of the app to refresh (library/timeline/mindscape).
				try { window.dispatchEvent(new CustomEvent('mycelium:data-changed', { detail: { mode, key, mindscapeStale: d?.mindscapeStale } })); } catch { /* */ }
			}
		} catch (e: any) {
			resultMsg = { ...resultMsg, [key]: e?.message || 'Delete failed.' };
		} finally {
			runningKey = null;
			confirmText = '';
			await load(); // refresh the counts
		}
	}

	async function stop() { try { await cancelDelete(); } catch { /* */ } }

	onDestroy(() => { if (pollTimer) clearTimeout(pollTimer); });
</script>

{#snippet deleteCard(mode: 'source' | 'type', key: string, title: string, subtitle: string, note: string)}
	<div class="rounded-lg border border-[var(--color-border)] p-3">
		<div class="flex items-center justify-between gap-3">
			<div>
				<p class="text-sm text-[var(--color-text-primary)]">{title}</p>
				<p class="text-xs text-[var(--color-text-tertiary)] mt-0.5">{subtitle}</p>
			</div>
			{#if runningKey === key}
				<button onclick={stop} class="px-3 py-1.5 rounded-lg text-sm text-[var(--color-text-tertiary)] hover:text-[var(--color-text-primary)]">Cancel</button>
			{:else if confirmKey === key}
				<button onclick={closeConfirm} class="px-3 py-1.5 rounded-lg text-sm text-[var(--color-text-tertiary)] hover:text-[var(--color-text-primary)]">Cancel</button>
			{:else}
				<button onclick={() => openConfirm(key)} disabled={!!runningKey}
					class="px-3 py-1.5 rounded-lg bg-coral/10 border border-coral/30 text-sm text-coral hover:bg-coral/20 transition-colors disabled:opacity-50 whitespace-nowrap">Delete…</button>
			{/if}
		</div>

		{#if confirmKey === key}
			<div class="mt-3 space-y-2">
				{#if note}<p class="text-xs text-coral">{note}</p>{/if}
				<p class="text-xs text-[var(--color-text-tertiary)]">Type <code class="text-coral">{key}</code> to confirm permanent deletion:</p>
				<div class="flex gap-2">
					<input bind:value={confirmText} placeholder={key} autocomplete="off" spellcheck="false"
						onkeydown={(e) => { if (e.key === 'Enter' && confirmText === key) runDelete(mode, key); }}
						class="input flex-1 text-sm" />
					<button onclick={() => runDelete(mode, key)} disabled={confirmText !== key}
						class="px-3 py-2 rounded-lg bg-coral/15 border border-coral/40 text-sm text-coral font-medium disabled:opacity-40 whitespace-nowrap">Delete permanently</button>
				</div>
			</div>
		{/if}

		{#if runningKey === key && job}
			<div class="mt-3">
				<div class="h-1.5 rounded-full bg-[var(--color-elevated)] overflow-hidden">
					<div class="h-full bg-coral transition-all" style="width: {pct()}%"></div>
				</div>
				<p class="text-xs text-[var(--color-text-tertiary)] mt-1">Deleting… {job.processed.toLocaleString()} of {job.total.toLocaleString()} ({pct()}%)</p>
			</div>
		{/if}

		{#if resultMsg[key]}
			<p class="text-xs mt-2 {resultMsg[key].startsWith('Delete failed') ? 'text-coral' : 'text-jade'}">{resultMsg[key]}</p>
			{#if job?.mindscapeStale && runningKey !== key}
				<p class="text-xs text-[var(--color-text-tertiary)] mt-1">Your mindscape may be out of date — regenerate it from the Mindscape view when convenient.</p>
			{/if}
		{/if}
	</div>
{/snippet}

<section class="card p-5">
	<h2 class="text-xs font-medium text-[var(--color-text-tertiary)] uppercase tracking-wider mb-1">Delete an import</h2>
	<p class="text-xs text-[var(--color-text-tertiary)] mb-4">
		Undo an import — permanently remove everything that came from one source: its messages, documents,
		imported files, and search index. <strong>This cannot be undone.</strong> Your own chat and reflections are never touched here.
	</p>

	{#if loadError}
		<p class="text-xs text-coral">{loadError}</p>
	{:else if !summary}
		<p class="text-xs text-[var(--color-text-tertiary)]">Loading…</p>
	{:else if deletableSources.length === 0}
		<p class="text-xs text-[var(--color-text-tertiary)]">No imported sources to delete. Imports you run will show up here.</p>
	{:else}
		<div class="space-y-2">
			{#each deletableSources as row (row.source)}
				{@render deleteCard('source', row.source, row.label,
					`${row.messages ? `${row.messages.toLocaleString()} message${row.messages === 1 ? '' : 's'}` : ''}${row.messages && row.documents ? ' · ' : ''}${row.documents ? `${row.documents.toLocaleString()} document${row.documents === 1 ? '' : 's'}` : ''}`,
					'')}
			{/each}
		</div>
	{/if}
</section>

{#if summary && typeCards.length > 0}
	<section class="card p-5">
		<h2 class="text-xs font-medium text-[var(--color-text-tertiary)] uppercase tracking-wider mb-1">Delete by type</h2>
		<p class="text-xs text-[var(--color-text-tertiary)] mb-4">
			Bulk-delete a whole category at once. Unlike deleting an import, this <strong>also removes data you created</strong> —
			your own chat, your own documents. Permanent, and it cannot be undone.
		</p>
		<div class="space-y-2">
			{#each typeCards as c (c.key)}
				{@render deleteCard('type', c.key, c.label, `${c.count.toLocaleString()} item${c.count === 1 ? '' : 's'}`, c.note)}
			{/each}
		</div>
	</section>
{/if}

{#if isTauri}
	<section class="card p-5 border border-coral/30">
		<h2 class="text-xs font-medium text-coral uppercase tracking-wider mb-1">Destroy this vault</h2>
		<p class="text-xs text-[var(--color-text-tertiary)] mb-4">
			Permanently erase <strong>everything</strong> — every message, document, file, your keys, all app data,
			and the local AI models this app downloaded — and reset to a fresh install. This is
			<strong>irreversible and unrecoverable</strong>. A saved backup will no longer be decryptable.
		</p>

		{#if destroyDone}
			{#if destroyWarnings.length}
				<div class="space-y-3">
					<p class="text-sm text-[var(--color-text-primary)]">Your local vault is destroyed — but not everything succeeded:</p>
					<ul class="text-xs text-coral list-disc pl-4 space-y-1">
						{#each destroyWarnings as w}<li>{w}</li>{/each}
					</ul>
					<button onclick={relaunch}
						class="px-3 py-2 rounded-lg bg-coral/10 border border-coral/40 text-sm text-coral hover:bg-coral/20 transition-colors">I've read this — restart</button>
				</div>
			{:else}
				<p class="text-sm text-[var(--color-text-primary)]">Vault destroyed. Restarting…</p>
			{/if}
		{:else if handleBlocked}
			<div class="space-y-3">
				<p class="text-sm text-[var(--color-text-primary)]"><strong>Nothing was deleted.</strong> Your public handle could not be released, so your vault is untouched.</p>
				<p class="text-xs text-[var(--color-text-tertiary)]">
					Reconnect to the internet and try again. If you destroy anyway, the handle stays registered to you forever —
					the key that signs the release is destroyed along with the vault.
					{#if handleBlocked.reason}<span class="block mt-1 opacity-70">Reason: {handleBlocked.reason}</span>{/if}
				</p>
				<div class="flex gap-2">
					<button onclick={() => destroyVault()} disabled={destroyBusy}
						class="px-3 py-2 rounded-lg bg-coral/10 border border-coral/40 text-sm text-coral disabled:opacity-40">{destroyBusy ? 'Retrying…' : 'Try again'}</button>
					<button onclick={() => destroyVault(true)} disabled={destroyBusy}
						class="px-3 py-2 rounded-lg bg-coral/20 border border-coral/50 text-sm text-coral font-medium disabled:opacity-40">Destroy anyway</button>
					<button onclick={() => { handleBlocked = null; showDestroy = false; destroyKey = ''; destroyPhrase = ''; destroyErr = null; }} disabled={destroyBusy}
						class="px-3 py-2 rounded-lg text-sm text-[var(--color-text-tertiary)] hover:text-[var(--color-text-primary)]">Cancel</button>
				</div>
			</div>
		{:else if !showDestroy}
			<button onclick={() => { showDestroy = true; destroyErr = null; }}
				class="px-3 py-2 rounded-lg bg-coral/10 border border-coral/40 text-sm text-coral hover:bg-coral/20 transition-colors">Destroy the entire vault…</button>
		{:else}
			<div class="space-y-3">
				<p class="text-xs text-coral">This deletes your keys too — there is no undo and no recovery afterward. To confirm, paste your recovery key and type the phrase.</p>
				<input bind:value={destroyKey} type="password" autocomplete="off" spellcheck="false" placeholder="Recovery key"
					class="input w-full text-sm" />
				<input bind:value={destroyPhrase} autocomplete="off" spellcheck="false" placeholder={`Type “${DESTROY_PHRASE}”`}
					onkeydown={(e) => { if (e.key === 'Enter' && destroyArmed) destroyVault(); }}
					class="input w-full text-sm" />
				<div class="flex gap-2">
					<button onclick={() => destroyVault()} disabled={!destroyArmed}
						class="px-3 py-2 rounded-lg bg-coral/20 border border-coral/50 text-sm text-coral font-medium disabled:opacity-40">
						{destroyBusy ? 'Destroying…' : 'Permanently destroy'}</button>
					<button onclick={() => { showDestroy = false; destroyKey = ''; destroyPhrase = ''; destroyErr = null; }} disabled={destroyBusy}
						class="px-3 py-2 rounded-lg text-sm text-[var(--color-text-tertiary)] hover:text-[var(--color-text-primary)]">Cancel</button>
				</div>
				{#if destroyErr}<p class="text-xs text-coral">{destroyErr}</p>{/if}
			</div>
		{/if}
	</section>
{/if}
