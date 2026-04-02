<script lang="ts">
	import { slide } from 'svelte/transition';
	import {
		mindscapeState,
		mindscapePoints,
		CLUSTER_COLORS,
		NOISE_COLOR,
		type SemanticThemeProfile,
		type TerritoryProfile
	} from '$lib/stores/mindscape';

	const msState = $derived($mindscapeState);
	const pointsStore = $derived($mindscapePoints);

	// Build territory -> realm mapping
	const territoryToRealm = $derived.by(() => {
		const mapping: Record<number, number> = {};
		for (const [territoryId, territory] of Object.entries(pointsStore.territories)) {
			if (territory.realmId !== null && territory.realmId !== undefined) {
				mapping[Number(territoryId)] = territory.realmId;
			}
		}
		return mapping;
	});

	// Compute message count per realm
	const realmMessageCounts = $derived.by(() => {
		const counts: Record<number, number> = {};
		const t2r = territoryToRealm;
		for (const point of pointsStore.points) {
			const territoryId = point.data.cluster3d;
			if (territoryId !== null && territoryId !== undefined && territoryId !== -1) {
				const realmId = t2r[territoryId];
				if (realmId !== undefined) {
					counts[realmId] = (counts[realmId] || 0) + 1;
				}
			}
		}
		return counts;
	});

	// Get semantic theme count per realm
	const realmThemeCounts = $derived.by(() => {
		const counts: Record<number, number> = {};
		for (const key of Object.keys(pointsStore.semanticThemes)) {
			const realmId = parseInt(key.split('-')[0]);
			counts[realmId] = (counts[realmId] || 0) + 1;
		}
		return counts;
	});

	// Level 1: All realms sorted by message count
	const realms = $derived.by(() => {
		return Object.entries(pointsStore.realms)
			.map(([id, profile]) => ({
				id: Number(id),
				...profile,
				messageCount: realmMessageCounts[Number(id)] || 0,
				themeCount: realmThemeCounts[Number(id)] || 0,
			}))
			.sort((a, b) => b.messageCount - a.messageCount);
	});

	function getThemesForRealm(realmId: number): SemanticThemeProfile[] {
		const seen = new Set<number>();
		return Object.entries(pointsStore.semanticThemes)
			.filter(([key]) => key.startsWith(`${realmId}-`))
			.map(([, profile]) => profile)
			.filter(p => { if (seen.has(p.semanticThemeId)) return false; seen.add(p.semanticThemeId); return true; })
			.sort((a, b) => b.messageCount - a.messageCount);
	}

	function getTerritoriesForTheme(realmId: number, themeId: number): ({ id: number } & TerritoryProfile)[] {
		const themeKey = `${realmId}-${themeId}`;
		const theme = pointsStore.semanticThemes[themeKey];
		if (!theme?.territoryIds) return [];
		// Deduplicate territory IDs to prevent Svelte each_key_duplicate errors
		const uniqueIds = [...new Set(theme.territoryIds)];
		return uniqueIds
			.map((id: number) => ({ id, ...pointsStore.territories[id] }))
			.filter((t): t is { id: number } & TerritoryProfile => !!t.name)
			.sort((a, b) => (b.count || 0) - (a.count || 0));
	}

	function getColor(id: number): string {
		if (id === -1) return NOISE_COLOR;
		return CLUSTER_COLORS[id % CLUSTER_COLORS.length];
	}

	function handleRealmClick(realmId: number) {
		if (msState.selectedRealmId === realmId) {
			mindscapeState.resetNavigation();
		} else {
			mindscapeState.drillIntoRealm(realmId);
		}
	}

	function handleThemeClick(theme: SemanticThemeProfile) {
		if (msState.selectedSemanticThemeId === theme.semanticThemeId) {
			mindscapeState.goBack();
		} else {
			mindscapeState.drillIntoTheme(msState.selectedRealmId!, theme.semanticThemeId);
		}
	}

	function handleTerritoryClick(territory: { id: number } & TerritoryProfile) {
		if (msState.selectedTerritoryId === territory.id) {
			mindscapeState.deselectTerritory();
		} else {
			mindscapeState.selectTerritory(territory.id);
		}
	}

	const hasData = $derived(realms.length > 0);
</script>

