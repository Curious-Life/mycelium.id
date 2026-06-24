<script lang="ts">
	import { browser } from '$app/environment';
	import { api, apiGet, apiPost } from '$lib/api';

	interface Area {
		id: string;
		name: string;
		is_default: number;
		doc_count: number;
		summary: string | null;
		summary_updated_at: string | null;
	}
	interface Doc { path: string; title: string | null; summary: string | null; updated_at?: string | null }

	let areas = $state<Area[]>([]);
	let loading = $state(true);
	let error = $state<string | null>(null);
	let newName = $state('');
	let creating = $state(false);

	let openId = $state<string | null>(null);
	let docs = $state<Doc[]>([]);        // documents attached to the open area
	let allDocs = $state<Doc[]>([]);     // vault documents, for the picker
	let picker = $state(false);
	let summarizing = $state(false);

	async function load() {
		try { areas = (await apiGet<{ contexts: Area[] }>('/portal/contexts')).contexts; }
		catch { error = 'Could not load areas'; } finally { loading = false; }
	}
	$effect(() => { if (browser) load(); });

	async function create() {
		const name = newName.trim();
		if (!name) return;
		creating = true; error = null;
		try { await apiPost('/portal/contexts', { name }); newName = ''; await load(); }
		catch (e: any) { error = e.message || 'Could not create area'; } finally { creating = false; }
	}
	async function rename(a: Area) {
		const name = prompt('Rename area', a.name)?.trim();
		if (!name || name === a.name) return;
		try { await api(`/portal/contexts/${a.id}`, { method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ name }) }); await load(); }
		catch (e: any) { error = e.message; }
	}
	async function remove(a: Area) {
		if (!confirm(`Delete the "${a.name}" area? (your documents are not deleted)`)) return;
		try { await api(`/portal/contexts/${a.id}`, { method: 'DELETE' }); if (openId === a.id) openId = null; await load(); }
		catch (e: any) { error = e.message; }
	}

	async function toggle(a: Area) {
		if (openId === a.id) { openId = null; return; }
		openId = a.id; picker = false;
		await loadDocs(a.id);
	}
	async function loadDocs(id: string) {
		try { docs = (await apiGet<{ documents: Doc[] }>(`/portal/contexts/${id}/documents`)).documents; } catch { docs = []; }
	}
	async function openPicker() {
		picker = true;
		try { allDocs = (await apiGet<{ documents: Doc[] }>('/portal/documents')).documents; } catch { allDocs = []; }
	}
	async function attach(path: string) {
		if (!openId) return;
		try { await apiPost(`/portal/contexts/${openId}/documents`, { path }); await loadDocs(openId); await load(); }
		catch (e: any) { error = e.message; }
	}
	async function detach(path: string) {
		if (!openId) return;
		try { await api(`/portal/contexts/${openId}/documents/${encodeURIComponent(path)}`, { method: 'DELETE' }); await loadDocs(openId); await load(); }
		catch (e: any) { error = e.message; }
	}
	async function regenerate(a: Area) {
		summarizing = true; error = null;
		try {
			const r = await apiPost<{ summary: string }>(`/portal/contexts/${a.id}/summary`, {});
			a.summary = r.summary; a.summary_updated_at = new Date().toISOString();
		} catch (e: any) { error = e.message || 'Could not generate summary'; } finally { summarizing = false; }
	}

	const attachedPaths = $derived(new Set(docs.map((d) => d.path)));
	function docName(d: Doc): string { return d.title || d.path.split('/').pop() || d.path; }
</script>

