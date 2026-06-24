<script lang="ts">
	import { onMount } from 'svelte';
	import { browser } from '$app/environment';
	import { workspace } from '$lib/workspace/store';
	import { api } from '$lib/api';
	import SporeField from '$lib/components/SporeField.svelte';
	import ContextTab from '$lib/components/spaces/ContextTab.svelte';
	import PublishStatusPill from '$lib/components/library/PublishStatusPill.svelte';
	import { navigationState } from '$lib/stores/navigation';
	import { subscribeToDoc } from '$lib/document-live';
	import { wrapHtmlForLive, mountLiveIframe, type LiveIframeHandle } from '$lib/iframe-live';

	interface Space {
		id: string;
		name: string;
		handle: string | null;
		settings: { essence?: string; voice?: string; coverDocPath?: string | null };
		role: string;
		knowledge_count: number;
		member_count: number;
		conversation_count: number;
		created_at: string;
	}

	interface KnowledgeEntry {
		id: string;
		content: string;
		source_type: string;
		source_ref?: string | null;
		domain_tags: string | null;
		status: string;
		created_at: string;
	}

	interface Member {
		user_id: string;
		display_name: string;
		role: string;
		last_active_at: string | null;
		created_at: string;
	}

	interface PickerTerritory {
		id: string;
		territory_id: number;
		name: string;
		essence: string | null;
		message_count: number;
		current_phase: string | null;
		current_vitality: number | null;
	}

	let space = $state<Space | null>(null);
	let knowledge = $state<KnowledgeEntry[]>([]);
	let members = $state<Member[]>([]);
	let loading = $state(true);
	// Sharing (Phase A): grant a connection access to this space (default-deny).
	// Cross-node delivery activates with the real-time channel (Matrix); the grant
	// is recorded + enforced locally now.
	let connections = $state<Array<{ other_user_id: string; other_handle: string | null; other_display_name: string | null }>>([]);
	let shareSel = $state('');
	let shareRole = $state<'member' | 'contributor'>('member');
	let sharing = $state(false);
	let shareError = $state<string | null>(null);
	// The in-page Chat tab was removed — chat now lives in ChatFloat, scoped
	// to this space via navigationState.spaceScope. Default landing tab is
	// now Knowledge (the space's actual content).
	let activeTab = $state<'context' | 'activity' | 'settings'>('context');
	// Workspace view: the space id arrives as a tab param (not a route param).
	let { id = null }: { id?: string | null } = $props();
	let spaceId = $derived(id);

	// Direct-entry state (Knowledge tab)
	let directContent = $state('');
	let directTagsRaw = $state('');
	let directSubmitting = $state(false);
	let directError = $state<string | null>(null);

	// Territory picker state
	let pickerOpen = $state(false);
	let pickerTerritories = $state<PickerTerritory[]>([]);
	let pickerLoading = $state(false);
	let pickerSelected = $state<Set<string>>(new Set());
	let pickerDepth = $state<'essence' | 'full'>('essence');
	let pickerSeeding = $state(false);
	let pickerSearch = $state('');
	let pickerError = $state<string | null>(null);
	// Cluster sharing: pick a level (territory / theme / realm) and share a whole
	// cluster at that level, not just individual territories.
	let pickerLevel = $state<'territory' | 'theme' | 'realm'>('territory');
	let pickerHierarchy = $state<Array<{ realm_id: number; name: string; essence?: string; territory_count: number; themes: Array<{ semantic_theme_id: number; name: string; essence?: string; territory_count: number }> }>>([]);
	let clusterAdding = $state('');

	async function loadSpace() {
		try {
			const [spaceRes, knowledgeRes, membersRes] = await Promise.all([
				api(`/portal/spaces/${spaceId}`),
				api(`/portal/spaces/${spaceId}/knowledge`),
				api(`/portal/spaces/${spaceId}/members`),
			]);

			if (spaceRes.ok) space = await spaceRes.json();
			if (knowledgeRes.ok) {
				const data = await knowledgeRes.json();
				knowledge = data.entries || [];
			}
			if (membersRes.ok) {
				const data = await membersRes.json();
				members = data.members || [];
			}
			loadConnections();

			// Scope the floating chat to this space. Intentionally NOT cleared
			// on page unmount — navigating away keeps the scope so the user can
			// ask "what's in this space?" from anywhere. The ChatFloat shows a
			// dismissible chip with the space name; scope switches automatically
			// if the user enters another space.
			if (space) {
				navigationState.setSpaceScope({ id: space.id, name: space.name });
				if (space.settings?.coverDocPath) loadCoverHtml(space.settings.coverDocPath);
				else { coverHtml = null; coverError = null; }
			}
		} catch (e) {
			console.error('Failed to load space:', e);
		} finally {
			loading = false;
		}
	}

	function openScopedChat() {
		if (space) navigationState.setSpaceScope({ id: space.id, name: space.name });
		navigationState.setChatOpen(true);
	}

	// ── Sharing ──────────────────────────────────────────────────────────
	async function loadConnections() {
		if (space?.role !== 'creator') return;
		try {
			const res = await api('/portal/connections');
			if (res.ok) connections = (await res.json()).connections || [];
		} catch {}
	}
	const grantedIds = $derived(new Set(members.map((m) => m.user_id)));
	const shareable = $derived(connections.filter((c) => !grantedIds.has(c.other_user_id)));
	async function shareWith() {
		if (!shareSel) return;
		sharing = true; shareError = null;
		try {
			const res = await api(`/portal/spaces/${spaceId}/shares`, {
				method: 'POST',
				headers: { 'Content-Type': 'application/json' },
				body: JSON.stringify({ granteeId: shareSel, role: shareRole }),
			});
			if (!res.ok) throw new Error((await res.json().catch(() => ({}))).error || 'Failed to share');
			shareSel = '';
			await loadSpace();
		} catch (e: any) { shareError = e.message; } finally { sharing = false; }
	}
	async function revokeShare(granteeId: string) {
		try {
			const res = await api(`/portal/spaces/${spaceId}/shares/${encodeURIComponent(granteeId)}`, { method: 'DELETE' });
			if (res.ok) await loadSpace();
		} catch {}
	}

	// Cover HTML content. null = not loaded / no cover set; '' = fetched
	// but empty (we still skip rendering); a non-empty string = ready to
	// render in the iframe. coverError is shown when the configured doc
	// can't be fetched.
	let coverHtml = $state<string | null>(null);
	let coverError = $state<string | null>(null);

	async function loadCoverHtml(docPath: string) {
		coverHtml = null;
		coverError = null;
		try {
			const res = await api(`/portal/documents/${docPath}`);
			if (!res.ok) throw new Error(`Cover doc ${res.status}`);
			const data = await res.json();
			// API returns { document: { content, ... } }; defensive fallback
			// to flat shape preserved in case of a proxy unwrap layer.
			const content = (data?.document?.content ?? data?.content ?? '');
			coverHtml = (typeof content === 'string' ? content.trim() : '') || null;
		} catch (e: any) {
			coverError = e?.message || 'Failed to load cover';
		}
	}

	// ── Live cover updates: when an agent rewrites the cover doc, the
	// iframe morphs in place via the iframe-live postMessage protocol.
	// Subscription is keyed on the cover doc's path; re-subscribes
	// automatically when the user picks a different cover.
	$effect(() => {
		if (!browser) return;
		const path = space?.settings?.coverDocPath;
		if (!path) return;
		const sub = subscribeToDoc(path, {
			onUpdate: () => loadCoverHtml(path),
			onDelete: () => {
				// Cover doc was deleted out from under us. Surface an
				// error state instead of leaving a stale render up.
				if (space?.settings) space.settings.coverDocPath = null;
				coverHtml = null;
				coverError = 'Cover document was deleted.';
			},
		});
		return () => sub.dispose();
	});

	// Iframe-live handle for the cover. Mounted/disposed when the
	// iframe element comes/goes; updates flow through `update()` which
	// picks postMessage when the bootloader is ready.
	let coverIframeEl = $state<HTMLIFrameElement | null>(null);
	let coverIframeHandle: LiveIframeHandle | null = null;
	$effect(() => {
		if (!coverIframeEl) return;
		coverIframeHandle?.dispose();
		coverIframeHandle = mountLiveIframe(coverIframeEl);
		return () => {
			coverIframeHandle?.dispose();
			coverIframeHandle = null;
		};
	});
	$effect(() => {
		if (!coverIframeEl || !coverHtml) return;
		const html = coverHtml;
		const last = (coverIframeEl as any).__lastLiveContent;
		if (last === html) return;
		(coverIframeEl as any).__lastLiveContent = html;
		if (coverIframeHandle) {
			coverIframeHandle.update(html);
		} else {
			coverIframeEl.srcdoc = wrapHtmlForLive(html);
		}
	});

	// Cover picker — picks a library doc to set as the space's cover.
	let savingCover = $state(false);
	let coverPickerOpen = $state(false);
	let coverLibraryDocs = $state<Array<{ path: string; title?: string }>>([]);
	let coverLibraryLoading = $state(false);
	let coverLibrarySearch = $state('');

	// Identity edits — name + essence + voice. Local mirrors of the
	// space's settings while the user types; a Save button commits.
	// We don't bind directly to `space.*` because that would fire a
	// re-render cascade on every keystroke.
	let editName = $state('');
	let editEssence = $state('');
	let editVoice = $state('');
	let savingIdentity = $state(false);
	let identityError = $state<string | null>(null);
	let identitySaved = $state(false);
	function syncEditFields() {
		editName = space?.name || '';
		editEssence = space?.settings?.essence || '';
		editVoice = space?.settings?.voice || '';
	}
	$effect(() => {
		// Whenever the space record reloads, refresh the form mirrors.
		if (space) syncEditFields();
	});

	async function saveIdentity() {
		if (!space) return;
		const name = editName.trim();
		if (!name) { identityError = 'Name cannot be empty'; return; }
		savingIdentity = true;
		identityError = null;
		identitySaved = false;
		try {
			const res = await api(`/portal/spaces/${space.id}`, {
				method: 'PUT',
				body: JSON.stringify({
					name,
					essence: editEssence.trim() || null,
					voice: editVoice.trim() || null,
				}),
			});
			if (!res.ok) {
				const data = await res.json().catch(() => ({}));
				throw new Error(data.error || `Save failed (${res.status})`);
			}
			identitySaved = true;
			await loadSpace();
			setTimeout(() => { identitySaved = false; }, 2000);
		} catch (e: any) {
			identityError = e?.message || 'Failed to save';
		} finally {
			savingIdentity = false;
		}
	}

	// Delete space — soft delete (server flips users.type='space_deleted').
	// Two-step confirm: type the space name to enable the button.
	// Collapsed by default — the "Delete this space" link expands the
	// confirm flow so the danger zone isn't shouting at you on every
	// settings visit.
	let deleteConfirmInput = $state('');
	let deleting = $state(false);
	let deleteError = $state<string | null>(null);
	let deleteOpen = $state(false);
	const deleteConfirmReady = $derived(
		deleteConfirmInput.trim() === (space?.name?.trim() || ''),
	);
	async function deleteSpace() {
		if (!space || !deleteConfirmReady) return;
		deleting = true;
		deleteError = null;
		try {
			const res = await api(`/portal/spaces/${space.id}`, { method: 'DELETE' });
			if (!res.ok) {
				const data = await res.json().catch(() => ({}));
				throw new Error(data.error || `Delete failed (${res.status})`);
			}
			// Bounce out to the spaces index — this space is gone.
			workspace.openOrFocus('spaces', {});
		} catch (e: any) {
			deleteError = e?.message || 'Failed to delete';
			deleting = false;
		}
	}

	const filteredCoverDocs = $derived(() => {
		const q = coverLibrarySearch.trim().toLowerCase();
		const list = coverLibraryDocs;
		if (!q) return list;
		return list.filter(
			(d) => d.path.toLowerCase().includes(q) || (d.title || '').toLowerCase().includes(q),
		);
	});

	async function openCoverPicker() {
		coverPickerOpen = true;
		coverLibrarySearch = '';
		if (coverLibraryDocs.length === 0) {
			coverLibraryLoading = true;
			try {
				const res = await api('/portal/documents');
				if (res.ok) {
					const data = await res.json();
					coverLibraryDocs = data.documents || [];
				}
			} finally {
				coverLibraryLoading = false;
			}
		}
	}

	async function setCover(docPath: string | null) {
		if (!space) return;
		savingCover = true;
		coverError = null;
		try {
			const res = await api(`/portal/spaces/${space.id}`, {
				method: 'PUT',
				headers: { 'Content-Type': 'application/json' },
				body: JSON.stringify({ coverDocPath: docPath }),
			});
			if (!res.ok) {
				const data = await res.json().catch(() => ({}));
				throw new Error(data.error || `Save failed (${res.status})`);
			}
			coverPickerOpen = false;
			await loadSpace();
		} catch (e: any) {
			coverError = e?.message || 'Failed to set cover';
		} finally {
			savingCover = false;
		}
	}

	function clearCover() {
		setCover(null);
	}

	async function submitDirect() {
		const content = directContent.trim();
		if (!content || directSubmitting) return;
		if (content.length > 4000) {
			directError = 'Content must be 4000 characters or less.';
			return;
		}
		const tags = directTagsRaw
			.split(',')
			.map((t) => t.trim())
			.filter(Boolean);
		directSubmitting = true;
		directError = null;
		try {
			const res = await api(`/portal/spaces/${spaceId}/knowledge`, {
				method: 'POST',
				body: JSON.stringify({
					content,
					domain_tags: tags.length ? tags : undefined,
				}),
			});
			if (res.ok) {
				const entry = await res.json();
				knowledge = [
					{
						id: entry.id,
						content: entry.content,
						source_type: entry.source_type || 'direct',
						domain_tags: entry.domain_tags ? JSON.stringify(entry.domain_tags) : null,
						status: 'active',
						created_at: new Date().toISOString(),
					},
					...knowledge,
				];
				directContent = '';
				directTagsRaw = '';
			} else {
				const err = await res.json().catch(() => ({ error: 'Failed to add' }));
				directError = err.error || 'Failed to add';
			}
		} catch {
			directError = 'Network error — try again.';
		} finally {
			directSubmitting = false;
		}
	}

	async function openPicker() {
		pickerOpen = true;
		pickerSelected = new Set();
		pickerSearch = '';
		pickerError = null;
		if (pickerTerritories.length === 0) {
			pickerLoading = true;
			try {
				const res = await api(`/portal/spaces/territories`);
				if (res.ok) {
					const data = await res.json();
					pickerTerritories = data.territories || [];
				} else {
					pickerError = 'Failed to load territories.';
				}
			} catch {
				pickerError = 'Network error loading territories.';
			} finally {
				pickerLoading = false;
			}
		}
		// Load the cluster hierarchy (Realm → Theme) for the higher-level options.
		if (pickerHierarchy.length === 0) {
			try {
				const res = await api(`/portal/spaces/cluster-hierarchy`);
				if (res.ok) pickerHierarchy = (await res.json()).realms || [];
			} catch {}
		}
	}

	async function refreshKnowledge() {
		const k = await api(`/portal/spaces/${spaceId}/knowledge`);
		if (k.ok) knowledge = (await k.json()).entries || [];
	}

	// Share a whole cluster (realm or theme) at the chosen level.
	async function addCluster(payload: { level: string; realm_id?: number; semantic_theme_id?: number }, key: string) {
		clusterAdding = key;
		pickerError = null;
		try {
			const res = await api(`/portal/spaces/${spaceId}/seed-cluster`, {
				method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(payload),
			});
			if (res.ok) { pickerOpen = false; await refreshKnowledge(); }
			else { const e = await res.json().catch(() => ({})); pickerError = e.error || 'Failed to add cluster'; }
		} catch { pickerError = 'Network error — try again.'; } finally { clusterAdding = ''; }
	}

	function togglePick(id: string) {
		const next = new Set(pickerSelected);
		if (next.has(id)) next.delete(id);
		else next.add(id);
		pickerSelected = next;
	}

	async function submitPicker() {
		if (pickerSelected.size === 0 || pickerSeeding) return;
		pickerSeeding = true;
		pickerError = null;
		try {
			const res = await api(`/portal/spaces/${spaceId}/seed`, {
				method: 'POST',
				body: JSON.stringify({
					territory_ids: [...pickerSelected],
					depth: pickerDepth,
				}),
			});
			if (res.ok) {
				pickerOpen = false;
				const k = await api(`/portal/spaces/${spaceId}/knowledge`);
				if (k.ok) {
					const data = await k.json();
					knowledge = data.entries || [];
				}
			} else {
				const err = await res.json().catch(() => ({ error: 'Seed failed' }));
				pickerError = err.error || 'Seed failed';
			}
		} catch {
			pickerError = 'Network error — try again.';
		} finally {
			pickerSeeding = false;
		}
	}

	async function deleteKnowledge(entryId: string) {
		if (!confirm('Remove this knowledge entry?')) return;
		const res = await api(`/portal/spaces/${spaceId}/knowledge/${entryId}`, { method: 'DELETE' });
		if (res.ok) {
			knowledge = knowledge.filter(k => k.id !== entryId);
		}
	}

	function formatDate(dateStr: string) {
		const d = new Date(dateStr);
		const now = new Date();
		const diff = now.getTime() - d.getTime();
		if (diff < 3600000) return `${Math.round(diff / 60000)}m ago`;
		if (diff < 86400000) return `${Math.round(diff / 3600000)}h ago`;
		if (diff < 604800000) return `${Math.round(diff / 86400000)}d ago`;
		return d.toLocaleDateString();
	}

	// Curated entries all come from the agent's scan→synthesize loop.
	// They share a group header so the user sees what Mya contributed
	// distinctly from territory seeds and direct user entry.
	function isCurated(sourceType: string) {
		return typeof sourceType === 'string' && sourceType.startsWith('curated_');
	}

	function groupKnowledge(entries: KnowledgeEntry[]) {
		const groups: Record<string, KnowledgeEntry[]> = {
			curated: [], territory_seed: [], conversation: [], reflection: [], direct: [],
		};
		for (const e of entries) {
			let key: string;
			if (isCurated(e.source_type)) key = 'curated';
			else if (e.source_type in groups) key = e.source_type;
			else key = 'direct';
			groups[key].push(e);
		}
		return groups;
	}

	const knowledgeGroups = $derived(groupKnowledge(knowledge));
	const groupLabels: Record<string, string> = {
		curated: 'Curated by Mya',
		territory_seed: 'Territory Seeds',
		conversation: 'Conversation Insights',
		reflection: 'Reflections',
		direct: 'Direct',
	};

	// Strip `kind:` prefix for display; keep the full ref in a tooltip.
	function sourceRefLabel(ref: string | null | undefined) {
		if (!ref) return '';
		const colon = ref.indexOf(':');
		return colon === -1 ? ref : ref.slice(0, colon);
	}

	const curatedCount = $derived(knowledge.filter(k => isCurated(k.source_type)).length);
	const seedCount = $derived(knowledge.filter(k => k.source_type === 'territory_seed').length);
	const convCount = $derived(knowledge.filter(k => k.source_type === 'conversation').length);
	const refCount = $derived(knowledge.filter(k => k.source_type === 'reflection').length);
	const knowledgeTotal = $derived(knowledge.length || 1);

	onMount(() => {
		loadSpace();
	});