<div class="realm-nav">
	<div class="px-4 py-2 flex items-center justify-between">
		<span class="text-xs font-medium text-[var(--color-text-tertiary)] uppercase tracking-wider">
			Realms
		</span>
		{#if hasData}
			<span class="text-xs text-[var(--color-text-tertiary)]">{realms.length}</span>
		{/if}
	</div>

	{#if !hasData}
		<div class="px-4 py-2">
			<p class="text-xs text-[var(--color-text-tertiary)]">Loading realms...</p>
		</div>
	{:else}
		<div class="accordion-list">
			{#each realms as realm (realm.id)}
				{@const isExpanded = msState.selectedRealmId === realm.id}
				{@const themes = isExpanded ? getThemesForRealm(realm.id) : []}

				<div class="accordion-item">
					<button
						class="accordion-header"
						class:expanded={isExpanded}
						onclick={() => handleRealmClick(realm.id)}
						onmouseenter={() => mindscapeState.setHovered('realm', realm.id)}
						onmouseleave={() => mindscapeState.setHovered('realm', null)}
					>
						<span class="item-dot" style="background-color: {getColor(realm.id)}"></span>
						<span class="item-name" class:font-semibold={isExpanded}>{realm.name}</span>
						<span class="item-count">{realm.messageCount.toLocaleString()}</span>
						<svg class="item-chevron" class:expanded={isExpanded} fill="none" stroke="currentColor" viewBox="0 0 24 24">
							<path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M19 9l-7 7-7-7" />
						</svg>
					</button>

					{#if isExpanded && themes.length > 0}
						<div class="accordion-content" transition:slide={{ duration: 200 }}>
							{#each themes as theme (theme.semanticThemeId)}
								{@const isThemeExpanded = msState.selectedSemanticThemeId === theme.semanticThemeId}
								{@const territories = isThemeExpanded ? getTerritoriesForTheme(realm.id, theme.semanticThemeId) : []}

								<div class="accordion-item nested">
									<button
										class="accordion-header nested"
										class:expanded={isThemeExpanded}
										onclick={() => handleThemeClick(theme)}
										onmouseenter={() => mindscapeState.setHovered('theme', theme.semanticThemeId)}
										onmouseleave={() => mindscapeState.setHovered('theme', null)}
									>
										<span class="item-dot small" style="background-color: {getColor(theme.semanticThemeId)}"></span>
										<span class="item-name" class:font-semibold={isThemeExpanded}>{theme.name}</span>
										<span class="item-count">{theme.messageCount.toLocaleString()}</span>
										<svg class="item-chevron small" class:expanded={isThemeExpanded} fill="none" stroke="currentColor" viewBox="0 0 24 24">
											<path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M19 9l-7 7-7-7" />
										</svg>
									</button>

									{#if isThemeExpanded && territories.length > 0}
										<div class="accordion-content" transition:slide={{ duration: 150 }}>
											{#each territories as territory (territory.id)}
												{@const isSelected = msState.selectedTerritoryId === territory.id}
												<button
													class="territory-item"
													class:selected={isSelected}
													onclick={() => handleTerritoryClick(territory)}
													onmouseenter={() => mindscapeState.setHovered('territory', territory.id)}
													onmouseleave={() => mindscapeState.setHovered('territory', null)}
												>
													<span class="item-dot tiny" style="background-color: {getColor(territory.id)}"></span>
													<span class="item-name" class:font-semibold={isSelected}>{territory.name}</span>
													<span class="item-count">{(territory.count || 0).toLocaleString()}</span>
												</button>
											{/each}
										</div>
									{/if}
								</div>
							{/each}
						</div>
					{/if}
				</div>
			{/each}
		</div>
	{/if}
</div>

<style>
	.realm-nav {
		display: flex;
		flex-direction: column;
	}

	.accordion-list {
		padding: 0 0.5rem;
	}

	.accordion-item {
		margin-bottom: 1px;
	}

	.accordion-item.nested {
		margin-bottom: 1px;
	}

	.accordion-header {
		display: flex;
		align-items: center;
		gap: 0.5rem;
		width: 100%;
		padding: 0.5rem 0.625rem;
		font-size: 0.8125rem;
		color: var(--color-text-primary);
		background: transparent;
		border: none;
		border-radius: 0.375rem;
		cursor: pointer;
		transition: all 0.15s;
		text-align: left;
	}

	.accordion-header:hover {
		background: var(--color-elevated);
	}

	.accordion-header.expanded {
		background: rgba(91, 159, 232, 0.08);
	}

	.accordion-header.nested {
		padding: 0.375rem 0.5rem;
		font-size: 0.75rem;
	}

	.accordion-content {
		padding-left: 0.875rem;
		margin-top: 1px;
	}

	.item-dot {
		width: 8px;
		height: 8px;
		border-radius: 50%;
		flex-shrink: 0;
	}

	.item-dot.small {
		width: 6px;
		height: 6px;
	}

	.item-dot.tiny {
		width: 5px;
		height: 5px;
	}

	.item-name {
		flex: 1;
		min-width: 0;
		overflow: hidden;
		text-overflow: ellipsis;
		white-space: nowrap;
	}

	.item-count {
		font-size: 0.6875rem;
		color: var(--color-text-tertiary);
		font-variant-numeric: tabular-nums;
		flex-shrink: 0;
	}

	.item-chevron {
		width: 14px;
		height: 14px;
		color: var(--color-text-tertiary);
		transition: transform 0.2s;
		flex-shrink: 0;
	}

	.item-chevron.small {
		width: 12px;
		height: 12px;
	}

	.item-chevron.expanded {
		transform: rotate(180deg);
	}

	.territory-item {
		display: flex;
		align-items: center;
		gap: 0.5rem;
		width: 100%;
		padding: 0.375rem 0.5rem;
		font-size: 0.6875rem;
		color: var(--color-text-primary);
		background: transparent;
		border: none;
		border-radius: 0.25rem;
		cursor: pointer;
		transition: all 0.15s;
		text-align: left;
	}

	.territory-item:hover {
		background: rgba(255, 255, 255, 0.05);
	}

	.territory-item.selected {
		background: rgba(91, 159, 232, 0.15);
	}
</style>
