<script lang="ts">
	import { onMount } from 'svelte';
	import { browser } from '$app/environment';
	import { api, apiGet, apiPost } from '$lib/api';

	// ── Types ──────────────────────────────────────────────────────────────

	interface Portfolio {
		id: string;
		name: string;
		type: string;
		base_currency: string;
		role: string;
		created_at: string;
	}

	interface Position {
		portfolio_id: string;
		asset_id: string;
		quantity: number;
		avg_cost_basis: number;
		total_invested: number;
		realized_pnl: number;
		symbol: string;
		asset_name: string;
		asset_type: string;
		currency: string;
		price_source: string;
		lookup_id: string | null;
		current_price?: number;
		current_value?: number;
		unrealized_pnl?: number;
		price_currency?: string;
		price_fetched_at?: string;
	}

	interface Transaction {
		id: string;
		portfolio_id: string;
		asset_id: string;
		type: string;
		quantity: number;
		price_per_unit: number;
		currency: string;
		exchange_rate: number;
		fees: number;
		transacted_at: string;
		notes: string | null;
		created_at: string;
		symbol: string;
		asset_name: string;
		asset_type: string;
	}

	interface Asset {
		id: string;
		symbol: string;
		name: string;
		type: string;
		currency: string;
		price_source: string;
	}

	interface WatchlistItem {
		user_id: string;
		asset_id: string;
		symbol: string;
		asset_name: string;
		asset_type: string;
		currency: string;
		price_source: string;
		lookup_id: string | null;
		target_price_high: number | null;
		target_price_low: number | null;
		notes: string | null;
		added_at: string;
		current_price?: number;
		price_currency?: string;
		price_fetched_at?: string;
	}

	interface Snapshot {
		portfolio_id: string;
		date: string;
		total_value: number;
		currency: string;
	}

	// ── State ──────────────────────────────────────────────────────────────

	let portfolios = $state<Portfolio[]>([]);
	let activePortfolioId = $state<string | null>(null);
	let positions = $state<Position[]>([]);
	let transactions = $state<Transaction[]>([]);
	let watchlist = $state<WatchlistItem[]>([]);
	let snapshots = $state<Snapshot[]>([]);
	let loading = $state(true);
	let loadingPositions = $state(false);
	let activeTab = $state<'positions' | 'transactions' | 'watchlist'>('positions');

	// Add transaction form
	let showAddTx = $state(false);
	let txForm = $state({
		symbol: '', assetName: '', assetType: 'stock' as string,
		exchange: '', lookupId: '', priceSource: 'yahoo' as string,
		type: 'buy' as string, quantity: '', pricePerUnit: '', currency: 'EUR',
		exchangeRate: '1', fees: '0', date: new Date().toISOString().split('T')[0], notes: '',
	});
	let savingTx = $state(false);
	let txError = $state('');

	// Create portfolio form
	let showCreatePortfolio = $state(false);
	let newPortfolioName = $state('');
	let newPortfolioCurrency = $state('EUR');
	let newPortfolioType = $state('personal');
	let creatingPortfolio = $state(false);

	// Delete
	let showDeleteConfirm = $state<string | null>(null); // tx id to delete
	let isDeleting = $state(false);

	// ── Derived ────────────────────────────────────────────────────────────

	const activePortfolio = $derived(portfolios.find(p => p.id === activePortfolioId) || null);

	const totalInvested = $derived(
		positions.reduce((sum, p) => sum + p.total_invested, 0)
	);

	const totalRealizedPnl = $derived(
		positions.reduce((sum, p) => sum + p.realized_pnl, 0)
	);

	const totalCurrentValue = $derived(
		positions.reduce((sum, p) => sum + (p.current_value ?? p.total_invested), 0)
	);

	const hasLivePrices = $derived(positions.some(p => p.current_price != null));

	const totalUnrealizedPnl = $derived(
		positions.reduce((sum, p) => sum + (p.unrealized_pnl ?? 0), 0)
	);

	const allocation = $derived(
		(() => {
			const groups: { type: string; invested: number; color: string }[] = [];
			const byType: Record<string, number> = {};
			for (const p of positions) {
				const value = p.current_value ?? p.total_invested;
				byType[p.asset_type] = (byType[p.asset_type] || 0) + value;
			}
			const colorMap: Record<string, string> = {
				stock: '#5B9FE8', etf: '#A78BFA', crypto: '#E5B84C',
				commodity: '#EAB308', cash: '#4ADE80', prediction: '#F472B6', other: '#6B7280',
			};
			for (const [type, invested] of Object.entries(byType)) {
				groups.push({ type, invested, color: colorMap[type] || '#6B7280' });
			}
			return groups.sort((a, b) => b.invested - a.invested);
		})()
	);

	const defaultPriceSource: Record<string, string> = {
		stock: 'yahoo', etf: 'yahoo', crypto: 'coingecko',
		commodity: 'metal_api', cash: 'fx', prediction: 'polymarket', other: 'manual',
	};

	// ── Data Loading ───────────────────────────────────────────────────────

	async function loadPortfolios() {
		try {
			const data = await apiGet<{ portfolios: Portfolio[] }>('/portal/wealth/portfolios');
			portfolios = data.portfolios;
			if (portfolios.length > 0 && !activePortfolioId) {
				activePortfolioId = portfolios[0].id;
			}
		} catch (e) {
			console.error('Failed to load portfolios:', e);
		}
	}

	async function loadPositions() {
		if (!activePortfolioId) return;
		loadingPositions = true;
		try {
			const data = await apiGet<{ portfolio: Portfolio; positions: Position[] }>(
				`/portal/wealth/portfolios/${activePortfolioId}/positions`
			);
			positions = data.positions;
		} catch (e) {
			console.error('Failed to load positions:', e);
		} finally {
			loadingPositions = false;
		}
	}

	async function loadTransactions() {
		if (!activePortfolioId) return;
		try {
			const data = await apiGet<{ transactions: Transaction[] }>(
				`/portal/wealth/portfolios/${activePortfolioId}/transactions`
			);
			transactions = data.transactions;
		} catch (e) {
			console.error('Failed to load transactions:', e);
		}
	}

	async function loadWatchlist() {
		try {
			const data = await apiGet<{ watchlist: WatchlistItem[] }>('/portal/wealth/watchlist');
			watchlist = data.watchlist;
		} catch (e) {
			console.error('Failed to load watchlist:', e);
		}
	}

	async function loadSnapshots() {
		if (!activePortfolioId) return;
		try {
			const data = await apiGet<{ snapshots: Snapshot[] }>(
				`/portal/wealth/portfolios/${activePortfolioId}/performance`
			);
			snapshots = data.snapshots;
		} catch (e) {
			console.error('Failed to load snapshots:', e);
		}
	}

	// ── Actions ────────────────────────────────────────────────────────────

	async function createPortfolio() {
		if (!newPortfolioName.trim()) return;
		creatingPortfolio = true;
		try {
			const data = await apiPost<{ portfolio: Portfolio }>('/portal/wealth/portfolios', {
				name: newPortfolioName.trim(),
				baseCurrency: newPortfolioCurrency,
				type: newPortfolioType,
			});
			portfolios = [...portfolios, { ...data.portfolio, role: 'owner' }];
			activePortfolioId = data.portfolio.id;
			showCreatePortfolio = false;
			newPortfolioName = '';
		} catch (e) {
			console.error('Failed to create portfolio:', e);
		} finally {
			creatingPortfolio = false;
		}
	}

	async function addTransaction() {
		if (!activePortfolioId || !txForm.symbol || !txForm.assetName) return;
		savingTx = true;
		txError = '';
		try {
			await apiPost(`/portal/wealth/portfolios/${activePortfolioId}/transactions`, {
				symbol: txForm.symbol.toUpperCase(),
				assetName: txForm.assetName,
				assetType: txForm.assetType,
				exchange: txForm.exchange || undefined,
				lookupId: txForm.lookupId || undefined,
				priceSource: txForm.priceSource,
				type: txForm.type,
				quantity: parseFloat(txForm.quantity) || 0,
				pricePerUnit: parseFloat(txForm.pricePerUnit) || 0,
				currency: txForm.currency,
				exchangeRate: parseFloat(txForm.exchangeRate) || 1,
				fees: parseFloat(txForm.fees) || 0,
				date: txForm.date,
				notes: txForm.notes || undefined,
			});
			showAddTx = false;
			txForm = { ...txForm, symbol: '', assetName: '', quantity: '', pricePerUnit: '', notes: '', date: new Date().toISOString().split('T')[0] };
			await loadPositions();
			await loadTransactions();
		} catch (e: any) {
			txError = e.message || 'Failed to add transaction';
		} finally {
			savingTx = false;
		}
	}

	async function deleteTransaction(txId: string) {
		isDeleting = true;
		try {
			await api(`/portal/wealth/transactions/${txId}`, { method: 'DELETE' });
			transactions = transactions.filter(t => t.id !== txId);
			showDeleteConfirm = null;
			await loadPositions();
		} catch (e) {
			console.error('Failed to delete transaction:', e);
		} finally {
			isDeleting = false;
		}
	}

	function selectPortfolio(id: string) {
		activePortfolioId = id;
		positions = [];
		transactions = [];
		snapshots = [];
	}

	// ── Helpers ────────────────────────────────────────────────────────────

	const CRYPTO_SYMBOLS: Record<string, string> = { BTC: '₿', ETH: 'Ξ', SOL: '◎' };

	function formatCurrency(value: number, currency: string): string {
		const upper = currency?.toUpperCase();
		const cryptoSym = CRYPTO_SYMBOLS[upper];
		if (cryptoSym) {
			const decimals = Math.abs(value) < 1 ? 6 : Math.abs(value) < 100 ? 4 : 2;
			return `${cryptoSym}${value.toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: decimals })}`;
		}
		try {
			return new Intl.NumberFormat('en-US', { style: 'currency', currency, minimumFractionDigits: 2, maximumFractionDigits: 2 }).format(value);
		} catch {
			return `${value.toFixed(2)} ${currency}`;
		}
	}

	function formatDate(dateStr: string): string {
		try {
			return new Date(dateStr).toLocaleDateString('en-GB', { day: 'numeric', month: 'short', year: 'numeric' });
		} catch {
			return dateStr;
		}
	}

	const CRYPTO_COLORS: Record<string, string> = { BTC: '#F7931A', ETH: '#627EEA', SOL: '#9945FF' };

	function cryptoColor(symbol: string): string | null {
		return CRYPTO_COLORS[symbol?.toUpperCase()] || null;
	}

	function typeColor(type: string): string {
		switch (type) {
			case 'stock': return 'text-blue-400';
			case 'etf': return 'text-purple-400';
			case 'crypto': return 'text-amber-400';
			case 'commodity': return 'text-yellow-500';
			case 'cash': return 'text-emerald-400';
			case 'prediction': return 'text-pink-400';
			default: return 'text-[var(--color-text-secondary)]';
		}
	}

	function txTypeLabel(type: string): string {
		return { buy: 'Buy', sell: 'Sell', dividend: 'Dividend', staking_reward: 'Staking', transfer_in: 'Transfer In', transfer_out: 'Transfer Out' }[type] || type;
	}

	function txTypeColor(type: string): string {
		if (type === 'buy' || type === 'transfer_in') return 'text-jade';
		if (type === 'sell' || type === 'transfer_out') return 'text-coral';
		if (type === 'dividend' || type === 'staking_reward') return 'text-aurum';
		return 'text-[var(--color-text-secondary)]';
	}

	// ── Lifecycle ──────────────────────────────────────────────────────────

	$effect(() => {
		if (activePortfolioId) {
			loadPositions();
			loadTransactions();
			loadSnapshots();
		}
	});

	onMount(async () => {
		await loadPortfolios();
		await loadWatchlist();
		loading = false;
	});
