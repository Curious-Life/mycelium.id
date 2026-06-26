<script lang="ts">
	import { marked } from 'marked';
	import DOMPurify from 'isomorphic-dompurify';
	import { onMount } from 'svelte';
	import { goto } from '$app/navigation';
	import { api } from '$lib/api';
	import { generate, start as startGenerate } from '$lib/generate';
	import Sparkline from '$lib/components/mindscape/Sparkline.svelte';
	import {
		mindscapeState,
		mindscapePoints,
		visibleContacts,
		contactMessages,
		contactMessagesLoading,
		CLUSTER_COLORS,
		NOISE_COLOR,
		type TerritoryProfile,
		type SemanticThemeProfile,
	} from '$lib/stores/mindscape';

	const VISIBILITY_OPTIONS = [
		{ value: 'private', label: 'Private', icon: '🔒' },
		{ value: 'friends', label: 'Friends', icon: '👥' },
		{ value: 'public', label: 'Public', icon: '🌐' },
	] as const;

	let savingVisibility = $state(false);

	async function setVisibility(territoryId: number, visibility: string) {
		savingVisibility = true;
		try {
			const res = await api(`/portal/mindscape/territory/${territoryId}/visibility`, {
				method: 'PUT',
				body: JSON.stringify({ visibility }),
			});
			if (res.ok) {
				// Update local state
				const territories = $mindscapeState.territories;
				if (territories[territoryId]) {
					territories[territoryId].visibility = visibility as 'private' | 'friends' | 'public';
					mindscapeState.update(s => ({ ...s, territories: { ...territories } }));
				}
			}
		} catch {}
		savingVisibility = false;
	}

	marked.use({ breaks: true, gfm: true });

	function renderMarkdown(text: string | null): string {
		if (!text) return '';
		const preprocessed = text.replace(/^(\[\s?\]|\[x\])\s/gim, '- $1 ');
		return DOMPurify.sanitize(marked.parse(preprocessed) as string);
	}

	const msState = $derived($mindscapeState);
	const pointsStore = $derived($mindscapePoints);

	function getColor(id: number): string {
		if (id === -1) return NOISE_COLOR;
		return CLUSTER_COLORS[id % CLUSTER_COLORS.length];
	}

	function relativeDate(iso: string | null): string {
		if (!iso) return '';
		const d = Math.floor((Date.now() - new Date(iso).getTime()) / 86400000);
		if (d === 0) return 'today';
		if (d === 1) return 'yesterday';
		if (d < 30) return `${d}d ago`;
		if (d < 365) return `${Math.floor(d/30)}mo ago`;
		return `${Math.floor(d/365)}y ago`;
	}

	// ── Contacts linked to selected territory ──
	const territoryContacts = $derived.by(() => {
		const tid = msState.selectedTerritoryId;
		if (tid === null) return [];
		return $visibleContacts.filter(c =>
			c.territories.some(t => t.territory_id === tid)
		).sort((a, b) => {
			const tierOrder: Record<string, number> = { inner: 0, engaged: 1, acknowledged: 2, connected: 3, noise: 4 };
			return (tierOrder[a.tier] ?? 5) - (tierOrder[b.tier] ?? 5);
		});
	});

	// ── Realm list (sorted by point count) ──
	const sortedRealms = $derived.by(() => {
		return Object.entries(pointsStore.realms)
			.map(([id, r]) => ({ id: Number(id), ...r }))
			.filter(r => (r.pointCount || 0) >= 3)
			.sort((a, b) => (b.pointCount || 0) - (a.pointCount || 0));
	});
	// A realm is "described" only once an AI has chronicled it. Until then the
	// pipeline stores a literal placeholder name ("Realm 0") + empty essence — so
	// presence-of-name is NOT a signal. We detect the placeholder and (a) label such
	// realms as warm, greyed "Area N" and (b) surface a bottom CTA: "Spawn
	// intelligence" (connect an AI) when none is connected, or "Illuminate" (run the
	// describe pass) when one is.
	function isPlaceholderName(name: string | null | undefined): boolean {
		return !name || /^realm\s+\d+$/i.test(String(name).trim());
	}
	function isRealmDescribed(r: any): boolean {
		return !isPlaceholderName(r?.name) || (typeof r?.essence === 'string' && r.essence.trim().length > 0);
	}
	function realmLabel(r: any, idx: number): string {
		return isRealmDescribed(r) ? r.name : `Area ${idx + 1}`;
	}
	const anyUndescribed = $derived(sortedRealms.some((r: any) => !isRealmDescribed(r)));
	const currentRealmIdx = $derived(sortedRealms.findIndex((r: any) => r.id === msState.selectedRealmId));

	// Is an AI connected? (any active provider — status may still be erroring, but a
	// configured provider means "Spawn" is done, so we offer "Illuminate" instead.)
	let aiConnected = $state(false);
	onMount(async () => {
		try {
			const res = await api('/portal/providers');
			if (res.ok) { const d = await res.json(); aiConnected = (d.providers || []).some((p: any) => p.is_active); }
		} catch { /* leave false — fall back to Spawn intelligence */ }
	});

	const genActive = $derived(['embedding', 'starting', 'running'].includes($generate.phase));
	function connectIntelligence() { goto('/settings?tab=intelligence'); }
	function illuminateRealms() { void startGenerate(); }

	// Helper: normalize entity to display name (handles both string and {name/text} formats)
	function entityName(e: any): string {
		if (typeof e === 'string') return e;
		return e?.name || e?.text || String(e);
	}

	// ── Themes for selected realm (with live territory counts) ──
	const themesForRealm = $derived.by(() => {
		if (msState.selectedRealmId === null) return [];
		const realmId = msState.selectedRealmId;

		// Count actual territories per theme from territories data
		const themeTerrCounts: Record<number, number> = {};
		const themeMsgCounts: Record<number, number> = {};
		for (const [, t] of Object.entries(pointsStore.territories)) {
			if (t.realmId === realmId && t.semanticThemeId != null) {
				themeTerrCounts[t.semanticThemeId] = (themeTerrCounts[t.semanticThemeId] || 0) + 1;
				themeMsgCounts[t.semanticThemeId] = (themeMsgCounts[t.semanticThemeId] || 0) + (t.count || 0);
			}
		}

		return Object.entries(pointsStore.semanticThemes)
			.filter(([key]) => key.startsWith(`${realmId}-`))
			.map(([, profile]) => ({
				...profile,
				// Override with live counts from territories data
				territoryCount: themeTerrCounts[profile.semanticThemeId] || profile.territoryCount || 0,
				messageCount: themeMsgCounts[profile.semanticThemeId] || profile.messageCount || 0,
			}))
			// Hide ghost themes — rows in semantic_themes that no live (non-dissolved)
			// territory points at. Previously they rendered with their old stored
			// counts and clicking them produced an empty drilldown.
			.filter(t => (themeTerrCounts[t.semanticThemeId] || 0) > 0)
			.sort((a, b) => (b.messageCount || 0) - (a.messageCount || 0));
	});

	// ── Territories for selected theme (or all in realm if no themes) ──
	const territoriesForView = $derived.by(() => {
		if (msState.selectedRealmId === null) return [];
		const realmId = msState.selectedRealmId;
		const themeId = msState.selectedSemanticThemeId;

		return Object.entries(pointsStore.territories)
			.filter(([, t]) => {
				if (t.realmId !== realmId) return false;
				if (themeId !== null) return t.semanticThemeId === themeId;
				return true;
			})
			.map(([id, t]) => ({ id: Number(id), ...t }))
			.sort((a, b) => (b.count || 0) - (a.count || 0));
	});

	// ── Current detail objects ──
	const currentRealm = $derived.by(() => {
		if (msState.selectedRealmId === null) return null;
		return pointsStore.realms[msState.selectedRealmId] || null;
	});

	const currentTheme = $derived.by(() => {
		if (msState.selectedRealmId === null || msState.selectedSemanticThemeId === null) return null;
		const key = `${msState.selectedRealmId}-${msState.selectedSemanticThemeId}`;
		return pointsStore.semanticThemes[key] || null;
	});

	const currentTerritory = $derived.by(() => {
		if (msState.selectedTerritoryId === null) return null;
		return pointsStore.territories[msState.selectedTerritoryId] || null;
	});

	// Navigation state
	const navLevel = $derived.by(() => {
		if (msState.selectedTerritoryId !== null) return 'territory-detail';
		if (msState.selectedSemanticThemeId !== null) return 'territories';
		if (msState.selectedRealmId !== null) return 'themes';
		return 'realms';
	});

	// Hovered + selected activity bar
	let hoveredActivity = $state<{ month: string; count: number } | null>(null);
	let selectedActivity = $state<{ month: string; count: number } | null>(null);
	let selectedActivityChronicle = $state<{ theme: string; signature: string; narrative: string } | null>(null);
	let selectedActivityLoading = $state(false);

	async function selectActivityBar(item: { month: string; count: number }) {
		if (selectedActivity?.month === item.month) {
			selectedActivity = null;
			selectedActivityChronicle = null;
			return;
		}
		selectedActivity = item;
		selectedActivityChronicle = null;
		selectedActivityLoading = true;

		// Check if we have a chronicle for this month
		try {
			const res = await api(`/portal/mindscape/time-chronicles`);
			if (res.ok) {
				const data = await res.json();
				const match = (data.chronicles || []).find((c: any) => c.period_key?.startsWith(item.month));
				if (match) {
					selectedActivityChronicle = { theme: match.theme, signature: match.signature, narrative: match.narrative || match.theme };
				}
			}
		} catch {}
		selectedActivityLoading = false;
	}

	// Per-period Illuminate (POST /mindscape/explore → time_chronicles) is deferred Phase G/C:
	// the endpoint doesn't exist and nothing writes time_chronicles yet, so the trigger was
	// removed (see the "coming soon" note in the period detail). Whole-mindscape Illuminate
	// (the top CTA → /mycelium/generate) is the working path.

	const totalMessages = $derived(pointsStore.meta?.total || pointsStore.points.length);
	const totalRealms = $derived(Object.keys(pointsStore.realms).length);