</script>

<svelte:window onkeydown={(e) => { if (pickerOpen && e.key === 'Escape') pickerOpen = false; }} />

{#if loading}
	<div class="flex items-center justify-center h-full">
		<div class="w-8 h-8 border-2 border-[var(--color-border)] border-t-[var(--color-accent)] rounded-full animate-spin"></div>
	</div>
{:else if !space}
	<div class="flex items-center justify-center h-full">
		<p class="text-sm text-[var(--color-text-tertiary)]">Space not found</p>
	</div>
{:else}
	<div class="flex flex-col h-full overflow-hidden relative">
		<!-- Ambient background -->
		<div class="absolute inset-0 overflow-hidden pointer-events-none" style="z-index: 0;">
			<SporeField density={50} speed={0.06} connectionDistance={50} interactive={false} />
		</div>
		<!-- Header -->
		<div class="px-5 pt-5 pb-0 shrink-0 relative z-10">
			<div class="flex items-start justify-between mb-3">
				<div class="flex items-center gap-2.5">
					<div class="w-2.5 h-2.5 rounded-full bg-aurum"></div>
					<h1 class="text-xl font-semibold text-[var(--color-text-emphasis)]">{space.name}</h1>
				</div>
				<div class="flex items-center gap-2">
					{#if space.role === 'creator'}
						<button
							aria-label="Space settings"
							title="Space settings"
							onclick={() => { activeTab = 'settings'; }}
							class="p-2 rounded-lg transition-colors {activeTab === 'settings' ? 'text-aurum bg-aurum/10' : 'text-[var(--color-text-tertiary)] hover:text-[var(--color-text-primary)] hover:bg-[var(--color-elevated)]'}"
						>
							<svg class="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path stroke-linecap="round" stroke-linejoin="round" stroke-width="1.5" d="M10.325 4.317c.426-1.756 2.924-1.756 3.35 0a1.724 1.724 0 002.573 1.066c1.543-.94 3.31.826 2.37 2.37a1.724 1.724 0 001.066 2.573c1.756.426 1.756 2.924 0 3.35a1.724 1.724 0 00-1.066 2.573c.94 1.543-.826 3.31-2.37 2.37a1.724 1.724 0 00-2.573 1.066c-.426 1.756-2.924 1.756-3.35 0a1.724 1.724 0 00-2.573-1.066c-1.543.94-3.31-.826-2.37-2.37a1.724 1.724 0 00-1.066-2.573c-1.756-.426-1.756-2.924 0-3.35a1.724 1.724 0 001.066-2.573c-.94-1.543.826-3.31 2.37-2.37.996.608 2.296.07 2.572-1.065z" /><path stroke-linecap="round" stroke-linejoin="round" stroke-width="1.5" d="M15 12a3 3 0 11-6 0 3 3 0 016 0z" /></svg>
						</button>
					{/if}
				</div>
			</div>
			{#if space.settings?.essence}
				<p class="text-sm text-[var(--color-text-secondary)] mb-3">{space.settings.essence}</p>
			{/if}
			<div class="flex items-center gap-5 mb-4 text-[11px] font-mono text-[var(--color-text-tertiary)]">
				<span>{space.knowledge_count} knowledge</span>
				<span>{space.member_count} members</span>
				<span>{space.conversation_count} conversations</span>
			</div>

			<!-- Cover HTML — when the space has a cover_doc_path set in
			     its settings, the chosen library doc renders here as the
			     space's landing interface. The agent (or owner) can author
			     this HTML to link to seeded files via /library?doc=<path>;
			     allow-top-navigation-by-user-activation lets those clicks
			     navigate the portal frame, while still blocking scripted
			     redirects. When no cover is set, this block is skipped and
			     the Context tab is the default landing. -->
			{#if coverHtml !== null}
				<div class="relative mb-5 rounded-2xl overflow-hidden border border-[var(--color-border)] bg-white">
					<iframe
						bind:this={coverIframeEl}
						title="{space.name} cover"
						sandbox="allow-scripts allow-popups allow-top-navigation-by-user-activation"
						class="w-full border-0 block"
						style="height: min(60vh, 640px);"
					></iframe>
					<!-- Top-right overlay group: publish-status pill (cover doc
						 is what gets published when the operator chooses to)
						 + manual reload. The pill drives publishing on the
						 cover doc itself; reload is for "the agent just edited
						 this, show me now" without waiting for the auto-poll. -->
					<div class="absolute top-3 right-3 flex items-center gap-2">
						{#if space.settings?.coverDocPath && (space.role === 'creator' || space.role === 'contributor')}
							<PublishStatusPill docPath={space.settings.coverDocPath} />
						{/if}
						<button
							type="button"
							onclick={() => space?.settings?.coverDocPath && loadCoverHtml(space.settings.coverDocPath)}
							class="flex items-center justify-center w-7 h-7 rounded-full bg-black/40 hover:bg-black/60 backdrop-blur-sm transition-colors"
							aria-label="Reload cover"
							title="Reload cover"
						>
							<svg
								class="w-3.5 h-3.5 text-white/90"
								fill="none" stroke="currentColor" viewBox="0 0 24 24" stroke-width="1.75"
							>
								<path stroke-linecap="round" stroke-linejoin="round" d="M4 4v6h6 M20 20v-6h-6 M5 13a8 8 0 0014.5 4 M19 11A8 8 0 004.5 7" />
							</svg>
						</button>
					</div>
				</div>
			{:else if space.settings?.coverDocPath && coverHtml === null && !coverError}
				<!-- Loading skeleton for the cover (briefly visible). -->
				<div class="mb-5 rounded-2xl border border-[var(--color-border)] bg-[var(--color-elevated)] animate-pulse" style="height: 280px;"></div>
			{/if}

			<!-- Tabs -->
			<div class="flex gap-0 border-b border-[var(--color-border)] items-end">
				{#each ['context', 'activity'] as tab}
					<button
						onclick={() => { activeTab = tab as any; }}
						class="relative px-4 py-2.5 text-sm transition-colors
							{activeTab === tab ? 'text-[var(--color-text-primary)] font-medium' : 'text-[var(--color-text-tertiary)] hover:text-[var(--color-text-secondary)]'}"
					>
						{tab.charAt(0).toUpperCase() + tab.slice(1)}
						{#if activeTab === tab}
							<div class="absolute bottom-0 left-0 right-0 h-0.5 bg-aurum rounded-full" style="transition: all 250ms ease-in-out;"></div>
						{/if}
					</button>
				{/each}
				<!-- Open the floating chat pre-scoped to this space. Users who
				     want to talk to the space click here instead of the old
				     inline Chat tab (which duplicated ChatFloat poorly). -->
				<button
					onclick={openScopedChat}
					class="ml-auto mr-0 mb-1 flex items-center gap-1.5 px-3 py-1.5 rounded-lg text-xs font-medium text-amethyst bg-amethyst/10 hover:bg-amethyst/20 transition-colors"
					title="Open chat scoped to this space"
				>
					<svg class="w-3.5 h-3.5" fill="none" stroke="currentColor" viewBox="0 0 24 24">
						<path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M8 10h.01M12 10h.01M16 10h.01M9 16H5a2 2 0 01-2-2V6a2 2 0 012-2h14a2 2 0 012 2v8a2 2 0 01-2 2h-5l-5 5v-5z" />
					</svg>
					Open chat
				</button>
				{#if space.role === 'creator'}
					<button
						onclick={() => { activeTab = 'settings'; }}
						class="relative px-4 py-2.5 text-sm transition-colors
							{activeTab === 'settings' ? 'text-[var(--color-text-primary)] font-medium' : 'text-[var(--color-text-tertiary)] hover:text-[var(--color-text-secondary)]'}"
					>
						Settings
						{#if activeTab === 'settings'}
							<div class="absolute bottom-0 left-0 right-0 h-0.5 bg-aurum rounded-full"></div>
						{/if}
					</button>
				{/if}
			</div>
		</div>

		<!-- Tab content -->
		<div class="flex-1 overflow-y-auto relative z-10">
			{#if activeTab === 'context'}
				<ContextTab
					spaceId={spaceId || ''}
					canEdit={space.role === 'creator' || space.role === 'contributor'}
				/>
			{:else if activeTab === 'activity'}
				<!-- Activity -->
				<div class="px-5 py-4">
					{#if knowledge.length === 0}
						<div class="text-center py-12">
							<p class="text-sm text-[var(--color-text-tertiary)]">This space hasn't grown yet.</p>
							<p class="text-xs text-[var(--color-text-tertiary)] mt-1">Seed knowledge and start conversations to watch it evolve.</p>
						</div>
					{:else}
						<!-- Knowledge growth bar -->
						<div class="mb-6">
							<div class="flex items-center justify-between mb-2">
								<span class="text-xs font-medium text-[var(--color-text-tertiary)] uppercase tracking-wider">Knowledge growth</span>
								<span class="text-xs font-mono font-semibold text-[var(--color-text-primary)]">{knowledge.length} entries</span>
							</div>
							<div class="h-1.5 rounded-full bg-[var(--color-elevated)] overflow-hidden flex">
								<div class="h-full bg-jade" style="width: {(seedCount / knowledgeTotal) * 100}%; transition: width 0.6s ease-out;"></div>
								<div class="h-full bg-amethyst" style="width: {(curatedCount / knowledgeTotal) * 100}%; transition: width 0.6s ease-out;"></div>
								<div class="h-full bg-[var(--color-accent)]" style="width: {(convCount / knowledgeTotal) * 100}%; transition: width 0.6s ease-out;"></div>
								<div class="h-full bg-aurum" style="width: {(refCount / knowledgeTotal) * 100}%; transition: width 0.6s ease-out;"></div>
							</div>
							<div class="flex items-center gap-4 mt-2 text-[10px] text-[var(--color-text-tertiary)] flex-wrap">
								<span class="flex items-center gap-1"><span class="w-2 h-2 rounded-full bg-jade"></span> seeds: {seedCount}</span>
								<span class="flex items-center gap-1"><span class="w-2 h-2 rounded-full bg-amethyst"></span> curated: {curatedCount}</span>
								<span class="flex items-center gap-1"><span class="w-2 h-2 rounded-full bg-[var(--color-accent)]"></span> conversations: {convCount}</span>
								<span class="flex items-center gap-1"><span class="w-2 h-2 rounded-full bg-aurum"></span> reflections: {refCount}</span>
							</div>
						</div>

						<!-- Timeline -->
						<h3 class="text-xs font-medium text-[var(--color-text-tertiary)] uppercase tracking-wider mb-3">Timeline</h3>
						<div class="space-y-2">
							{#each knowledge.slice(0, 30) as entry, i (entry.id)}
								<div
									class="flex items-start gap-3 p-3 rounded-lg"
									style="animation: fadeSlide 300ms ease-out {i * 50}ms both;"
								>
									<div class="w-1.5 h-1.5 rounded-full mt-1.5 shrink-0
										{isCurated(entry.source_type) ? 'bg-amethyst' : entry.source_type === 'territory_seed' ? 'bg-jade' : entry.source_type === 'reflection' ? 'bg-aurum' : 'bg-[var(--color-accent)]'}"></div>
									<div class="min-w-0">
										<p class="text-sm text-[var(--color-text-primary)] line-clamp-2">{entry.content}</p>
										<span class="text-[10px] font-mono text-[var(--color-text-tertiary)]">{formatDate(entry.created_at)}</span>
									</div>
								</div>
							{/each}
						</div>
					{/if}
				</div>

			{:else if activeTab === 'settings'}
				<!-- Settings — long-form, hairline-divided sections.
				     Each section earns its space; no boxy cards stacking
				     identical heights. Identity at the top (the space
				     IS its name + essence + voice), Cover & Visibility
				     mid-page, Members below, Delete tucked at the
				     bottom behind a disclosure. -->
				<div class="max-w-2xl mx-auto px-5 py-6 space-y-10">

					<!-- ── Identity ── -->
					<section>
						<header class="mb-5">
							<h2 class="text-base font-medium text-[var(--color-text-emphasis)]">Identity</h2>
							<p class="text-xs text-[var(--color-text-tertiary)] mt-0.5">How this space introduces itself.</p>
						</header>

						<div class="space-y-4">
							<div>
								<label for="sp-name" class="block text-[11px] uppercase tracking-wider text-[var(--color-text-tertiary)] mb-1.5">Name</label>
								<input
									id="sp-name"
									type="text"
									bind:value={editName}
									maxlength="80"
									class="w-full px-0 py-1 bg-transparent text-lg font-medium text-[var(--color-text-primary)] border-0 border-b border-[var(--color-border)] focus:outline-none focus:border-[var(--color-accent-aurum)] transition-colors"
								/>
							</div>
							<div>
								<label for="sp-essence" class="block text-[11px] uppercase tracking-wider text-[var(--color-text-tertiary)] mb-1.5">Essence</label>
								<textarea
									id="sp-essence"
									bind:value={editEssence}
									rows="3"
									maxlength="500"
									placeholder="What is this space about?"
									class="w-full px-0 py-1 bg-transparent text-sm text-[var(--color-text-primary)] border-0 border-b border-[var(--color-border)] focus:outline-none focus:border-[var(--color-accent-aurum)] transition-colors resize-none placeholder:text-[var(--color-text-tertiary)]"
								></textarea>
							</div>
							<div>
								<label for="sp-voice" class="block text-[11px] uppercase tracking-wider text-[var(--color-text-tertiary)] mb-1.5">Voice</label>
								<input
									id="sp-voice"
									type="text"
									bind:value={editVoice}
									maxlength="60"
									placeholder="conversational, precise, warm…"
									class="w-full px-0 py-1 bg-transparent text-sm text-[var(--color-text-primary)] border-0 border-b border-[var(--color-border)] focus:outline-none focus:border-[var(--color-accent-aurum)] transition-colors placeholder:text-[var(--color-text-tertiary)]"
								/>
							</div>
						</div>

						<!-- Save bar — appears with a subtle slide when changes are pending.
						     Right-aligned so it doesn't sit under your typing cursor. -->
						<div class="mt-4 flex items-center justify-end gap-3">
							{#if identitySaved}
								<span class="text-[11px] text-jade flex items-center gap-1">
									<svg class="w-3 h-3" fill="none" stroke="currentColor" viewBox="0 0 24 24" stroke-width="3"><path stroke-linecap="round" stroke-linejoin="round" d="M5 13l4 4L19 7"/></svg>
									Saved
								</span>
							{/if}
							{#if identityError}
								<span class="text-[11px] text-coral">{identityError}</span>
							{/if}
							<button
								onclick={saveIdentity}
								disabled={savingIdentity || !editName.trim()}
								class="px-4 py-1.5 rounded-lg text-xs font-medium bg-aurum text-[var(--color-bg)] hover:opacity-90 transition-opacity disabled:opacity-30 disabled:cursor-not-allowed"
							>
								{savingIdentity ? 'Saving…' : 'Save changes'}
							</button>
						</div>
					</section>

					<hr class="border-[var(--color-border)]" />

					<!-- ── Cover & Visibility ── -->
					<section>
						<header class="mb-5">
							<h2 class="text-base font-medium text-[var(--color-text-emphasis)]">Cover &amp; visibility</h2>
							<p class="text-xs text-[var(--color-text-tertiary)] mt-0.5">
								Pick a library doc to render as the landing surface, and decide who can see it.
							</p>
						</header>

						{#if space.settings?.coverDocPath}
							<!-- Active cover: file pill + actions on one line -->
							<div class="flex items-center gap-3 p-3 rounded-xl bg-[var(--color-elevated)] border border-[var(--color-border)]">
								<div class="flex-shrink-0 w-9 h-9 rounded-lg bg-aurum/10 flex items-center justify-center">
									<svg class="w-4 h-4 text-aurum" fill="none" stroke="currentColor" viewBox="0 0 24 24" stroke-width="1.75">
										<path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z"/>
										<polyline points="14 2 14 8 20 8"/>
									</svg>
								</div>
								<div class="flex-1 min-w-0">
									<div class="text-[11px] uppercase tracking-wider text-[var(--color-text-tertiary)]">Active cover</div>
									<div class="text-xs font-mono text-[var(--color-text-secondary)] truncate">{space.settings.coverDocPath}</div>
								</div>
								<button
									onclick={openCoverPicker}
									class="text-xs text-[var(--color-text-secondary)] hover:text-[var(--color-text-primary)] transition-colors px-2 py-1"
								>Change</button>
								<button
									onclick={clearCover}
									disabled={savingCover}
									class="text-xs text-[var(--color-text-tertiary)] hover:text-coral transition-colors px-2 py-1"
								>Remove</button>
							</div>

							<!-- Visibility — the publish pill takes center stage now -->
							<div class="mt-5">
								<div class="text-[11px] uppercase tracking-wider text-[var(--color-text-tertiary)] mb-2">Visibility</div>
								<div class="inline-flex items-center bg-black/40 rounded-full">
									<PublishStatusPill docPath={space.settings.coverDocPath} />
								</div>
								<p class="text-[11px] text-[var(--color-text-tertiary)] mt-2 max-w-md leading-relaxed">
									Private by default. Click the pill to invite specific people via tokenised
									link, or publish the cover doc on the open web.
								</p>
							</div>
						{:else}
							<!-- No cover yet -->
							<div class="p-6 rounded-xl border border-dashed border-[var(--color-border)] bg-[var(--color-bg)] text-center">
								<svg class="w-8 h-8 mx-auto text-[var(--color-text-tertiary)] mb-2" fill="none" stroke="currentColor" viewBox="0 0 24 24" stroke-width="1.25">
									<path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z"/>
									<polyline points="14 2 14 8 20 8"/>
								</svg>
								<p class="text-xs text-[var(--color-text-secondary)] mb-1">No cover set</p>
								<p class="text-[11px] text-[var(--color-text-tertiary)] mb-4">The Context tab is the default landing.</p>
								<button
									onclick={openCoverPicker}
									class="px-3 py-1.5 rounded-lg text-xs font-medium text-aurum bg-aurum/10 hover:bg-aurum/20 transition-colors"
								>
									Choose cover doc
								</button>
							</div>
						{/if}

						{#if coverError}
							<p class="text-[11px] text-coral mt-3">{coverError}</p>
						{/if}
					</section>

					<hr class="border-[var(--color-border)]" />

					<!-- ── Members ── -->
					<section>
						<header class="mb-5">
							<h2 class="text-base font-medium text-[var(--color-text-emphasis)]">Members &amp; sharing</h2>
							<p class="text-xs text-[var(--color-text-tertiary)] mt-0.5">
								Private by default. Share with a connection to grant access.
							</p>
						</header>

						<!-- Share with a connection -->
						<div class="flex items-end gap-2 mb-4 flex-wrap">
							<select bind:value={shareSel} class="px-2.5 py-1.5 text-xs rounded-lg bg-[var(--color-bg)] border border-[var(--color-border)] text-[var(--color-text-primary)] min-w-[180px]">
								<option value="">{shareable.length ? 'Choose a connection…' : 'No connections to share with'}</option>
								{#each shareable as c}
									<option value={c.other_user_id}>@{c.other_handle || c.other_display_name || c.other_user_id}</option>
								{/each}
							</select>
							<select bind:value={shareRole} class="px-2.5 py-1.5 text-xs rounded-lg bg-[var(--color-bg)] border border-[var(--color-border)] text-[var(--color-text-primary)]">
								<option value="member">can view</option>
								<option value="contributor">can add</option>
							</select>
							<button onclick={shareWith} disabled={!shareSel || sharing} class="px-3 py-1.5 text-xs font-medium rounded-lg bg-aurum text-[var(--color-bg)] disabled:opacity-50">
								{sharing ? 'Sharing…' : 'Share'}
							</button>
						</div>
						{#if shareError}<p class="text-xs text-coral mb-3">{shareError}</p>{/if}
						<p class="text-[10px] text-[var(--color-text-tertiary)] mb-4">Cross-instance delivery activates once your real-time channel is set up.</p>

						<div class="space-y-2">
							{#each members as m (m.user_id)}
								<div class="flex items-center gap-3 py-2.5">
									<div class="flex-shrink-0 w-8 h-8 rounded-full flex items-center justify-center text-[11px] font-medium {m.role === 'creator' ? 'bg-aurum/15 text-aurum' : m.role === 'contributor' ? 'bg-amethyst/15 text-amethyst' : 'bg-[var(--color-elevated)] text-[var(--color-text-secondary)]'}">
										{(m.display_name || '?').slice(0, 1).toUpperCase()}
									</div>
									<div class="flex-1 min-w-0">
										<div class="text-sm text-[var(--color-text-primary)] truncate">{m.display_name}</div>
										<div class="text-[10px] text-[var(--color-text-tertiary)] flex items-center gap-1.5">
											<span class="capitalize">{m.role}</span>
											<span>·</span>
											<span class="font-mono">{m.last_active_at ? formatDate(m.last_active_at) : 'never active'}</span>
										</div>
									</div>
									{#if m.role !== 'creator'}
										<button onclick={() => revokeShare(m.user_id)} class="text-[10px] text-[var(--color-text-tertiary)] hover:text-coral transition-colors flex-shrink-0">Remove</button>
									{/if}
								</div>
							{/each}
						</div>
					</section>

					<hr class="border-[var(--color-border)]" />

					<!-- ── Delete (collapsed by default) ── -->
					<section>
						{#if !deleteOpen}
							<button
								onclick={() => { deleteOpen = true; }}
								class="text-xs text-[var(--color-text-tertiary)] hover:text-coral transition-colors flex items-center gap-1.5"
							>
								<svg class="w-3 h-3" fill="none" stroke="currentColor" viewBox="0 0 24 24" stroke-width="2">
									<path stroke-linecap="round" stroke-linejoin="round" d="M9 5l7 7-7 7"/>
								</svg>
								Delete this space
							</button>
						{:else}
							<header class="mb-3">
								<h3 class="text-sm font-medium text-coral">Delete this space</h3>
								<p class="text-xs text-[var(--color-text-tertiary)] mt-1 max-w-md leading-relaxed">
									This removes the space from your spaces list and stops new contributions.
									Knowledge entries, messages, and folders are preserved in storage but no
									longer accessible through the UI.
								</p>
							</header>
							<label for="sp-delete-confirm" class="block text-[11px] text-[var(--color-text-tertiary)] mb-1.5">
								Type <span class="font-mono text-[var(--color-text-primary)]">{space.name}</span> to confirm
							</label>
							<input
								id="sp-delete-confirm"
								type="text"
								bind:value={deleteConfirmInput}
								placeholder={space.name}
								class="w-full px-3 py-2 rounded-lg bg-[var(--color-bg)] text-sm text-[var(--color-text-primary)] border border-[var(--color-border)] focus:outline-none focus:border-coral mb-3 max-w-md"
							/>
							<div class="flex items-center gap-3">
								<button
									onclick={deleteSpace}
									disabled={!deleteConfirmReady || deleting}
									class="px-4 py-1.5 rounded-lg text-xs font-medium bg-coral/90 text-[var(--color-bg)] hover:bg-coral transition-colors disabled:opacity-30 disabled:cursor-not-allowed"
								>
									{deleting ? 'Deleting…' : 'Delete space'}
								</button>
								<button
									onclick={() => { deleteOpen = false; deleteConfirmInput = ''; deleteError = null; }}
									class="text-xs text-[var(--color-text-tertiary)] hover:text-[var(--color-text-primary)] transition-colors"
								>Cancel</button>
								{#if deleteError}
									<span class="text-[11px] text-coral">{deleteError}</span>
								{/if}
							</div>
						{/if}
					</section>

				</div>
			{/if}
		</div>

		{#if pickerOpen}
			<!-- Territory picker modal -->
			<div
				class="fixed inset-0 z-50 flex items-center justify-center p-4"
				style="background: rgba(10, 10, 12, 0.72); backdrop-filter: blur(20px) saturate(140%);"
				onclick={() => { pickerOpen = false; }}
				onkeydown={(e) => { if (e.key === 'Escape') pickerOpen = false; }}
				role="presentation"
			>
				<div
					class="w-full max-w-xl rounded-2xl border border-white/[0.06] flex flex-col max-h-[85vh]"
					style="background: rgba(26, 26, 31, 0.95);"
					onclick={(e) => e.stopPropagation()}
					onkeydown={(e) => e.stopPropagation()}
					role="dialog"
					aria-modal="true"
					aria-labelledby="picker-title"
					tabindex={-1}
				>
					<div class="px-6 pt-6 pb-4 shrink-0">
						<h2 id="picker-title" class="text-lg font-medium text-[var(--color-text-emphasis)] mb-1">Share from your mindscape</h2>
						<p class="text-xs text-[var(--color-text-tertiary)] mb-3">
							Share a whole cluster at a level, or individual territories. Each becomes a knowledge entry the space can draw on.
						</p>

						<!-- Level selector -->
						<div class="inline-flex rounded-lg border border-[var(--color-border)] overflow-hidden mb-4 text-xs">
							{#each [['territory', 'Territories'], ['theme', 'Themes'], ['realm', 'Realms']] as [lvl, lbl]}
								<button
									onclick={() => { pickerLevel = lvl as any; pickerError = null; }}
									class="px-3 py-1.5 transition-colors {pickerLevel === lvl ? 'bg-aurum text-[var(--color-bg)] font-medium' : 'text-[var(--color-text-secondary)] hover:bg-[var(--color-elevated)]'}"
								>{lbl}</button>
							{/each}
						</div>

						<!-- Depth radio (territory level only) -->
						<div class="flex items-center gap-3 mb-4" class:hidden={pickerLevel !== 'territory'}>
							<span class="text-[11px] font-medium text-[var(--color-text-tertiary)] uppercase tracking-wider">Depth</span>
							<label class="flex items-center gap-1.5 cursor-pointer">
								<input
									type="radio"
									bind:group={pickerDepth}
									value="essence"
									class="accent-aurum"
								/>
								<span class="text-xs text-[var(--color-text-primary)]">Essence</span>
							</label>
							<label class="flex items-center gap-1.5 cursor-pointer">
								<input
									type="radio"
									bind:group={pickerDepth}
									value="full"
									class="accent-aurum"
								/>
								<span class="text-xs text-[var(--color-text-primary)]">Full <span class="text-[var(--color-text-tertiary)]">(+ current state + bridges)</span></span>
							</label>
						</div>

						<!-- Search (territory level only) -->
						<input
							type="text"
							bind:value={pickerSearch}
							placeholder="Filter territories…"
							class:hidden={pickerLevel !== 'territory'}
							class="w-full px-3 py-2 rounded-lg bg-[var(--color-bg)] text-sm text-[var(--color-text-primary)] border border-[var(--color-border)] focus:outline-none focus:border-[var(--color-accent)]"
						/>
					</div>

					<!-- Scrollable body -->
					<div class="flex-1 overflow-y-auto px-6 min-h-[200px]">
						{#if pickerError}
							<p class="text-xs text-coral py-4">{pickerError}</p>
						{/if}
						{#if pickerLevel === 'realm'}
							{#if pickerHierarchy.length === 0}
								<p class="text-xs text-[var(--color-text-tertiary)] py-4 text-center">No realms yet — your mindscape needs to cluster first.</p>
							{:else}
								<ul class="space-y-1 py-2">
									{#each pickerHierarchy as r (r.realm_id)}
										<li class="flex items-start gap-3 px-3 py-2 rounded-lg hover:bg-[var(--color-elevated)]">
											<div class="min-w-0 flex-1">
												<div class="text-sm text-[var(--color-text-primary)] font-medium truncate">{r.name || 'Unnamed realm'}</div>
												{#if r.essence}<p class="text-xs text-[var(--color-text-secondary)] mt-0.5 line-clamp-2">{r.essence}</p>{/if}
												<span class="text-[10px] font-mono text-[var(--color-text-tertiary)] mt-0.5 block">{r.territory_count} territories · {r.themes.length} themes</span>
											</div>
											<button onclick={() => addCluster({ level: 'realm', realm_id: r.realm_id }, `realm:${r.realm_id}`)} disabled={!!clusterAdding} class="shrink-0 px-3 py-1.5 text-xs font-medium rounded-lg bg-aurum text-[var(--color-bg)] disabled:opacity-50">{clusterAdding === `realm:${r.realm_id}` ? 'Adding…' : 'Add realm'}</button>
										</li>
									{/each}
								</ul>
							{/if}
						{:else if pickerLevel === 'theme'}
							{@const themes = pickerHierarchy.flatMap((r) => r.themes.map((t) => ({ ...t, realm_id: r.realm_id, realm_name: r.name })))}
							{#if themes.length === 0}
								<p class="text-xs text-[var(--color-text-tertiary)] py-4 text-center">No themes yet.</p>
							{:else}
								<ul class="space-y-1 py-2">
									{#each themes as t (t.realm_id + ':' + t.semantic_theme_id)}
										<li class="flex items-start gap-3 px-3 py-2 rounded-lg hover:bg-[var(--color-elevated)]">
											<div class="min-w-0 flex-1">
												<div class="text-sm text-[var(--color-text-primary)] font-medium truncate">{t.name || 'Unnamed theme'}</div>
												{#if t.essence}<p class="text-xs text-[var(--color-text-secondary)] mt-0.5 line-clamp-2">{t.essence}</p>{/if}
												<span class="text-[10px] font-mono text-[var(--color-text-tertiary)] mt-0.5 block">in {t.realm_name || 'realm'} · {t.territory_count} territories</span>
											</div>
											<button onclick={() => addCluster({ level: 'theme', realm_id: t.realm_id, semantic_theme_id: t.semantic_theme_id }, `theme:${t.realm_id}:${t.semantic_theme_id}`)} disabled={!!clusterAdding} class="shrink-0 px-3 py-1.5 text-xs font-medium rounded-lg bg-aurum text-[var(--color-bg)] disabled:opacity-50">{clusterAdding === `theme:${t.realm_id}:${t.semantic_theme_id}` ? 'Adding…' : 'Add theme'}</button>
										</li>
									{/each}
								</ul>
							{/if}
						{:else if pickerLoading}
							<div class="flex items-center justify-center py-10">
								<div class="w-6 h-6 border-2 border-[var(--color-border)] border-t-[var(--color-accent)] rounded-full animate-spin"></div>
							</div>
						{:else if pickerTerritories.length === 0}
							<p class="text-xs text-[var(--color-text-tertiary)] py-4 text-center">No territories to seed from yet.</p>
						{:else}
							{@const filtered = pickerSearch.trim()
								? pickerTerritories.filter((t) => (t.name + ' ' + (t.essence || '')).toLowerCase().includes(pickerSearch.toLowerCase()))
								: pickerTerritories}
							{#if filtered.length === 0}
								<p class="text-xs text-[var(--color-text-tertiary)] py-4 text-center">No territories match "{pickerSearch}".</p>
							{:else}
								<ul class="space-y-1 py-2">
									{#each filtered as t (t.id)}
										<li>
											<label class="flex items-start gap-3 px-3 py-2 rounded-lg hover:bg-[var(--color-elevated)] cursor-pointer transition-colors">
												<input
													type="checkbox"
													checked={pickerSelected.has(t.id)}
													onchange={() => togglePick(t.id)}
													class="mt-1 accent-aurum shrink-0"
												/>
												<div class="min-w-0 flex-1">
													<div class="flex items-center gap-2">
														<span class="text-sm text-[var(--color-text-primary)] font-medium truncate">{t.name}</span>
														{#if t.current_phase === 'sparse' || t.current_phase === 'active' || t.current_phase === 'anchor'}
															<span class="text-[10px] font-mono px-1.5 py-0.5 rounded bg-[var(--color-elevated)] text-[var(--color-text-tertiary)]">{t.current_phase}</span>
														{/if}
													</div>
													{#if t.essence}
														<p class="text-xs text-[var(--color-text-secondary)] mt-0.5 line-clamp-2">{t.essence}</p>
													{/if}
													<span class="text-[10px] font-mono text-[var(--color-text-tertiary)] mt-0.5 block">{t.message_count} msgs</span>
												</div>
											</label>
										</li>
									{/each}
								</ul>
							{/if}
						{/if}
					</div>

					<!-- Footer -->
					<div class="px-6 py-4 border-t border-[var(--color-border)] flex items-center justify-between gap-3 shrink-0">
						<span class="text-xs text-[var(--color-text-tertiary)]">
							{#if pickerLevel === 'territory'}{pickerSelected.size} selected{:else}Click Add to share a cluster{/if}
						</span>
						<div class="flex items-center gap-2">
							<button
								onclick={() => { pickerOpen = false; }}
								class="px-4 py-2 rounded-lg text-sm text-[var(--color-text-tertiary)] hover:text-[var(--color-text-primary)] transition-colors"
							>{pickerLevel === 'territory' ? 'Cancel' : 'Done'}</button>
							{#if pickerLevel === 'territory'}
								<button
									onclick={submitPicker}
									disabled={pickerSelected.size === 0 || pickerSeeding}
									class="px-4 py-2 rounded-lg text-sm font-medium bg-aurum text-[var(--color-bg)] hover:opacity-90 transition-opacity disabled:opacity-40"
								>
									{pickerSeeding ? 'Seeding…' : `Seed ${pickerSelected.size || ''}`.trim()}
								</button>
							{/if}
						</div>
					</div>
				</div>
			</div>
		{/if}

		<!-- Cover doc picker — choose a library doc to render as the
		     space's landing page. Same shape as the seed-doc picker
		     in ContextTab; could be lifted into a shared component
		     later, but inlined for now to keep the change focused. -->
		{#if coverPickerOpen}
			<div
				class="fixed inset-0 z-50 flex items-center justify-center p-4"
				style="background: rgba(10, 10, 12, 0.72); backdrop-filter: blur(20px) saturate(140%);"
				onclick={() => { coverPickerOpen = false; }}
				onkeydown={(e) => { if (e.key === 'Escape') coverPickerOpen = false; }}
				role="presentation"
			>
				<div
					class="w-full max-w-2xl max-h-[80vh] flex flex-col rounded-2xl border border-white/[0.06] p-6"
					style="background: rgba(26, 26, 31, 0.95);"
					onclick={(e) => e.stopPropagation()}
					onkeydown={(e) => e.stopPropagation()}
					role="dialog"
					aria-modal="true"
					tabindex={-1}
				>
					<h2 class="text-base font-medium text-[var(--color-text-emphasis)] mb-1">Choose a cover doc</h2>
					<p class="text-xs text-[var(--color-text-tertiary)] mb-4">
						The chosen HTML doc renders as this space's landing interface. Pick one your agent has authored, or any HTML doc from your library.
					</p>
					<input
						type="text"
						bind:value={coverLibrarySearch}
						placeholder="Search your library..."
						class="w-full px-3 py-2 rounded-lg bg-[var(--color-bg)] text-sm text-[var(--color-text-primary)] border border-[var(--color-border)] focus:outline-none focus:border-[var(--color-accent)] mb-3"
					/>
					<div class="flex-1 overflow-y-auto -mx-2 px-2 mb-4">
						{#if coverLibraryLoading}
							<div class="flex items-center justify-center py-12">
								<div class="w-5 h-5 border-2 border-[var(--color-border)] border-t-[var(--color-accent)] rounded-full animate-spin"></div>
							</div>
						{:else if filteredCoverDocs().length === 0}
							<p class="text-xs text-[var(--color-text-tertiary)] py-8 text-center">No matching documents.</p>
						{:else}
							<div class="space-y-1">
								{#each filteredCoverDocs() as doc (doc.path)}
									<button
										onclick={() => setCover(doc.path)}
										disabled={savingCover}
										class="w-full text-left flex items-start gap-3 p-2 rounded-lg hover:bg-[var(--color-elevated)] transition-colors disabled:opacity-50"
									>
										<svg class="w-4 h-4 text-[var(--color-text-tertiary)] flex-shrink-0 mt-0.5" fill="none" stroke="currentColor" viewBox="0 0 24 24" stroke-width="1.5">
											<path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z"/>
											<polyline points="14 2 14 8 20 8"/>
										</svg>
										<div class="flex-1 min-w-0">
											<p class="text-xs font-medium text-[var(--color-text-primary)] truncate">{doc.title || doc.path}</p>
											<p class="text-[10px] text-[var(--color-text-tertiary)] truncate font-mono">{doc.path}</p>
										</div>
									</button>
								{/each}
							</div>
						{/if}
					</div>
					<div class="flex items-center justify-end gap-2">
						<button
							onclick={() => { coverPickerOpen = false; }}
							class="px-3 py-1.5 rounded-lg text-xs text-[var(--color-text-tertiary)] hover:text-[var(--color-text-primary)] transition-colors"
						>Cancel</button>
					</div>
				</div>
			</div>
		{/if}
	</div>
{/if}


<style>
	@keyframes fadeSlide {
		from { opacity: 0; transform: translateX(-12px); }
		to { opacity: 1; transform: translateX(0); }
	}
</style>
