<script lang="ts">
	import { marked } from 'marked';
	import DOMPurify from 'isomorphic-dompurify';
	import {
		mindscapeState,
		mindscapePoints,
		visibleContacts,
		CLUSTER_COLORS,
		NOISE_COLOR,
		type TerritoryProfile,
		type SemanticThemeProfile,
	} from '$lib/stores/mindscape';

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
			.filter(r => (r.pointCount || 0) >= 20)
			.sort((a, b) => (b.pointCount || 0) - (a.pointCount || 0));
	});

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

	// Hovered activity bar for tooltip
	let hoveredActivity = $state<{ month: string; count: number } | null>(null);

	const totalMessages = $derived(pointsStore.meta?.total || pointsStore.points.length);
	const totalRealms = $derived(Object.keys(pointsStore.realms).length);
</script>

<div class="mindscape-nav">
	<!-- Breadcrumb -->
	<div class="breadcrumb">
		<button class="breadcrumb-link" class:active={navLevel === 'realms'} onclick={() => mindscapeState.resetNavigation()}>
			Mindscape
		</button>
		{#if msState.selectedRealmId !== null}
			<span class="breadcrumb-sep">/</span>
			<button
				class="breadcrumb-link"
				class:active={navLevel === 'themes'}
				onclick={() => mindscapeState.drillIntoRealm(msState.selectedRealmId!)}
			>
				{currentRealm?.name || `Realm ${msState.selectedRealmId}`}
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

	<div class="nav-content">
		{#if navLevel === 'realms'}
			<!-- ═══ REALM LIST ═══ -->
			<div class="nav-list">
				{#each sortedRealms as realm (realm.id)}
					<button
						class="nav-item realm-item"
						onclick={() => mindscapeState.drillIntoRealm(realm.id)}
						onmouseenter={() => mindscapeState.setHovered('realm', realm.id)}
						onmouseleave={() => mindscapeState.setHovered('realm', null)}
					>
						<span class="nav-dot" style="background: {getColor(realm.id)}"></span>
						<div class="nav-item-content">
							<span class="nav-item-name">{realm.name || `Realm ${realm.id}`}</span>
							<span class="nav-item-stats">{realm.pointCount?.toLocaleString()} points · {realm.territoryCount} territories</span>
							{#if realm.essence}
								<span class="nav-item-essence">{realm.essence}</span>
							{/if}
						</div>
					</button>
				{/each}
			</div>
			{#if totalMessages > 0}
				<div class="nav-footer">
					{totalMessages.toLocaleString()} messages across {totalRealms} realms
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
					<h2 class="detail-title">{currentTerritory.name}</h2>
					{#if currentTerritory.archetypeType}
						<span class="archetype-badge">{currentTerritory.archetypeType}</span>
					{/if}
					<p class="detail-stats">
						{currentTerritory.count?.toLocaleString() || 0} messages
						{#if currentTerritory.exploredPercent > 0}
							· {currentTerritory.exploredPercent.toFixed(0)}% explored
						{/if}
					</p>
				</div>
				{#if currentTerritory.essence}
					<div class="detail-essence">{currentTerritory.essence}</div>
				{/if}

				{#if currentTerritory.chronicle}
					<div class="detail-block">
						<h4>Chronicle</h4>
						<div class="chronicle-text">{currentTerritory.chronicle}</div>
					</div>
				{/if}

				{#if currentTerritory.activity && currentTerritory.activity.length > 0}
					{@const maxCount = Math.max(...currentTerritory.activity.map(a => a.count))}
					<div class="activity-graph">
						<h4>Activity</h4>
						<div class="activity-bars-container">
							{#if hoveredActivity}
								<div class="activity-tooltip">{hoveredActivity.month}: {hoveredActivity.count}</div>
							{/if}
							<!-- svelte-ignore a11y_no_static_element_interactions -->
							<div class="activity-bars" onmouseleave={() => hoveredActivity = null}>
								{#each currentTerritory.activity.slice(-24) as item}
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
							<span>{currentTerritory.activity[Math.max(0, currentTerritory.activity.length - 24)]?.month}</span>
							<span>{currentTerritory.activity[currentTerritory.activity.length - 1]?.month}</span>
						</div>
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
					{#if territoryContacts.length > 0}
						<div class="detail-block">
							<h4>Linked Contacts</h4>
							<div class="contacts-list">
								{#each territoryContacts as contact}
									<button
										class="contact-card"
										onmouseenter={() => mindscapeState.hoverContact(contact.id)}
										onmouseleave={() => mindscapeState.hoverContact(null)}
										onclick={() => mindscapeState.selectContact(
											msState.selectedContactId === contact.id ? null : contact.id
										)}
										class:selected={msState.selectedContactId === contact.id}
									>
										<div class="contact-name">{contact.name}</div>
										<div class="contact-meta">
											{#if contact.company}<span>{contact.company}</span>{/if}
											<span class="contact-tier">{contact.tier}</span>
										</div>
										{#if msState.selectedContactId === contact.id}
											<div class="contact-detail">
												{#if contact.position}<div class="contact-position">{contact.position}</div>{/if}
												<div class="contact-territories">
													{#each contact.territories as t}
														<span class="territory-link" style="opacity: {0.5 + t.strength * 0.5}">
															{t.territory_name || `Territory ${t.territory_id}`}
															<span class="strength">({(t.strength * 100).toFixed(0)}%)</span>
														</span>
													{/each}
												</div>
												{#if contact.interaction_count}
													<div class="contact-stats">{contact.interaction_count} messages exchanged</div>
												{/if}
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

	/* Navigation list items */
	.nav-list {
		display: flex;
		flex-direction: column;
	}
	.nav-item {
		display: flex;
		align-items: flex-start;
		gap: 8px;
		padding: 10px 14px;
		border: none;
		background: transparent;
		text-align: left;
		cursor: pointer;
		font-family: inherit;
		font-size: inherit;
		color: inherit;
		border-bottom: 1px solid rgba(255,255,255,0.03);
		transition: background 0.12s;
	}
	.nav-item:hover {
		background: rgba(255,255,255,0.03);
	}
	.nav-item.selected {
		background: rgba(229, 184, 76, 0.08);
		border-left: 2px solid var(--color-accent);
	}
	.nav-dot {
		width: 8px;
		height: 8px;
		border-radius: 50%;
		flex-shrink: 0;
		margin-top: 4px;
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
	.detail-title {
		font-size: 1rem;
		font-weight: 600;
		color: var(--color-text-primary);
		margin: 0 0 6px;
	}
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
		border-radius: 1px;
		transition: opacity 0.2s;
		cursor: pointer;
	}
	.activity-bar:hover {
		opacity: 0.7;
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
	.contact-detail {
		margin-top: 6px;
		padding-top: 6px;
		border-top: 1px solid var(--color-border);
	}
	.contact-position {
		font-size: 0.65rem;
		color: var(--color-text-secondary);
		margin-bottom: 4px;
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