</script>

<div class="mindscape-nav">
	<!-- Breadcrumb — hidden at the realms root (a lone "Mycelium" there just
	     duplicates the page). Shown only once drilled in, as a back-path. -->
	{#if navLevel !== 'realms'}
	<div class="breadcrumb">
		<button class="breadcrumb-link" onclick={() => mindscapeState.resetNavigation()}>
			Areas
		</button>
		{#if msState.selectedRealmId !== null}
			<span class="breadcrumb-sep">/</span>
			<button
				class="breadcrumb-link"
				class:active={navLevel === 'themes'}
				onclick={() => mindscapeState.drillIntoRealm(msState.selectedRealmId!)}
			>
				{currentRealm && isRealmDescribed(currentRealm) ? currentRealm.name : `Area ${currentRealmIdx + 1}`}
			</button>
		{/if}
		{#if msState.selectedSemanticThemeId !== null && currentTheme}
			<span class="breadcrumb-sep">/</span>
			<button
				class="breadcrumb-link"
				class:active={navLevel === 'territories'}
				onclick={() => mindscapeState.drillIntoTheme(msState.selectedRealmId!, msState.selectedSemanticThemeId!)}
			>
				{currentTheme.name}
			</button>
		{/if}
		{#if msState.selectedTerritoryId !== null && currentTerritory}
			<span class="breadcrumb-sep">/</span>
			<span class="breadcrumb-current">{currentTerritory.name || `T${msState.selectedTerritoryId}`}</span>
		{/if}
	</div>
	{/if}

	<div class="nav-content">
		{#if navLevel === 'realms'}
			<!-- ═══ REALM LIST ═══ -->
			<div class="nav-list">
				{#each sortedRealms as realm, i (realm.id)}
					{@const described = isRealmDescribed(realm)}
					<button
						class="nav-item realm-item"
						class:undescribed={!described}
						onclick={() => mindscapeState.drillIntoRealm(realm.id)}
						onmouseenter={() => mindscapeState.setHovered('realm', realm.id)}
						onmouseleave={() => mindscapeState.setHovered('realm', null)}
					>
						<span class="nav-dot" class:muted={!described} style={described ? `background: ${getColor(realm.id)}` : ''}></span>
						<div class="nav-item-content">
							<span class="nav-item-name">{realmLabel(realm, i)}</span>
							<span class="nav-item-stats">{realm.pointCount?.toLocaleString()} points · {realm.territoryCount} {realm.territoryCount === 1 ? 'territory' : 'territories'}</span>
							{#if described && realm.essence}
								<span class="nav-item-essence">{realm.essence}</span>
							{/if}
						</div>
					</button>
				{/each}
			</div>

			{#if anyUndescribed && sortedRealms.length > 0}
				<!-- Bottom CTA: describe the unnamed areas. Illuminate if an AI is
				     connected (runs the describe pass), else invite connecting one. -->
				{#if aiConnected}
					<button class="realm-cta illuminate" onclick={illuminateRealms} disabled={genActive}>
						<span class="cta-icon">
							<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="12" r="4"/><path d="M12 2v3M12 19v3M4.2 4.2l2.1 2.1M17.7 17.7l2.1 2.1M2 12h3M19 12h3M4.2 19.8l2.1-2.1M17.7 6.3l2.1-2.1"/></svg>
						</span>
						<span class="cta-body">
							<span class="cta-title">{genActive ? 'Illuminating…' : 'Illuminate'}</span>
							<span class="cta-sub">{genActive ? 'Naming & describing your areas.' : 'Let your AI name & describe these areas.'}</span>
						</span>
					</button>
				{:else}
					<button class="realm-cta spawn" onclick={connectIntelligence}>
						<span class="cta-icon">
							<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="12" r="3"/><path d="M12 2v3M12 19v3M4.2 4.2l2.1 2.1M17.7 17.7l2.1 2.1M2 12h3M19 12h3M4.2 19.8l2.1-2.1M17.7 6.3l2.1-2.1"/></svg>
						</span>
						<span class="cta-body">
							<span class="cta-title">Spawn intelligence</span>
							<span class="cta-sub">Connect an AI to name &amp; explore your areas.</span>
						</span>
						<span class="cta-arrow">→</span>
					</button>
				{/if}
			{/if}

			{#if totalMessages > 0}
				<div class="nav-footer">
					{totalMessages.toLocaleString()} messages · {totalRealms} {totalRealms === 1 ? 'area' : 'areas'}
				</div>
			{/if}

		{:else if navLevel === 'themes'}
			<!-- ═══ THEME LIST (within a realm) ═══ -->
			{#if currentRealm}
				<div class="section-header">
					<p class="section-stats">{currentRealm.pointCount?.toLocaleString()} points · {currentRealm.territoryCount} territories</p>
					{#if currentRealm.essence}
						<p class="section-essence">{currentRealm.essence}</p>
					{/if}
					{#if currentRealm.storyCurrentChapter}
						<p class="section-chapter">{currentRealm.storyCurrentChapter}</p>
					{/if}
					{#if currentRealm.activity && currentRealm.activity.length > 0}
						<div class="section-activity">
							<Sparkline data={currentRealm.activity} width={200} height={28} />
						</div>
					{/if}
					{#if currentRealm.topEntities && currentRealm.topEntities.length > 0}
						<div class="section-entities">
							{#each currentRealm.topEntities.slice(0, 8) as entity}
								<span class="entity-tag">{entityName(entity)}</span>
							{/each}
						</div>
					{/if}
					{#if currentRealm.signaturePatterns && currentRealm.signaturePatterns.length > 0}
						<div class="section-patterns">
							{#each currentRealm.signaturePatterns.slice(0, 4) as p}
								<span class="pattern-tag">{p}</span>
							{/each}
						</div>
					{/if}
				</div>
			{/if}

			{#if themesForRealm.length > 0}
				<div class="nav-list">
					{#each themesForRealm as theme (theme.semanticThemeId)}
						<button
							class="nav-item theme-item"
							onclick={() => mindscapeState.drillIntoTheme(msState.selectedRealmId!, theme.semanticThemeId)}
							onmouseenter={() => mindscapeState.setHovered('theme', theme.semanticThemeId)}
							onmouseleave={() => mindscapeState.setHovered('theme', null)}
						>
							<div class="nav-item-content">
								<span class="nav-item-name">{theme.name}</span>
								<span class="nav-item-stats">{theme.messageCount?.toLocaleString()} messages · {theme.territoryCount} territories</span>
								{#if theme.essence}
									<span class="nav-item-essence">{theme.essence}</span>
								{/if}
							</div>
						</button>
					{/each}
				</div>
			{:else}
				<!-- No themes — show territories directly -->
				<div class="nav-list">
					{#each territoriesForView as territory (territory.id)}
						<button
							class="nav-item territory-item"
							class:selected={msState.selectedTerritoryId === territory.id}
							onclick={() => mindscapeState.selectTerritory(msState.selectedTerritoryId === territory.id ? null : territory.id)}
							onmouseenter={() => mindscapeState.setHovered('territory', territory.id)}
							onmouseleave={() => mindscapeState.setHovered('territory', null)}
						>
							<span class="nav-dot" style="background: {getColor(territory.id)}"></span>
							<div class="nav-item-content">
								<span class="nav-item-name">{territory.name || `Territory ${territory.id}`}</span>
								<span class="nav-item-stats">{territory.count?.toLocaleString()} messages</span>
							</div>
						</button>
					{/each}
				</div>
			{/if}

		{:else if navLevel === 'territories'}
			<!-- ═══ TERRITORY LIST (within a theme) ═══ -->
			{#if currentTheme}
				<div class="section-header">
					<p class="section-stats">{territoriesForView.length} territories · {territoriesForView.reduce((s, t) => s + (t.count || 0), 0).toLocaleString()} messages</p>
					{#if currentTheme.essence}
						<p class="section-essence">{currentTheme.essence}</p>
					{/if}
					{#if currentTheme.storyArc}
						<p class="section-chapter">{currentTheme.storyArc}</p>
					{/if}
					{#if currentTheme.storyCurrentChapter}
						<p class="section-chapter"><strong>Now:</strong> {currentTheme.storyCurrentChapter}</p>
					{/if}
				</div>

				{#if currentTheme.activity && currentTheme.activity.length > 0}
					{@const maxCount = Math.max(...currentTheme.activity.map(a => a.count))}
					<div class="activity-graph">
						<h4>Activity</h4>
						<div class="activity-bars-container">
							{#if hoveredActivity}
								<div class="activity-tooltip">{hoveredActivity.month}: {hoveredActivity.count}</div>
							{/if}
							<!-- svelte-ignore a11y_no_static_element_interactions -->
							<div class="activity-bars" onmouseleave={() => hoveredActivity = null}>
								{#each currentTheme.activity.slice(-24) as item}
									<!-- svelte-ignore a11y_no_static_element_interactions -->
									<div
										class="activity-bar"
										style="height: {(item.count / maxCount) * 100}%"
										onmouseenter={() => hoveredActivity = item}
									></div>
								{/each}
							</div>
						</div>
						<div class="activity-labels">
							<span>{currentTheme.activity[Math.max(0, currentTheme.activity.length - 24)]?.month}</span>
							<span>{currentTheme.activity[currentTheme.activity.length - 1]?.month}</span>
						</div>
					</div>
				{/if}

				{#if currentTheme.topEntities && currentTheme.topEntities.length > 0}
					<div class="section-entities">
						{#each currentTheme.topEntities.slice(0, 10) as entity}
							<span class="entity-tag">{entityName(entity)}</span>
						{/each}
					</div>
				{/if}

				{#if currentTheme.signaturePatterns && currentTheme.signaturePatterns.length > 0}
					<div class="section-patterns">
						{#each currentTheme.signaturePatterns.slice(0, 4) as pattern}
							<p class="pattern-item">{pattern}</p>
						{/each}
					</div>
				{/if}
			{/if}

			<div class="nav-list">
				{#each territoriesForView as territory (territory.id)}
					<button
						class="nav-item territory-item"
						class:selected={msState.selectedTerritoryId === territory.id}
						onclick={() => mindscapeState.selectTerritory(msState.selectedTerritoryId === territory.id ? null : territory.id)}
						onmouseenter={() => mindscapeState.setHovered('territory', territory.id)}
						onmouseleave={() => mindscapeState.setHovered('territory', null)}
					>
						<span class="nav-dot" style="background: {getColor(territory.id)}"></span>
						<div class="nav-item-content">
							<span class="nav-item-name">{territory.name || `Territory ${territory.id}`}</span>
							<span class="nav-item-stats">{territory.count?.toLocaleString()} messages{#if territory.exploredPercent > 0} · {territory.exploredPercent.toFixed(0)}% explored{/if}</span>
						</div>
					</button>
				{/each}
			</div>

		{:else if navLevel === 'territory-detail' && currentTerritory}
			<!-- ═══ TERRITORY DETAIL ═══ -->
			<div class="detail-panel">
				<div class="detail-header">
					<div class="detail-color-bar" style="background-color: {getColor(msState.selectedTerritoryId!)}"></div>
					<div class="detail-title-row">
						<h2 class="detail-title">{currentTerritory.name}</h2>
						<select
							class="visibility-select"
							value={currentTerritory.visibility || 'private'}
							onchange={(e) => setVisibility(msState.selectedTerritoryId!, (e.target as HTMLSelectElement).value)}
							disabled={savingVisibility}
						>
							{#each VISIBILITY_OPTIONS as opt}
								<option value={opt.value}>{opt.icon} {opt.label}</option>
							{/each}
						</select>
					</div>
					<div class="badge-row">
						{#if currentTerritory.archetypeType}
							<span class="archetype-badge">{currentTerritory.archetypeType}</span>
						{/if}
						{#if currentTerritory.currentPhase === 'sparse' || currentTerritory.currentPhase === 'active' || currentTerritory.currentPhase === 'anchor'}
							<span class="phase-badge phase-{currentTerritory.currentPhase}">{currentTerritory.currentPhase} · {(currentTerritory.currentVitality || 0).toFixed(2)}</span>
						{/if}
						{#if currentTerritory.isAnchored}
							<span class="anchored-badge" title="Protected from re-clustering dissolution">⚓ anchored</span>
						{/if}
						{#if currentTerritory.evolvedFromCount > 0}
							<span class="evolved-badge" title="This territory inherited messages from {currentTerritory.evolvedFromCount} dissolved territory/territories">↳ evolved from {currentTerritory.evolvedFromCount}</span>
						{/if}
					</div>
					<p class="detail-stats">
						{currentTerritory.count?.toLocaleString() || 0} messages
						{#if currentTerritory.exploredPercent > 0}
							· {currentTerritory.exploredPercent.toFixed(0)}% explored
						{/if}
						{#if currentTerritory.daysActive}
							· {currentTerritory.daysActive}d span
						{/if}
					</p>
					{#if currentTerritory.temporalSaliency != null}
						<div class="saliency-row">
							<div class="saliency-bar-bg">
								<div class="saliency-bar-fill" style="width:{Math.round(currentTerritory.temporalSaliency * 100)}%;opacity:{0.4 + currentTerritory.temporalSaliency * 0.6}"></div>
							</div>
							<span class="saliency-label">
								{#if currentTerritory.temporalSaliency > 0.7}active now
								{:else if currentTerritory.temporalSaliency > 0.3}recent
								{:else if currentTerritory.temporalSaliency > 0.05}fading
								{:else}dormant{/if}
							</span>
							{#if currentTerritory.lastActive}
								<span class="saliency-date">{currentTerritory.lastActive}</span>
							{/if}
						</div>
					{/if}
				</div>
				{#if currentTerritory.essence}
					<div class="detail-essence">{currentTerritory.essence}</div>
				{/if}

				{#if currentTerritory.chronicle}
					<div class="detail-block">
						<h4>Chronicle</h4>
						<div class="chronicle-text">{currentTerritory.chronicle}</div>
					</div>
				{:else if !currentTerritory.essence}
					<!-- Undescribed territory (narration runs async after clustering): show a
					     clear pending state instead of a blank, broken-looking panel. -->
					<div class="detail-block">
						<div class="chronicle-text" style="opacity:0.6;font-style:italic">Still describing this territory — its essence and chronicle are being written. This runs automatically after generation; check back in a moment.</div>
					</div>
				{/if}

				{#if currentTerritory.activity && currentTerritory.activity.length > 0}
					{@const maxCount = Math.max(...currentTerritory.activity.map(a => a.count))}
					<div class="activity-graph">
						<h4>Activity</h4>
						<div class="activity-bars-container">
							{#if hoveredActivity && !selectedActivity}
								<div class="activity-tooltip">{hoveredActivity.month}: {hoveredActivity.count}</div>
							{/if}
							<!-- svelte-ignore a11y_no_static_element_interactions -->
							<div class="activity-bars" onmouseleave={() => { if (!selectedActivity) hoveredActivity = null; }}>
								{#each currentTerritory.activity.slice(-24) as item}
									<button
										class="activity-bar"
										class:selected={selectedActivity?.month === item.month}
										style="height: {(item.count / maxCount) * 100}%"
										aria-label="{item.month}: {item.count}"
										onmouseenter={() => hoveredActivity = item}
										onclick={() => selectActivityBar(item)}
									></button>
								{/each}
							</div>
						</div>
						<div class="activity-labels">
							<span>{currentTerritory.activity[Math.max(0, currentTerritory.activity.length - 24)]?.month}</span>
							<span>{currentTerritory.activity[currentTerritory.activity.length - 1]?.month}</span>
						</div>

						<!-- Period detail: chronicle or illuminate -->
						{#if selectedActivity}
							<div class="period-detail">
								{#if selectedActivityLoading}
									<div class="period-loading">
										<div class="period-spinner"></div>
									</div>
								{:else if selectedActivityChronicle}
									<div class="period-chronicle">
										<span class="period-theme">{selectedActivityChronicle.theme}</span>
										{#if selectedActivityChronicle.signature}
											<span class="period-sig" class:sig-steady={selectedActivityChronicle.signature === 'steady'} class:sig-exploring={selectedActivityChronicle.signature === 'exploring'} class:sig-consolidating={selectedActivityChronicle.signature === 'consolidating'} class:sig-fragmenting={selectedActivityChronicle.signature === 'fragmenting'}>{selectedActivityChronicle.signature}</span>
										{/if}
									</div>
								{:else}
									<div class="period-dark">
										<span class="period-dark-label">{selectedActivity.month} &middot; {selectedActivity.count} points &middot; not yet explored</span>
										<!-- Period-level Illuminate (time-chronicles) is an unbuilt surface: there is no
										     /mindscape/explore job and nothing writes time_chronicles yet (deferred Phase G/C).
										     The old button POSTed a 404 and polled forever — disabled here so it can't present a
										     broken action. Whole-mindscape Illuminate (the top CTA) is the working path. -->
										<span class="period-illuminate-btn" style="opacity:0.55;cursor:default;" title="Per-period exploration isn't available yet">coming soon</span>
									</div>
								{/if}
							</div>
						{/if}
					</div>
				{/if}

				<div class="detail-body">
					{#if currentTerritory.signaturePatterns && currentTerritory.signaturePatterns.length > 0}
						<div class="detail-block">
							<h4>Patterns</h4>
							<ul class="detail-list">
								{#each currentTerritory.signaturePatterns as pattern}
									<li>{pattern}</li>
								{/each}
							</ul>
						</div>
					{/if}
					{#if currentTerritory.storyBirth}
						<div class="detail-block">
							<h4>Origin</h4>
							<div class="markdown-content">{@html renderMarkdown(currentTerritory.storyBirth)}</div>
						</div>
					{/if}
					{#if currentTerritory.storyArc}
						<div class="detail-block">
							<h4>Story Arc</h4>
							<div class="markdown-content">{@html renderMarkdown(currentTerritory.storyArc)}</div>
						</div>
					{/if}
					{#if currentTerritory.storyCurrentChapter}
						<div class="detail-block">
							<h4>Current Chapter</h4>
							<div class="markdown-content">{@html renderMarkdown(currentTerritory.storyCurrentChapter)}</div>
						</div>
					{/if}
					{#if currentTerritory.topEntities && currentTerritory.topEntities.length > 0}
						<div class="detail-block">
							<h4>Key Entities</h4>
							<div class="entity-tags">
								{#each currentTerritory.topEntities.slice(0, 12) as entity}
									<span class="entity-tag">{entityName(entity)}</span>
								{/each}
							</div>
						</div>
					{/if}
					{#if currentTerritory.uncertaintyEdges}
						<div class="detail-block">
							<h4>Connected Regions</h4>
							<p class="detail-text-secondary">{currentTerritory.uncertaintyEdges}</p>
						</div>
					{/if}
					{#if currentTerritory.agentWouldConsult && currentTerritory.agentWouldConsult.length > 0}
						<div class="detail-block">
							<h4>Cross-References</h4>
							<div class="cross-ref-tags">
								{#each currentTerritory.agentWouldConsult as ref}
									<span class="cross-ref-tag">{ref.territory_name || ref.for || JSON.stringify(ref)}</span>
								{/each}
							</div>
						</div>
					{/if}
					{#if territoryContacts.length > 0}
						<div class="detail-block">
							<h4>Linked Contacts</h4>
							<div class="contacts-list">
								{#each territoryContacts as contact}
									{@const isSelected = msState.selectedContactId === contact.id}
									<button
										class="contact-card"
										onmouseenter={() => mindscapeState.hoverContact(contact.id)}
										onmouseleave={() => mindscapeState.hoverContact(null)}
										onclick={() => mindscapeState.selectContact(isSelected ? null : contact.id)}
										class:selected={isSelected}
									>
										<div class="contact-name-row">
											<span class="contact-name">{contact.name}</span>
											{#if contact.source === 'linkedin'}
												<svg class="contact-source-icon" viewBox="0 0 24 24" fill="#0A66C2"><path d="M20.447 20.452h-3.554v-5.569c0-1.328-.027-3.037-1.852-3.037-1.853 0-2.136 1.445-2.136 2.939v5.667H9.351V9h3.414v1.561h.046c.477-.9 1.637-1.85 3.37-1.85 3.601 0 4.267 2.37 4.267 5.455v6.286zM5.337 7.433a2.062 2.062 0 01-2.063-2.065 2.064 2.064 0 112.063 2.065zm1.782 13.019H3.555V9h3.564v11.452zM22.225 0H1.771C.792 0 0 .774 0 1.729v20.542C0 23.227.792 24 1.771 24h20.451C23.2 24 24 23.227 24 22.271V1.729C24 .774 23.2 0 22.222 0h.003z"/></svg>
											{/if}
										</div>
										{#if contact.description?.essence}
											<p class="contact-essence">{contact.description.essence}</p>
										{/if}
										<div class="contact-meta">
											{#if contact.position}<span>{contact.position}</span>{/if}
											{#if contact.company}<span>{contact.company}</span>{/if}
											<span class="contact-tier">{contact.tier}</span>
										</div>
										<div class="contact-meta">
											{#if contact.interaction_count}
												<span>{contact.interaction_count} msg{#if contact.outbound_count} · {contact.outbound_count} sent{/if}</span>
											{/if}
											{#if contact.last_interaction_at}
												<span>last {relativeDate(contact.last_interaction_at)}</span>
											{/if}
											{#if contact.connected_at}
												<span>since {new Date(contact.connected_at).getFullYear()}</span>
											{/if}
										</div>
										{#if isSelected}
											<div class="contact-detail">
												{#if contact.email}
													<!-- svelte-ignore a11y_no_static_element_interactions -->
													<a href="mailto:{contact.email}" class="contact-email" onclick={(e) => e.stopPropagation()}>{contact.email}</a>
												{/if}
												{#if contact.linkedin_url}
													<!-- svelte-ignore a11y_no_static_element_interactions -->
													<a href={contact.linkedin_url} target="_blank" rel="noopener" class="contact-linkedin" onclick={(e) => e.stopPropagation()}>LinkedIn Profile</a>
												{/if}
												{#if contact.description}
													<div class="contact-chronicle">
														{#if contact.description.relationship_arc}
															<p class="chronicle-arc">{contact.description.relationship_arc}</p>
														{/if}
														{#if contact.description.interaction_style}
															<p class="chronicle-style">{contact.description.interaction_style}</p>
														{/if}
														{#if contact.description.notable_moments?.length}
															<div class="chronicle-moments">
																{#each contact.description.notable_moments as moment}
																	<p class="chronicle-moment">{moment}</p>
																{/each}
															</div>
														{/if}
														{#if contact.description.signature_topics?.length}
															<div class="chronicle-topics">
																{#each contact.description.signature_topics as topic}
																	<span class="chronicle-topic">{topic}</span>
																{/each}
															</div>
														{/if}
													</div>
												{/if}
												<div class="contact-territories">
													{#each contact.territories as t}
														<span class="territory-link" style="opacity: {0.5 + t.strength * 0.5}">
															{t.territory_name || `Territory ${t.territory_id}`}
															<span class="strength">({(t.strength * 100).toFixed(0)}%)</span>
														</span>
													{/each}
												</div>
												<!-- Messages -->
												<div class="contact-messages">
													{#if $contactMessagesLoading}
														<div class="contact-messages-loading">
															<div class="msg-spinner"></div>
															Loading...
														</div>
													{:else if $contactMessages.length === 0}
														<span class="contact-stats">No messages found</span>
													{:else}
														{#each $contactMessages as msg}
															<div class="contact-msg">
																<div class="contact-msg-header">
																	<span class="contact-msg-role" class:you={msg.role === 'user'}>
																		{msg.role === 'user' ? 'You' : contact.name.split(' ')[0]}
																	</span>
																	<span class="contact-msg-date">{new Date(msg.created_at).toLocaleDateString('en-GB', { day: 'numeric', month: 'short', year: '2-digit' })}</span>
																</div>
																<p class="contact-msg-text">{msg.content}</p>
															</div>
														{/each}
													{/if}
												</div>
											</div>
										{/if}
									</button>
								{/each}
							</div>
						</div>
					{/if}
					{#if currentTerritory.uncertaintyOpenQuestions && currentTerritory.uncertaintyOpenQuestions.length > 0}
						<div class="detail-block">
							<h4>Open Questions</h4>
							<ul class="detail-list">
								{#each currentTerritory.uncertaintyOpenQuestions as question}
									<li>{question}</li>
								{/each}
							</ul>
						</div>
					{/if}
					{#if currentTerritory.agentExpertise}
						<div class="detail-block">
							<h4>Expertise</h4>
							<div class="markdown-content">{@html renderMarkdown(currentTerritory.agentExpertise)}</div>
						</div>
					{/if}
				</div>
			</div>
		{/if}
	</div>
</div>

<style>
	.mindscape-nav {
		height: 100%;
		display: flex;
		flex-direction: column;
		background: var(--color-elevated);
		overflow: hidden;
	}

	/* Breadcrumb */
	.breadcrumb {
		display: flex;
		align-items: center;
		gap: 4px;
		padding: 10px 14px;
		border-bottom: 1px solid var(--color-border);
		flex-shrink: 0;
		flex-wrap: wrap;
	}
	.breadcrumb-link {
		color: var(--color-text-tertiary);
		background: none;
		border: none;
		cursor: pointer;
		font-size: 0.75rem;
		font-family: inherit;
		padding: 2px 4px;
		border-radius: 3px;
		transition: all 0.15s;
	}
	.breadcrumb-link:hover {
		color: var(--color-accent);
		background: rgba(229, 184, 76, 0.08);
	}
	.breadcrumb-link.active {
		color: var(--color-text-primary);
		font-weight: 600;
	}
	.breadcrumb-sep {
		color: var(--color-text-tertiary);
		font-size: 0.7rem;
		opacity: 0.5;
	}
	.breadcrumb-current {
		font-size: 0.75rem;
		color: var(--color-text-primary);
		font-weight: 600;
	}

	/* Scrollable content area */
	.nav-content {
		flex: 1;
		overflow-y: auto;
	}

	/* Section header (realm/theme summary) */
	.section-header {
		padding: 10px 14px;
		border-bottom: 1px solid var(--color-border);
	}
	.section-stats {
		font-size: 0.75rem;
		color: var(--color-text-tertiary);
		margin: 0 0 4px;
	}
	.section-essence {
		font-size: 0.8rem;
		color: var(--color-text-secondary);
		line-height: 1.5;
		margin: 0 0 4px;
	}
	.section-chapter {
		font-size: 0.75rem;
		color: var(--color-text-tertiary);
		font-style: italic;
		margin: 0;
	}
	.section-activity {
		margin-top: 8px;
	}
	.section-entities,
	.section-patterns {
		display: flex;
		flex-wrap: wrap;
		gap: 3px;
		margin-top: 6px;
	}
	.detail-text-secondary {
		font-size: 0.7rem;
		color: var(--color-text-secondary);
		line-height: 1.5;
	}
	.cross-ref-tags {
		display: flex;
		flex-wrap: wrap;
		gap: 3px;
	}
	.cross-ref-tag {
		font-size: 0.6rem;
		padding: 2px 6px;
		border-radius: 3px;
		background: rgba(229, 184, 76, 0.12);
		color: var(--color-accent-aurum);
	}
	.pattern-tag {
		font-size: 0.6rem;
		padding: 2px 6px;
		border-radius: 3px;
		background: rgba(167, 139, 250, 0.12);
		color: var(--color-accent-amethyst);
	}

	/* Navigation list items */
	.nav-list {
		display: flex;
		flex-direction: column;
		gap: 6px;
		padding: 8px 10px;
	}
	.nav-item {
		display: flex;
		align-items: flex-start;
		gap: 9px;
		padding: 10px 12px;
		border: 1px solid rgba(255, 255, 255, 0.06);
		border-radius: 11px;
		background: rgba(255, 255, 255, 0.025);
		text-align: left;
		cursor: pointer;
		font-family: inherit;
		font-size: inherit;
		color: inherit;
		transition: transform 0.16s ease, border-color 0.16s ease, background 0.16s ease;
	}
	.nav-item:hover {
		transform: translateY(-1px);
		background: rgba(229, 184, 76, 0.05);
		border-color: rgba(229, 184, 76, 0.28);
	}
	.nav-item.selected {
		background: rgba(229, 184, 76, 0.09);
		border-color: rgba(229, 184, 76, 0.4);
	}

	/* Bottom CTA — describe the unnamed areas. Illuminate (AI connected) is a calm
	   glass card; Spawn intelligence keeps the warm gold invite. */
	.realm-cta {
		display: flex;
		align-items: center;
		gap: 0.65rem;
		width: calc(100% - 20px);
		margin: 4px 10px 10px;
		padding: 0.7rem 0.8rem;
		border-radius: 12px;
		cursor: pointer;
		text-align: left;
		font-family: inherit;
		color: var(--color-text-primary);
		border: 1px solid rgba(255, 255, 255, 0.08);
		background: rgba(255, 255, 255, 0.03);
		transition: transform 0.16s ease, border-color 0.16s ease, background 0.16s ease;
	}
	.realm-cta:hover:not(:disabled) { transform: translateY(-1px); }
	.realm-cta:disabled { cursor: default; opacity: 0.7; }
	.realm-cta.illuminate:hover:not(:disabled) {
		background: rgba(229, 184, 76, 0.05);
		border-color: rgba(229, 184, 76, 0.3);
	}
	.realm-cta.spawn {
		background: rgba(229, 184, 76, 0.06);
		border-color: rgba(229, 184, 76, 0.26);
	}
	.realm-cta.spawn:hover {
		background: rgba(229, 184, 76, 0.1);
		border-color: rgba(229, 184, 76, 0.45);
	}
	.cta-icon { display: flex; flex-shrink: 0; color: var(--color-accent-aurum, #e5b84c); }
	.cta-icon svg { width: 19px; height: 19px; }
	.cta-body { display: flex; flex-direction: column; gap: 2px; min-width: 0; }
	.cta-title { font-size: 0.82rem; font-weight: 600; }
	.cta-sub { font-size: 0.68rem; color: var(--color-text-secondary); line-height: 1.4; }
	.cta-arrow { margin-left: auto; color: var(--color-accent-aurum, #e5b84c); font-size: 0.9rem; flex-shrink: 0; }
	.nav-dot {
		width: 7px;
		height: 7px;
		border-radius: 50%;
		flex-shrink: 0;
		margin-top: 5px;
		opacity: 0.7;
	}
	.nav-dot.muted {
		background: var(--color-text-tertiary);
		opacity: 0.3;
	}
	/* Undescribed realms — greyed until an AI chronicles them. */
	.realm-item.undescribed { opacity: 0.5; }
	.realm-item.undescribed:hover { opacity: 0.78; }
	.realm-item.undescribed .nav-item-name {
		color: var(--color-text-secondary);
		font-weight: 500;
	}
	.nav-item-content {
		flex: 1;
		min-width: 0;
		display: flex;
		flex-direction: column;
		gap: 2px;
	}
	.nav-item-name {
		font-size: 0.82rem;
		font-weight: 600;
		color: var(--color-text-primary);
		line-height: 1.3;
	}
	.nav-item-stats {
		font-size: 0.7rem;
		color: var(--color-text-tertiary);
	}
	.nav-item-essence {
		font-size: 0.75rem;
		color: var(--color-text-secondary);
		line-height: 1.4;
		display: -webkit-box;
		-webkit-line-clamp: 2;
		line-clamp: 2;
		-webkit-box-orient: vertical;
		overflow: hidden;
	}

	/* Footer */
	.nav-footer {
		padding: 8px 14px;
		font-size: 0.7rem;
		color: var(--color-text-tertiary);
		border-top: 1px solid var(--color-border);
		text-align: center;
		flex-shrink: 0;
	}

	/* Section-level extras (theme detail) */
	.section-entities {
		display: flex;
		flex-wrap: wrap;
		gap: 4px;
		padding: 8px 14px;
		border-bottom: 1px solid var(--color-border);
	}
	.section-patterns {
		padding: 8px 14px;
		border-bottom: 1px solid var(--color-border);
	}
	.pattern-item {
		font-size: 0.75rem;
		color: var(--color-text-secondary);
		line-height: 1.5;
		margin: 0 0 4px;
		padding-left: 10px;
		border-left: 2px solid rgba(229, 184, 76, 0.2);
	}

	/* ═══ Detail Panel (territory detail) ═══ */
	.detail-panel {
		display: flex;
		flex-direction: column;
	}
	.detail-header {
		padding: 14px;
		border-bottom: 1px solid var(--color-border);
	}
	.detail-color-bar {
		width: 40px;
		height: 3px;
		border-radius: 2px;
		margin-bottom: 10px;
	}
	.detail-title-row {
		display: flex;
		align-items: flex-start;
		justify-content: space-between;
		gap: 0.5rem;
	}
	.detail-title {
		font-size: 1rem;
		font-weight: 600;
		color: var(--color-text-primary);
		margin: 0 0 6px;
		flex: 1;
	}
	.visibility-select {
		padding: 2px 6px;
		font-size: 0.65rem;
		background: var(--color-bg);
		border: 1px solid var(--color-border);
		border-radius: 4px;
		color: var(--color-text-secondary);
		cursor: pointer;
		flex-shrink: 0;
		margin-top: 2px;
	}
	.visibility-select:focus {
		border-color: var(--color-accent-aurum);
		outline: none;
	}
	.badge-row {
		display: flex;
		flex-wrap: wrap;
		gap: 6px;
		margin-bottom: 6px;
	}
	.phase-badge, .anchored-badge, .evolved-badge {
		display: inline-block;
		padding: 2px 8px;
		font-size: 0.6rem;
		font-weight: 600;
		text-transform: uppercase;
		letter-spacing: 0.05em;
		border-radius: 1rem;
	}
	.phase-sparse { color: #94a3b8; background: rgba(148, 163, 184, 0.12); }
	.phase-active { color: #4ade80; background: rgba(74, 222, 128, 0.12); }
	.phase-anchor { color: #E5B84C; background: rgba(229, 184, 76, 0.15); }
	.anchored-badge { color: var(--color-text-secondary); background: rgba(255,255,255,0.05); border: 1px solid rgba(255,255,255,0.1); }
	.evolved-badge { color: #c084fc; background: rgba(192, 132, 252, 0.1); cursor: help; }

	.archetype-badge {
		display: inline-block;
		padding: 2px 8px;
		font-size: 0.6rem;
		font-weight: 600;
		text-transform: uppercase;
		letter-spacing: 0.05em;
		color: var(--color-accent);
		background: rgba(91, 159, 232, 0.1);
		border-radius: 1rem;
		margin-bottom: 6px;
	}
	.saliency-row {
		display: flex;
		align-items: center;
		gap: 0.5rem;
		margin: 0.4rem 0 0.6rem;
	}
	.saliency-bar-bg {
		flex: 1;
		height: 3px;
		background: var(--color-border);
		border-radius: 2px;
		overflow: hidden;
		max-width: 120px;
	}
	.saliency-bar-fill {
		height: 100%;
		background: var(--color-accent);
		border-radius: 2px;
		transition: width 0.3s;
	}
	.saliency-label {
		font-size: 0.6rem;
		font-weight: 500;
		text-transform: uppercase;
		letter-spacing: 0.04em;
		color: var(--color-text-tertiary);
	}
	.saliency-date {
		font-size: 0.55rem;
		font-family: var(--font-mono);
		color: var(--color-text-tertiary);
		margin-left: auto;
	}
	.detail-stats {
		font-size: 0.75rem;
		color: var(--color-text-tertiary);
		margin: 4px 0 0;
	}
	.detail-essence {
		font-size: 0.85rem;
		color: var(--color-text-secondary);
		line-height: 1.6;
		padding: 10px 14px;
		border-bottom: 1px solid var(--color-border);
	}
	.detail-body {
		padding: 10px 14px;
	}
	.detail-block {
		margin-bottom: 14px;
	}
	.detail-block:last-child {
		margin-bottom: 0;
	}
	.detail-block h4 {
		font-size: 0.65rem;
		font-weight: 600;
		text-transform: uppercase;
		letter-spacing: 0.05em;
		color: var(--color-text-tertiary);
		margin: 0 0 6px;
	}
	.chronicle-text {
		font-size: 0.82rem;
		color: var(--color-text-secondary);
		line-height: 1.65;
		white-space: pre-wrap;
	}

	/* Activity graph */
	.activity-graph {
		padding: 10px 14px;
		border-bottom: 1px solid var(--color-border);
	}
	.activity-graph h4 {
		font-size: 0.65rem;
		font-weight: 600;
		text-transform: uppercase;
		letter-spacing: 0.05em;
		color: var(--color-text-tertiary);
		margin: 0 0 6px;
	}
	.activity-bars-container {
		position: relative;
	}
	.activity-tooltip {
		position: absolute;
		top: -1.5rem;
		left: 50%;
		transform: translateX(-50%);
		padding: 2px 6px;
		font-size: 0.65rem;
		font-weight: 500;
		color: var(--color-text-primary);
		background: var(--color-elevated);
		border: 1px solid var(--color-border);
		border-radius: 4px;
		white-space: nowrap;
		pointer-events: none;
		z-index: 10;
	}
	.activity-bars {
		display: flex;
		align-items: flex-end;
		gap: 2px;
		height: 36px;
		background: var(--color-bg);
		border-radius: 4px;
		padding: 3px;
	}
	.activity-bar {
		flex: 1;
		min-height: 2px;
		background: var(--color-accent);
		border: none;
		padding: 0;
		border-radius: 1px;
		transition: opacity 0.2s, background 0.2s;
		cursor: pointer;
	}
	.activity-bar:hover {
		opacity: 0.7;
	}
	.activity-bar.selected {
		background: var(--color-accent-aurum);
		opacity: 1;
		box-shadow: 0 0 4px rgba(229, 184, 76, 0.5);
	}
	/* Period detail below activity chart */
	.period-detail {
		margin-top: 8px;
		padding: 8px 10px;
		border-radius: 6px;
		background: var(--color-bg);
		border: 1px solid var(--color-border);
		animation: period-fade 0.2s ease-out;
	}
	@keyframes period-fade {
		from { opacity: 0; transform: translateY(-4px); }
		to { opacity: 1; transform: translateY(0); }
	}
	.period-chronicle {
		display: flex;
		flex-direction: column;
		gap: 3px;
	}
	.period-theme {
		font-size: 0.7rem;
		color: var(--color-text-primary);
		font-weight: 500;
		line-height: 1.4;
	}
	.period-sig {
		font-size: 0.55rem;
		font-weight: 600;
		text-transform: uppercase;
		letter-spacing: 0.08em;
	}
	.period-dark {
		display: flex;
		align-items: center;
		justify-content: space-between;
		gap: 8px;
	}
	.period-dark-label {
		font-size: 0.65rem;
		color: var(--color-text-tertiary);
	}
	.period-illuminate-btn {
		display: inline-flex;
		align-items: center;
		gap: 4px;
		padding: 4px 10px;
		border: 1px solid rgba(229, 184, 76, 0.35);
		background: rgba(229, 184, 76, 0.06);
		color: var(--color-accent-aurum);
		border-radius: 12px;
		font-size: 0.55rem;
		font-weight: 600;
		text-transform: uppercase;
		letter-spacing: 0.08em;
		cursor: pointer;
		transition: all 0.2s;
		white-space: nowrap;
		flex-shrink: 0;
	}
	.period-illuminate-btn:hover:not(:disabled) {
		background: rgba(229, 184, 76, 0.15);
		border-color: var(--color-accent-aurum);
	}
	.period-illuminate-btn:disabled {
		opacity: 0.5;
		cursor: not-allowed;
	}
	.period-loading {
		display: flex;
		justify-content: center;
		padding: 4px;
	}
	.period-spinner {
		width: 14px;
		height: 14px;
		border: 2px solid var(--color-border);
		border-top-color: var(--color-accent-aurum);
		border-radius: 50%;
		animation: spin 0.8s linear infinite;
	}
	.activity-labels {
		display: flex;
		justify-content: space-between;
		font-size: 0.6rem;
		color: var(--color-text-tertiary);
		margin-top: 3px;
	}

	/* Entity tags */
	.entity-tags {
		display: flex;
		flex-wrap: wrap;
		gap: 4px;
	}
	.entity-tag {
		padding: 2px 6px;
		font-size: 0.7rem;
		color: var(--color-text-secondary);
		background: var(--color-bg);
		border-radius: 4px;
	}

	/* Lists */
	.detail-list {
		margin: 0;
		padding-left: 16px;
		font-size: 0.8rem;
		color: var(--color-text-secondary);
		line-height: 1.6;
	}
	.detail-list li {
		margin-bottom: 3px;
	}

	/* Markdown content */
	.markdown-content {
		font-size: 0.82rem;
		color: var(--color-text-secondary);
		line-height: 1.6;
	}
	.markdown-content :global(p) {
		margin: 0.4em 0;
	}
	.markdown-content :global(p:first-child) {
		margin-top: 0;
	}
	.markdown-content :global(p:last-child) {
		margin-bottom: 0;
	}

	/* Social layer — contacts in territory detail */
	.contacts-list {
		display: flex;
		flex-direction: column;
		gap: 4px;
	}
	.contact-card {
		display: block;
		width: 100%;
		text-align: left;
		padding: 8px 10px;
		border-radius: 6px;
		border: 1px solid var(--color-border);
		background: transparent;
		cursor: pointer;
		transition: all 0.15s;
	}
	.contact-card:hover {
		border-color: #E5B84C40;
		background: #E5B84C08;
	}
	.contact-card.selected {
		border-color: #E5B84C60;
		background: #E5B84C10;
	}
	.contact-name {
		font-size: 0.75rem;
		font-weight: 500;
		color: var(--color-text-emphasis);
	}
	.contact-meta {
		display: flex;
		align-items: center;
		gap: 6px;
		font-size: 0.65rem;
		color: var(--color-text-tertiary);
		margin-top: 2px;
	}
	.contact-tier {
		padding: 1px 5px;
		border-radius: 3px;
		background: #E5B84C18;
		color: #E5B84C;
		font-size: 0.6rem;
	}
	.contact-name-row {
		display: flex;
		align-items: center;
		gap: 4px;
	}
	.contact-source-icon {
		width: 12px;
		height: 12px;
		flex-shrink: 0;
	}
	.contact-detail {
		margin-top: 6px;
		padding-top: 6px;
		border-top: 1px solid var(--color-border);
	}
	.contact-essence {
		font-size: 0.6rem;
		color: var(--color-text-secondary);
		line-height: 1.5;
		margin-top: 3px;
	}
	.contact-chronicle {
		margin-top: 6px;
		padding-top: 6px;
		border-top: 1px solid var(--color-border);
	}
	.chronicle-arc {
		font-size: 0.6rem;
		color: var(--color-text-secondary);
		line-height: 1.5;
		margin-bottom: 4px;
	}
	.chronicle-style {
		font-size: 0.55rem;
		color: var(--color-text-tertiary);
		font-style: italic;
		margin-bottom: 4px;
	}
	.chronicle-moments {
		margin-bottom: 4px;
	}
	.chronicle-moment {
		font-size: 0.55rem;
		color: var(--color-accent-aurum);
		padding-left: 8px;
		border-left: 2px solid var(--color-accent-aurum);
		margin-bottom: 2px;
	}
	.chronicle-topics {
		display: flex;
		flex-wrap: wrap;
		gap: 3px;
		margin-top: 4px;
	}
	.chronicle-topic {
		font-size: 0.5rem;
		padding: 2px 6px;
		border-radius: 3px;
		background: rgba(91, 159, 232, 0.1);
		color: var(--color-accent);
	}
	.contact-email,
	.contact-linkedin {
		display: block;
		font-size: 0.6rem;
		margin-bottom: 3px;
		text-decoration: none;
	}
	.contact-email {
		color: var(--color-accent);
	}
	.contact-email:hover,
	.contact-linkedin:hover {
		text-decoration: underline;
	}
	.contact-linkedin {
		color: #0A66C2;
	}
	.contact-messages {
		margin-top: 6px;
		padding-top: 6px;
		border-top: 1px solid var(--color-border);
		max-height: 200px;
		overflow-y: auto;
	}
	.contact-messages-loading {
		display: flex;
		align-items: center;
		gap: 6px;
		font-size: 0.6rem;
		color: var(--color-text-tertiary);
		padding: 4px 0;
	}
	.msg-spinner {
		width: 12px;
		height: 12px;
		border: 2px solid var(--color-border);
		border-top-color: var(--color-accent);
		border-radius: 50%;
		animation: spin 0.8s linear infinite;
	}
	@keyframes spin { to { transform: rotate(360deg); } }
	.contact-msg {
		padding: 4px 0;
		border-bottom: 1px solid var(--color-border);
	}
	.contact-msg:last-child {
		border-bottom: none;
	}
	.contact-msg-header {
		display: flex;
		align-items: center;
		gap: 6px;
		margin-bottom: 2px;
	}
	.contact-msg-role {
		font-size: 0.55rem;
		font-weight: 500;
		color: var(--color-accent-aurum);
	}
	.contact-msg-role.you {
		color: var(--color-accent);
	}
	.contact-msg-date {
		font-size: 0.5rem;
		color: var(--color-text-tertiary);
	}
	.contact-msg-text {
		font-size: 0.6rem;
		color: var(--color-text-secondary);
		line-height: 1.5;
		white-space: pre-wrap;
		word-break: break-word;
	}
	.contact-territories {
		display: flex;
		flex-wrap: wrap;
		gap: 3px;
		margin-top: 4px;
	}
	.territory-link {
		font-size: 0.6rem;
		padding: 2px 6px;
		border-radius: 3px;
		background: var(--color-surface);
		color: var(--color-text-secondary);
	}
	.territory-link .strength {
		color: var(--color-text-tertiary);
		font-size: 0.55rem;
	}
	.contact-stats {
		font-size: 0.6rem;
		color: var(--color-text-tertiary);
		margin-top: 4px;
	}
</style>