<div class="areas">
	<header class="head">
		<div>
			<h2>Areas</h2>
			<p class="lede">Group documents into life-domains — Work, Research, Health — and let Mycelium summarize each. These give your AI richer context about the different parts of your life.</p>
		</div>
	</header>

	<form class="new" onsubmit={(e) => { e.preventDefault(); create(); }}>
		<input type="text" bind:value={newName} placeholder="New area name (e.g. Health)" maxlength="50" />
		<button type="submit" class="btn btn-primary" disabled={creating || !newName.trim()}>{creating ? 'Adding…' : 'Add area'}</button>
	</form>

	{#if loading}
		<div class="muted">Loading…</div>
	{:else}
		<div class="list">
			{#each areas as a (a.id)}
				<div class="area" class:open={openId === a.id}>
					<button class="area-head" onclick={() => toggle(a)}>
						<div class="area-title">
							<span class="chevron">{openId === a.id ? '▾' : '▸'}</span>
							<span class="name">{a.name}</span>
							<span class="count">{a.doc_count} doc{a.doc_count === 1 ? '' : 's'}</span>
						</div>
						{#if a.summary}<p class="summary-peek">{a.summary}</p>{/if}
					</button>

					{#if openId === a.id}
						<div class="body">
							<!-- Summary -->
							<div class="block">
								<div class="block-head">
									<span class="block-label">Summary</span>
									<button class="btn btn-ghost btn-xs" onclick={() => regenerate(a)} disabled={summarizing || a.doc_count === 0} title={a.doc_count === 0 ? 'Attach documents first' : ''}>
										{summarizing ? 'Thinking…' : a.summary ? 'Regenerate' : 'Generate'}
									</button>
								</div>
								{#if a.summary}<p class="summary">{a.summary}</p>{:else}<p class="muted sm">No summary yet. Attach documents, then Generate.</p>{/if}
							</div>

							<!-- Documents -->
							<div class="block">
								<div class="block-head">
									<span class="block-label">Documents</span>
									<button class="btn btn-ghost btn-xs" onclick={openPicker}>＋ Attach</button>
								</div>
								{#if docs.length === 0}
									<p class="muted sm">Nothing attached yet.</p>
								{:else}
									{#each docs as d (d.path)}
										<div class="doc-row">
											<span class="doc-name" title={d.path}>{docName(d)}</span>
											<button class="link-remove" onclick={() => detach(d.path)}>Remove</button>
										</div>
									{/each}
								{/if}

								{#if picker}
									<div class="picker">
										<div class="picker-head"><span>Pick a document</span><button class="link-remove" onclick={() => (picker = false)}>Close</button></div>
										<div class="picker-list">
											{#each allDocs.filter((d) => !attachedPaths.has(d.path)).slice(0, 100) as d (d.path)}
												<button class="picker-item" onclick={() => attach(d.path)}>{docName(d)}</button>
											{:else}
												<p class="muted sm">No more documents to attach.</p>
											{/each}
										</div>
									</div>
								{/if}
							</div>

							{#if !a.is_default}
								<div class="actions">
									<button class="link" onclick={() => rename(a)}>Rename</button>
									<button class="link danger" onclick={() => remove(a)}>Delete area</button>
								</div>
							{/if}
						</div>
					{/if}
				</div>
			{/each}
		</div>
	{/if}

	{#if error}<button class="toast error" onclick={() => (error = null)}>{error}</button>{/if}
</div>

<style>
	.areas { max-width: 720px; }
	.head h2 { font-size: 1.1rem; font-weight: 500; color: var(--color-text-primary); }
	.lede { font-size: 0.82rem; color: var(--color-text-secondary); line-height: 1.55; margin-top: 0.35rem; }
	.new { display: flex; gap: 0.5rem; margin: 1.1rem 0; }
	.new input { flex: 1; padding: 0.55rem 0.75rem; font-size: 0.85rem; background: var(--glass-input-bg); border: 1px solid var(--glass-input-border); border-radius: 9px; color: var(--color-text-primary); outline: none; }
	.new input:focus { border-color: var(--color-accent-aurum); }
	.list { display: flex; flex-direction: column; gap: 0.5rem; }
	.area { border: 1px solid var(--color-border); border-radius: 12px; background: var(--color-surface); overflow: hidden; }
	.area.open { border-color: rgba(var(--color-accent-aurum-rgb), 0.4); }
	.area-head { width: 100%; text-align: left; background: none; border: none; padding: 0.8rem 0.9rem; cursor: pointer; color: inherit; }
	.area-title { display: flex; align-items: center; gap: 0.5rem; }
	.chevron { color: var(--color-text-tertiary); font-size: 0.7rem; }
	.name { font-weight: 600; font-size: 0.9rem; color: var(--color-text-emphasis); }
	.count { margin-left: auto; font-size: 0.72rem; color: var(--color-text-tertiary); }
	.summary-peek { font-size: 0.76rem; color: var(--color-text-tertiary); margin: 0.4rem 0 0 1.2rem; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
	.body { padding: 0 0.9rem 0.9rem; border-top: 1px solid var(--color-border); }
	.block { margin-top: 0.9rem; }
	.block-head { display: flex; align-items: center; justify-content: space-between; margin-bottom: 0.4rem; }
	.block-label { font-family: var(--font-mono); font-size: 0.6rem; letter-spacing: 0.1em; text-transform: uppercase; color: var(--color-text-tertiary); }
	.summary { font-size: 0.84rem; line-height: 1.55; color: var(--color-text-primary); background: var(--color-elevated); padding: 0.7rem 0.8rem; border-radius: 9px; }
	.doc-row { display: flex; align-items: center; justify-content: space-between; gap: 0.6rem; padding: 0.35rem 0; }
	.doc-name { font-size: 0.82rem; color: var(--color-text-primary); white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
	.picker { margin-top: 0.6rem; border: 1px solid var(--color-border); border-radius: 9px; background: var(--color-bg); }
	.picker-head { display: flex; justify-content: space-between; align-items: center; padding: 0.5rem 0.7rem; font-size: 0.72rem; color: var(--color-text-tertiary); border-bottom: 1px solid var(--color-border); }
	.picker-list { max-height: 220px; overflow-y: auto; padding: 0.3rem; }
	.picker-item { display: block; width: 100%; text-align: left; background: none; border: none; padding: 0.4rem 0.55rem; font-size: 0.8rem; border-radius: 7px; cursor: pointer; color: var(--color-text-secondary); }
	.picker-item:hover { background: var(--color-surface); color: var(--color-text-primary); }
	.actions { display: flex; gap: 1rem; margin-top: 0.9rem; }
	.link { background: none; border: none; cursor: pointer; font-size: 0.76rem; color: var(--color-text-tertiary); padding: 0; }
	.link:hover { color: var(--color-text-secondary); }
	.link.danger:hover { color: var(--color-accent-coral); }
	.link-remove { background: none; border: none; cursor: pointer; font-size: 0.7rem; color: var(--color-text-tertiary); }
	.link-remove:hover { color: var(--color-accent-coral); }
	.btn { padding: 0.45rem 0.8rem; font-size: 0.78rem; border-radius: 8px; cursor: pointer; border: none; }
	.btn-xs { padding: 0.28rem 0.6rem; font-size: 0.72rem; }
	.btn-primary { background: var(--color-accent-aurum); color: var(--color-bg); font-weight: 500; }
	.btn-primary:disabled { opacity: 0.5; cursor: not-allowed; }
	.btn-ghost { background: transparent; color: var(--color-text-secondary); border: 1px solid var(--color-border); }
	.btn-ghost:hover { color: var(--color-text-primary); }
	.btn-ghost:disabled { opacity: 0.5; cursor: not-allowed; }
	.muted { color: var(--color-text-tertiary); font-size: 0.82rem; }
	.muted.sm { font-size: 0.78rem; }
	.toast { position: fixed; bottom: 1.5rem; left: 50%; transform: translateX(-50%); padding: 0.5rem 1.25rem; border-radius: 8px; font-size: 0.78rem; z-index: 100; border: 1px solid rgba(var(--color-accent-coral-rgb), 0.3); background: rgba(var(--color-accent-coral-rgb), 0.15); color: var(--color-accent-coral); cursor: pointer; }
</style>