</script>

<div class="wealth-page flex flex-col h-full">
	<!-- Header -->
	<div class="flex items-center justify-between gap-4 px-4 sm:px-6 py-4 border-b border-[var(--color-border)]">
		<div class="flex items-center gap-3">
			<h1 class="text-xl font-semibold text-[var(--color-text-emphasis)]">Wealth</h1>

			<!-- Portfolio selector -->
			{#if portfolios.length > 0}
				<div class="flex items-center gap-1">
					{#each portfolios as p}
						<button
							onclick={() => selectPortfolio(p.id)}
							class="px-3 py-1.5 text-sm rounded-lg transition-colors {p.id === activePortfolioId
								? 'bg-aurum/15 text-aurum font-medium'
								: 'text-[var(--color-text-secondary)] hover:text-[var(--color-text-primary)] hover:bg-[var(--color-elevated)]'}"
						>
							{p.name}
							{#if p.role !== 'owner'}
								<span class="text-[10px] opacity-60 ml-1">{p.role}</span>
							{/if}
						</button>
					{/each}
				</div>
			{/if}
		</div>

		<div class="flex items-center gap-2">
			<button
				onclick={() => showCreatePortfolio = true}
				class="text-sm px-3 py-1.5 rounded-lg border border-[var(--color-border)] text-[var(--color-text-secondary)] hover:text-[var(--color-text-primary)] hover:border-[var(--color-text-tertiary)] transition-colors"
			>
				+ Portfolio
			</button>
			{#if activePortfolio && activePortfolio.role !== 'viewer'}
				<button
					onclick={() => showAddTx = true}
					class="text-sm px-3 py-1.5 rounded-lg bg-aurum/15 text-aurum hover:bg-aurum/25 transition-colors font-medium"
				>
					+ Transaction
				</button>
			{/if}
		</div>
	</div>

	{#if loading}
		<div class="flex items-center justify-center flex-1">
			<div class="w-8 h-8 border-2 border-aurum/30 border-t-aurum rounded-full animate-spin"></div>
		</div>
	{:else if portfolios.length === 0}
		<!-- Empty state -->
		<div class="flex flex-col items-center justify-center flex-1 gap-4 text-center px-4">
			<div class="w-16 h-16 rounded-2xl bg-aurum/10 flex items-center justify-center">
				<svg class="w-8 h-8 text-aurum" fill="none" stroke="currentColor" viewBox="0 0 24 24" stroke-width="1.5">
					<path stroke-linecap="round" stroke-linejoin="round" d="M2.25 18.75a60.07 60.07 0 0 1 15.797 2.101c.727.198 1.453-.342 1.453-1.096V18.75M3.75 4.5v.75A.75.75 0 0 1 3 6h-.75m0 0v-.375c0-.621.504-1.125 1.125-1.125H20.25M2.25 6v9m18-10.5v.75c0 .414.336.75.75.75h.75m-1.5-1.5h.375c.621 0 1.125.504 1.125 1.125v9.75c0 .621-.504 1.125-1.125 1.125h-.375m1.5-1.5H21a.75.75 0 0 0-.75.75v.75m0 0H3.75m0 0h-.375a1.125 1.125 0 0 1-1.125-1.125V15m1.5 1.5v-.75A.75.75 0 0 0 3 15h-.75M15 10.5a3 3 0 1 1-6 0 3 3 0 0 1 6 0Zm3 0h.008v.008H18V10.5Zm-12 0h.008v.008H6V10.5Z" />
				</svg>
			</div>
			<div>
				<h2 class="text-lg font-medium text-[var(--color-text-primary)]">No portfolios yet</h2>
				<p class="text-sm text-[var(--color-text-secondary)] mt-1">Create your first portfolio to start tracking positions.</p>
			</div>
			<button
				onclick={() => showCreatePortfolio = true}
				class="px-4 py-2 rounded-lg bg-aurum/15 text-aurum hover:bg-aurum/25 transition-colors font-medium text-sm"
			>
				Create Portfolio
			</button>
		</div>
	{:else if activePortfolio}
		<!-- Summary bar -->
		<div class="px-4 sm:px-6 py-4 flex flex-col gap-3">
			<div class="grid grid-cols-2 sm:grid-cols-3 lg:grid-cols-5 gap-3">
				<div class="bg-[var(--color-surface)] rounded-xl p-3 border border-[var(--color-border)]">
					<div class="text-xs text-[var(--color-text-tertiary)] mb-1">Total Invested</div>
					<div class="text-lg font-semibold text-[var(--color-text-primary)]">
						{formatCurrency(totalInvested, activePortfolio.base_currency)}
					</div>
				</div>
				<div class="bg-[var(--color-surface)] rounded-xl p-3 border border-[var(--color-border)]">
					<div class="text-xs text-[var(--color-text-tertiary)] mb-1">Current Value</div>
					<div class="text-lg font-semibold text-[var(--color-text-primary)]">
						{formatCurrency(totalCurrentValue, activePortfolio.base_currency)}
					</div>
				</div>
				<div class="bg-[var(--color-surface)] rounded-xl p-3 border border-[var(--color-border)]">
					<div class="text-xs text-[var(--color-text-tertiary)] mb-1">Unrealized P&L</div>
					<div class="text-lg font-semibold {totalUnrealizedPnl >= 0 ? 'text-jade' : 'text-coral'}">
						{totalUnrealizedPnl >= 0 ? '+' : ''}{formatCurrency(totalUnrealizedPnl, activePortfolio.base_currency)}
					</div>
				</div>
				<div class="bg-[var(--color-surface)] rounded-xl p-3 border border-[var(--color-border)]">
					<div class="text-xs text-[var(--color-text-tertiary)] mb-1">Realized P&L</div>
					<div class="text-lg font-semibold {totalRealizedPnl >= 0 ? 'text-jade' : 'text-coral'}">
						{totalRealizedPnl >= 0 ? '+' : ''}{formatCurrency(totalRealizedPnl, activePortfolio.base_currency)}
					</div>
				</div>
				<div class="bg-[var(--color-surface)] rounded-xl p-3 border border-[var(--color-border)]">
					<div class="text-xs text-[var(--color-text-tertiary)] mb-1">Positions</div>
					<div class="text-lg font-semibold text-[var(--color-text-primary)]">{positions.length}</div>
				</div>
			</div>

			<!-- Allocation bar -->
			{#if allocation.length > 0 && totalInvested > 0}
				<div class="bg-[var(--color-surface)] rounded-xl p-3 border border-[var(--color-border)]">
					<div class="text-xs text-[var(--color-text-tertiary)] mb-2">Allocation</div>
					<div class="flex rounded-full h-2.5 overflow-hidden bg-[var(--color-bg)]">
						{#each allocation as a}
							<div
								style="width: {(a.invested / totalInvested * 100).toFixed(1)}%; background-color: {a.color};"
								title="{a.type}: {formatCurrency(a.invested, activePortfolio.base_currency)} ({(a.invested / totalInvested * 100).toFixed(1)}%)"
							></div>
						{/each}
					</div>
					<div class="flex flex-wrap gap-x-4 gap-y-1 mt-2">
						{#each allocation as a}
							<div class="flex items-center gap-1.5 text-xs">
								<div class="w-2 h-2 rounded-full" style="background-color: {a.color};"></div>
								<span class="text-[var(--color-text-secondary)] capitalize">{a.type}</span>
								<span class="text-[var(--color-text-tertiary)]">{(a.invested / totalInvested * 100).toFixed(0)}%</span>
							</div>
						{/each}
					</div>
				</div>
			{/if}
		</div>

		<!-- Tabs -->
		<div class="flex gap-1 px-4 sm:px-6 mb-2">
			{#each [['positions', 'Positions'], ['transactions', 'Transactions'], ['watchlist', 'Watchlist']] as [tab, label]}
				<button
					onclick={() => activeTab = tab as typeof activeTab}
					class="px-3 py-1.5 text-sm rounded-lg transition-colors {activeTab === tab
						? 'bg-[var(--color-accent)]/10 text-[var(--color-accent)] font-medium'
						: 'text-[var(--color-text-secondary)] hover:text-[var(--color-text-primary)]'}"
				>
					{label}
				</button>
			{/each}
		</div>

		<!-- Content -->
		<div class="flex-1 overflow-y-auto px-4 sm:px-6 pb-6">
			{#if activeTab === 'positions'}
				{#if loadingPositions}
					<div class="flex items-center justify-center py-12">
						<div class="w-6 h-6 border-2 border-aurum/30 border-t-aurum rounded-full animate-spin"></div>
					</div>
				{:else if positions.length === 0}
					<div class="text-center py-12 text-[var(--color-text-secondary)]">
						<p>No positions yet. Add your first transaction to get started.</p>
					</div>
				{:else}
					<div class="overflow-x-auto">
						<table class="w-full text-sm">
							<thead>
								<tr class="text-left text-[var(--color-text-tertiary)] border-b border-[var(--color-border)]">
									<th class="py-2 pr-4 font-medium">Asset</th>
									<th class="py-2 pr-4 font-medium">Type</th>
									<th class="py-2 pr-4 font-medium text-right">Quantity</th>
									<th class="py-2 pr-4 font-medium text-right">Avg Cost</th>
									<th class="py-2 pr-4 font-medium text-right">Total Invested</th>
									<th class="py-2 pr-4 font-medium text-right">Price</th>
									<th class="py-2 pr-4 font-medium text-right">Value</th>
									<th class="py-2 pr-4 font-medium text-right">Unrealized P&L</th>
									<th class="py-2 font-medium text-right">Realized P&L</th>
								</tr>
							</thead>
							<tbody>
								{#each positions as pos}
									<tr class="border-b border-[var(--color-border)]/50 hover:bg-[var(--color-elevated)]/50 transition-colors">
										<td class="py-3 pr-4">
											<div class="font-medium" style={cryptoColor(pos.symbol) ? `color: ${cryptoColor(pos.symbol)}` : 'color: var(--color-text-primary)'}>{pos.symbol}</div>
											<div class="text-xs text-[var(--color-text-tertiary)]">{pos.asset_name}</div>
										</td>
										<td class="py-3 pr-4">
											<span class="text-xs {typeColor(pos.asset_type)} capitalize">{pos.asset_type}</span>
										</td>
										<td class="py-3 pr-4 text-right font-mono text-[var(--color-text-primary)]">
											{pos.quantity % 1 === 0 ? pos.quantity.toLocaleString() : pos.quantity.toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 6 })}
										</td>
										<td class="py-3 pr-4 text-right font-mono text-[var(--color-text-secondary)]">
											{formatCurrency(pos.avg_cost_basis, activePortfolio.base_currency)}
										</td>
										<td class="py-3 pr-4 text-right font-mono text-[var(--color-text-primary)]">
											{formatCurrency(pos.total_invested, activePortfolio.base_currency)}
										</td>
										<td class="py-3 pr-4 text-right font-mono {pos.current_price != null ? 'text-[var(--color-text-primary)]' : 'text-[var(--color-text-tertiary)]'}">
											{pos.current_price != null ? formatCurrency(pos.current_price, pos.price_currency || pos.currency) : '—'}
										</td>
										<td class="py-3 pr-4 text-right font-mono {pos.current_value != null ? 'text-[var(--color-text-primary)]' : 'text-[var(--color-text-tertiary)]'}">
											{pos.current_value != null ? formatCurrency(pos.current_value, activePortfolio.base_currency) : '—'}
										</td>
										<td class="py-3 pr-4 text-right font-mono">
											{#if pos.unrealized_pnl != null}
												{@const pct = pos.total_invested > 0 ? (pos.unrealized_pnl / pos.total_invested * 100) : 0}
												<span class="{pos.unrealized_pnl >= 0 ? 'text-jade' : 'text-coral'}">
													{pos.unrealized_pnl >= 0 ? '+' : ''}{formatCurrency(pos.unrealized_pnl, activePortfolio.base_currency)}
												</span>
												<div class="text-[10px] {pos.unrealized_pnl >= 0 ? 'text-jade/70' : 'text-coral/70'}">
													{pos.unrealized_pnl >= 0 ? '+' : ''}{pct.toFixed(1)}%
												</div>
											{:else}
												<span class="text-[var(--color-text-tertiary)]">—</span>
											{/if}
										</td>
										<td class="py-3 text-right font-mono {pos.realized_pnl >= 0 ? 'text-jade' : 'text-coral'}">
											{pos.realized_pnl !== 0 ? (pos.realized_pnl >= 0 ? '+' : '') + formatCurrency(pos.realized_pnl, activePortfolio.base_currency) : '-'}
										</td>
									</tr>
								{/each}
							</tbody>
						</table>
					</div>
				{/if}

			{:else if activeTab === 'watchlist'}
				{#if watchlist.length === 0}
					<div class="text-center py-12 text-[var(--color-text-secondary)]">
						<p>No watchlist items. Ask Rob to add assets to your watchlist.</p>
					</div>
				{:else}
					<div class="overflow-x-auto">
						<table class="w-full text-sm">
							<thead>
								<tr class="text-left text-[var(--color-text-tertiary)] border-b border-[var(--color-border)]">
									<th class="py-2 pr-4 font-medium">Asset</th>
									<th class="py-2 pr-4 font-medium">Type</th>
									<th class="py-2 pr-4 font-medium text-right">Price</th>
									<th class="py-2 pr-4 font-medium text-right">Target High</th>
									<th class="py-2 pr-4 font-medium text-right">Target Low</th>
									<th class="py-2 pr-4 font-medium">Notes</th>
									<th class="py-2 font-medium text-right">Added</th>
								</tr>
							</thead>
							<tbody>
								{#each watchlist as item}
									<tr class="border-b border-[var(--color-border)]/50 hover:bg-[var(--color-elevated)]/50 transition-colors">
										<td class="py-3 pr-4">
											<div class="font-medium text-[var(--color-text-primary)]">{item.symbol}</div>
											<div class="text-xs text-[var(--color-text-tertiary)]">{item.asset_name}</div>
										</td>
										<td class="py-3 pr-4">
											<span class="text-xs {typeColor(item.asset_type)} capitalize">{item.asset_type}</span>
										</td>
										<td class="py-3 pr-4 text-right font-mono {item.current_price != null ? 'text-[var(--color-text-primary)]' : 'text-[var(--color-text-tertiary)]'}">
											{item.current_price != null ? formatCurrency(item.current_price, item.price_currency || item.currency) : '—'}
										</td>
										<td class="py-3 pr-4 text-right font-mono text-jade">
											{item.target_price_high ? formatCurrency(item.target_price_high, item.currency) : '-'}
										</td>
										<td class="py-3 pr-4 text-right font-mono text-coral">
											{item.target_price_low ? formatCurrency(item.target_price_low, item.currency) : '-'}
										</td>
										<td class="py-3 pr-4 text-[var(--color-text-secondary)] text-xs max-w-[200px] truncate">
											{item.notes || '-'}
										</td>
										<td class="py-3 text-right text-[var(--color-text-tertiary)]">
											{formatDate(item.added_at)}
										</td>
									</tr>
								{/each}
							</tbody>
						</table>
					</div>
				{/if}

			{:else if activeTab === 'transactions'}
				{#if transactions.length === 0}
					<div class="text-center py-12 text-[var(--color-text-secondary)]">
						<p>No transactions yet.</p>
					</div>
				{:else}
					<div class="overflow-x-auto">
						<table class="w-full text-sm">
							<thead>
								<tr class="text-left text-[var(--color-text-tertiary)] border-b border-[var(--color-border)]">
									<th class="py-2 pr-4 font-medium">Date</th>
									<th class="py-2 pr-4 font-medium">Type</th>
									<th class="py-2 pr-4 font-medium">Asset</th>
									<th class="py-2 pr-4 font-medium text-right">Quantity</th>
									<th class="py-2 pr-4 font-medium text-right">Price</th>
									<th class="py-2 pr-4 font-medium text-right">Total</th>
									<th class="py-2 font-medium text-right">Fees</th>
									<th class="py-2 w-8"></th>
								</tr>
							</thead>
							<tbody>
								{#each transactions as tx}
									<tr class="border-b border-[var(--color-border)]/50 hover:bg-[var(--color-elevated)]/50 transition-colors group">
										<td class="py-3 pr-4 text-[var(--color-text-secondary)]">{formatDate(tx.transacted_at)}</td>
										<td class="py-3 pr-4">
											<span class="text-xs font-medium {txTypeColor(tx.type)}">{txTypeLabel(tx.type)}</span>
										</td>
										<td class="py-3 pr-4">
											<span class="text-[var(--color-text-primary)]">{tx.symbol}</span>
										</td>
										<td class="py-3 pr-4 text-right font-mono text-[var(--color-text-primary)]">
											{tx.quantity}
										</td>
										<td class="py-3 pr-4 text-right font-mono text-[var(--color-text-secondary)]">
											{formatCurrency(tx.price_per_unit, tx.currency)}
										</td>
										<td class="py-3 pr-4 text-right font-mono text-[var(--color-text-primary)]">
											{formatCurrency(tx.quantity * tx.price_per_unit, tx.currency)}
										</td>
										<td class="py-3 pr-4 text-right font-mono text-[var(--color-text-tertiary)]">
											{tx.fees > 0 ? formatCurrency(tx.fees, tx.currency) : '-'}
										</td>
										<td class="py-3 text-right">
											{#if showDeleteConfirm === tx.id}
												<div class="flex items-center gap-1">
													<button
														onclick={() => deleteTransaction(tx.id)}
														disabled={isDeleting}
														class="text-xs px-2 py-1 rounded bg-red-500/20 text-red-400 hover:bg-red-500/30 transition-colors"
													>
														{isDeleting ? '...' : 'Delete'}
													</button>
													<button
														onclick={() => showDeleteConfirm = null}
														class="text-xs px-2 py-1 rounded text-[var(--color-text-tertiary)] hover:text-[var(--color-text-primary)]"
													>
														Cancel
													</button>
												</div>
											{:else if activePortfolio?.role !== 'viewer'}
												<button
													onclick={() => showDeleteConfirm = tx.id}
													class="opacity-0 group-hover:opacity-100 text-[var(--color-text-tertiary)] hover:text-red-400 transition-all p-1"
													title="Delete transaction"
												>
													<svg class="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24" stroke-width="1.5">
														<path stroke-linecap="round" stroke-linejoin="round" d="M19 7l-.867 12.142A2 2 0 0116.138 21H7.862a2 2 0 01-1.995-1.858L5 7m5 4v6m4-6v6m1-10V4a1 1 0 00-1-1h-4a1 1 0 00-1 1v3M4 7h16" />
													</svg>
												</button>
											{/if}
										</td>
									</tr>
									{#if tx.notes}
										<tr class="border-b border-[var(--color-border)]/50">
											<td colspan="8" class="py-1 px-4 text-xs text-[var(--color-text-tertiary)] italic">{tx.notes}</td>
										</tr>
									{/if}
								{/each}
							</tbody>
						</table>
					</div>
				{/if}
			{/if}
		</div>
	{/if}
</div>

<!-- Create Portfolio Modal -->
{#if showCreatePortfolio}
	<!-- svelte-ignore a11y_no_static_element_interactions -->
	<div
		class="fixed inset-0 bg-black/60 z-50 flex items-center justify-center p-4"
		onclick={(e) => { if (e.target === e.currentTarget) showCreatePortfolio = false; }}
		onkeydown={(e) => { if (e.key === 'Escape') showCreatePortfolio = false; }}
	>
		<div class="bg-[var(--color-surface)] rounded-2xl border border-[var(--color-border)] p-6 w-full max-w-md">
			<h2 class="text-lg font-semibold text-[var(--color-text-emphasis)] mb-4">Create Portfolio</h2>

			<div class="flex flex-col gap-4">
				<div>
					<label class="block text-sm text-[var(--color-text-secondary)] mb-1" for="pf-name">Name</label>
					<input
						id="pf-name"
						type="text"
						bind:value={newPortfolioName}
						placeholder="e.g. Personal, Shared with Alex"
						class="w-full px-3 py-2 rounded-lg bg-[var(--color-bg)] border border-[var(--color-border)] text-[var(--color-text-primary)] text-sm focus:outline-none focus:border-aurum/50"
					/>
				</div>
				<div class="grid grid-cols-2 gap-3">
					<div>
						<label class="block text-sm text-[var(--color-text-secondary)] mb-1" for="pf-curr">Currency</label>
						<select
							id="pf-curr"
							bind:value={newPortfolioCurrency}
							class="w-full px-3 py-2 rounded-lg bg-[var(--color-bg)] border border-[var(--color-border)] text-[var(--color-text-primary)] text-sm focus:outline-none focus:border-aurum/50"
						>
							<option value="EUR">EUR</option>
							<option value="USD">USD</option>
							<option value="GBP">GBP</option>
							<option value="CHF">CHF</option>
							<option value="INR">INR</option>
						</select>
					</div>
					<div>
						<label class="block text-sm text-[var(--color-text-secondary)] mb-1" for="pf-type">Type</label>
						<select
							id="pf-type"
							bind:value={newPortfolioType}
							class="w-full px-3 py-2 rounded-lg bg-[var(--color-bg)] border border-[var(--color-border)] text-[var(--color-text-primary)] text-sm focus:outline-none focus:border-aurum/50"
						>
							<option value="personal">Personal</option>
							<option value="shared">Shared</option>
						</select>
					</div>
				</div>
			</div>

			<div class="flex justify-end gap-2 mt-6">
				<button
					onclick={() => showCreatePortfolio = false}
					class="px-4 py-2 text-sm text-[var(--color-text-secondary)] hover:text-[var(--color-text-primary)] transition-colors"
				>
					Cancel
				</button>
				<button
					onclick={createPortfolio}
					disabled={!newPortfolioName.trim() || creatingPortfolio}
					class="px-4 py-2 text-sm rounded-lg bg-aurum/15 text-aurum hover:bg-aurum/25 transition-colors font-medium disabled:opacity-50"
				>
					{creatingPortfolio ? 'Creating...' : 'Create'}
				</button>
			</div>
		</div>
	</div>
{/if}

<!-- Add Transaction Modal -->
{#if showAddTx && activePortfolio}
	<!-- svelte-ignore a11y_no_static_element_interactions -->
	<div
		class="fixed inset-0 bg-black/60 z-50 flex items-center justify-center p-4"
		onclick={(e) => { if (e.target === e.currentTarget) showAddTx = false; }}
		onkeydown={(e) => { if (e.key === 'Escape') showAddTx = false; }}
	>
		<div class="bg-[var(--color-surface)] rounded-2xl border border-[var(--color-border)] p-6 w-full max-w-lg max-h-[90vh] overflow-y-auto">
			<h2 class="text-lg font-semibold text-[var(--color-text-emphasis)] mb-4">
				Add Transaction — {activePortfolio.name}
			</h2>

			{#if txError}
				<div class="mb-4 px-3 py-2 rounded-lg bg-red-500/10 text-red-400 text-sm">{txError}</div>
			{/if}

			<div class="flex flex-col gap-4">
				<!-- Transaction type -->
				<div>
					<label class="block text-sm text-[var(--color-text-secondary)] mb-1">Type</label>
					<div class="flex flex-wrap gap-1">
						{#each ['buy', 'sell', 'dividend', 'staking_reward', 'transfer_in', 'transfer_out'] as t}
							<button
								onclick={() => txForm.type = t}
								class="px-3 py-1.5 text-xs rounded-lg transition-colors {txForm.type === t
									? 'bg-aurum/15 text-aurum font-medium'
									: 'text-[var(--color-text-secondary)] hover:text-[var(--color-text-primary)] bg-[var(--color-bg)]'}"
							>
								{txTypeLabel(t)}
							</button>
						{/each}
					</div>
				</div>

				<!-- Asset info -->
				<div class="grid grid-cols-2 gap-3">
					<div>
						<label class="block text-sm text-[var(--color-text-secondary)] mb-1" for="tx-symbol">Symbol</label>
						<input id="tx-symbol" type="text" bind:value={txForm.symbol} placeholder="NVDA, BTC, EUR..."
							class="w-full px-3 py-2 rounded-lg bg-[var(--color-bg)] border border-[var(--color-border)] text-[var(--color-text-primary)] text-sm focus:outline-none focus:border-aurum/50" />
					</div>
					<div>
						<label class="block text-sm text-[var(--color-text-secondary)] mb-1" for="tx-name">Asset Name</label>
						<input id="tx-name" type="text" bind:value={txForm.assetName} placeholder="NVIDIA Corp..."
							class="w-full px-3 py-2 rounded-lg bg-[var(--color-bg)] border border-[var(--color-border)] text-[var(--color-text-primary)] text-sm focus:outline-none focus:border-aurum/50" />
					</div>
				</div>

				<div class="grid grid-cols-3 gap-3">
					<div>
						<label class="block text-sm text-[var(--color-text-secondary)] mb-1" for="tx-asset-type">Asset Type</label>
						<select id="tx-asset-type" bind:value={txForm.assetType}
							onchange={(e) => { const t = (e.target as HTMLSelectElement).value; txForm.priceSource = defaultPriceSource[t] || 'manual'; }}
							class="w-full px-3 py-2 rounded-lg bg-[var(--color-bg)] border border-[var(--color-border)] text-[var(--color-text-primary)] text-sm focus:outline-none focus:border-aurum/50">
							<option value="stock">Stock</option>
							<option value="etf">ETF</option>
							<option value="crypto">Crypto</option>
							<option value="commodity">Commodity</option>
							<option value="cash">Cash</option>
							<option value="prediction">Prediction</option>
							<option value="other">Other</option>
						</select>
					</div>
					<div>
						<label class="block text-sm text-[var(--color-text-secondary)] mb-1" for="tx-price-source">Price Source</label>
						<select id="tx-price-source" bind:value={txForm.priceSource}
							class="w-full px-3 py-2 rounded-lg bg-[var(--color-bg)] border border-[var(--color-border)] text-[var(--color-text-primary)] text-sm focus:outline-none focus:border-aurum/50">
							<option value="yahoo">Yahoo Finance</option>
							<option value="coingecko">CoinGecko</option>
							<option value="polymarket">Polymarket</option>
							<option value="metal_api">Metal API</option>
							<option value="fx">FX Rate</option>
							<option value="manual">Manual</option>
						</select>
					</div>
					<div>
						<label class="block text-sm text-[var(--color-text-secondary)] mb-1" for="tx-exchange">Exchange</label>
						<input id="tx-exchange" type="text" bind:value={txForm.exchange} placeholder="NASDAQ, XETRA..."
							class="w-full px-3 py-2 rounded-lg bg-[var(--color-bg)] border border-[var(--color-border)] text-[var(--color-text-primary)] text-sm focus:outline-none focus:border-aurum/50" />
					</div>
				</div>

				<!-- Quantity & Price -->
				<div class="grid grid-cols-3 gap-3">
					<div>
						<label class="block text-sm text-[var(--color-text-secondary)] mb-1" for="tx-qty">Quantity</label>
						<input id="tx-qty" type="number" step="any" bind:value={txForm.quantity} placeholder="100"
							class="w-full px-3 py-2 rounded-lg bg-[var(--color-bg)] border border-[var(--color-border)] text-[var(--color-text-primary)] text-sm focus:outline-none focus:border-aurum/50 font-mono" />
					</div>
					<div>
						<label class="block text-sm text-[var(--color-text-secondary)] mb-1" for="tx-price">Price / Unit</label>
						<input id="tx-price" type="number" step="any" bind:value={txForm.pricePerUnit} placeholder="120.50"
							class="w-full px-3 py-2 rounded-lg bg-[var(--color-bg)] border border-[var(--color-border)] text-[var(--color-text-primary)] text-sm focus:outline-none focus:border-aurum/50 font-mono" />
					</div>
					<div>
						<label class="block text-sm text-[var(--color-text-secondary)] mb-1" for="tx-currency">Currency</label>
						<select id="tx-currency" bind:value={txForm.currency}
							class="w-full px-3 py-2 rounded-lg bg-[var(--color-bg)] border border-[var(--color-border)] text-[var(--color-text-primary)] text-sm focus:outline-none focus:border-aurum/50">
							<option value="EUR">EUR</option>
							<option value="USD">USD</option>
							<option value="GBP">GBP</option>
							<option value="CHF">CHF</option>
							<option value="INR">INR</option>
						</select>
					</div>
				</div>

				<!-- FX & Fees -->
				<div class="grid grid-cols-3 gap-3">
					<div>
						<label class="block text-sm text-[var(--color-text-secondary)] mb-1" for="tx-fx">FX Rate to {activePortfolio.base_currency}</label>
						<input id="tx-fx" type="number" step="any" bind:value={txForm.exchangeRate} placeholder="1.0"
							class="w-full px-3 py-2 rounded-lg bg-[var(--color-bg)] border border-[var(--color-border)] text-[var(--color-text-primary)] text-sm focus:outline-none focus:border-aurum/50 font-mono" />
					</div>
					<div>
						<label class="block text-sm text-[var(--color-text-secondary)] mb-1" for="tx-fees">Fees</label>
						<input id="tx-fees" type="number" step="any" bind:value={txForm.fees} placeholder="0"
							class="w-full px-3 py-2 rounded-lg bg-[var(--color-bg)] border border-[var(--color-border)] text-[var(--color-text-primary)] text-sm focus:outline-none focus:border-aurum/50 font-mono" />
					</div>
					<div>
						<label class="block text-sm text-[var(--color-text-secondary)] mb-1" for="tx-date">Date</label>
						<input id="tx-date" type="date" bind:value={txForm.date}
							class="w-full px-3 py-2 rounded-lg bg-[var(--color-bg)] border border-[var(--color-border)] text-[var(--color-text-primary)] text-sm focus:outline-none focus:border-aurum/50" />
					</div>
				</div>

				<!-- Lookup ID (optional) -->
				<div>
					<label class="block text-sm text-[var(--color-text-secondary)] mb-1" for="tx-lookup">Lookup ID <span class="text-[var(--color-text-tertiary)]">(optional — CoinGecko slug, Yahoo symbol)</span></label>
					<input id="tx-lookup" type="text" bind:value={txForm.lookupId} placeholder="nvidia, bitcoin..."
						class="w-full px-3 py-2 rounded-lg bg-[var(--color-bg)] border border-[var(--color-border)] text-[var(--color-text-primary)] text-sm focus:outline-none focus:border-aurum/50" />
				</div>

				<!-- Notes -->
				<div>
					<label class="block text-sm text-[var(--color-text-secondary)] mb-1" for="tx-notes">Notes</label>
					<input id="tx-notes" type="text" bind:value={txForm.notes} placeholder="Broker, reason, context..."
						class="w-full px-3 py-2 rounded-lg bg-[var(--color-bg)] border border-[var(--color-border)] text-[var(--color-text-primary)] text-sm focus:outline-none focus:border-aurum/50" />
				</div>
			</div>

			<div class="flex justify-end gap-2 mt-6">
				<button
					onclick={() => showAddTx = false}
					class="px-4 py-2 text-sm text-[var(--color-text-secondary)] hover:text-[var(--color-text-primary)] transition-colors"
				>
					Cancel
				</button>
				<button
					onclick={addTransaction}
					disabled={!txForm.symbol || !txForm.assetName || savingTx}
					class="px-4 py-2 text-sm rounded-lg bg-aurum/15 text-aurum hover:bg-aurum/25 transition-colors font-medium disabled:opacity-50"
				>
					{savingTx ? 'Saving...' : 'Add Transaction'}
				</button>
			</div>
		</div>
	</div>
{/if}

<style>
	.wealth-page {
		min-height: 0;
	}
</style>
