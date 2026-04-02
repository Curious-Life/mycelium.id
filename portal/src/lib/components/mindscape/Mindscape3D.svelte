<script lang="ts">
	import { onMount, onDestroy } from 'svelte';
	import * as THREE from 'three';
	import { OrbitControls } from 'three/addons/controls/OrbitControls.js';
	import { mindscapeState, visibleContacts, CLUSTER_COLORS, NOISE_COLOR, type MindscapePoint, type Contact } from '$lib/stores/mindscape';
	import { theme } from '$lib/stores/theme';

	const SCENE_SCALE = 8;
	const POINT_SIZE = 0.18;
	const CONTACT_SIZE = 0.9;
	const CONTACT_COLOR = '#E5B84C'; // Aurum/Gold — brand color

	let container: HTMLDivElement;
	let scene: THREE.Scene;
	let camera: THREE.PerspectiveCamera;
	let renderer: THREE.WebGLRenderer;
	let controls: OrbitControls;
	let pointCloud: THREE.Points;
	let contactCloud: THREE.Points;
	let contactEdges: THREE.LineSegments;
	let contactLabels: THREE.Group;
	let raycaster: THREE.Raycaster;
	let mouse = new THREE.Vector2();
	let animationId: number;
	let resizeObserver: ResizeObserver;
	let contactPositions: Map<string, THREE.Vector3> = new Map();
	let coordScale = SCENE_SCALE; // updated by createPointCloud based on data range
	let showPoints = $state(true);

	// Tooltip state
	let tooltipVisible = $state(false);
	let tooltipX = $state(0);
	let tooltipY = $state(0);
	let tooltipData = $state<{ realm?: string; territory?: string; essence?: string; type?: string; date?: string } | null>(null);
	let hoveredIdx = -1;

	const msState = $derived($mindscapeState);

	const visiblePoints = $derived.by(() => {
		const points = msState.points;
		if (!points.length) return [];
		if (msState.selectedRealmId === null) return points;
		return points.filter(p => p.data.clusterId === msState.selectedRealmId);
	});

	function getClusterId(p: MindscapePoint): number {
		if (msState.selectedTerritoryId !== null) {
			return p.data.cluster3d === msState.selectedTerritoryId ? (p.data.cluster3d ?? -1) : -1;
		}
		if (msState.selectedRealmId !== null) return p.data.cluster3d ?? -1;
		return p.data.clusterId ?? -1;
	}

	function getColor(id: number): string {
		if (id === -1 || id === null || id === undefined) return NOISE_COLOR;
		return CLUSTER_COLORS[id % CLUSTER_COLORS.length];
	}

	function getDataBounds(arr: number[]) {
		let min = Infinity, max = -Infinity;
		for (const v of arr) { if (v < min) min = v; if (v > max) max = v; }
		return { min: min === Infinity ? 0 : min, max: max === -Infinity ? 0 : max };
	}

	function getBgColor(): string {
		const style = getComputedStyle(document.documentElement);
		return style.getPropertyValue('--color-bg').trim() || '#0A0A0C';
	}

	function initThree() {
		if (!container) return;
		scene = new THREE.Scene();
		scene.background = new THREE.Color(getBgColor());

		camera = new THREE.PerspectiveCamera(60, container.clientWidth / container.clientHeight, 0.1, 1000);
		camera.position.set(30, 20, 30);

		renderer = new THREE.WebGLRenderer({ antialias: true });
		renderer.setSize(container.clientWidth, container.clientHeight);
		renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));
		container.appendChild(renderer.domElement);

		controls = new OrbitControls(camera, renderer.domElement);
		controls.enableDamping = true;
		controls.dampingFactor = 0.05;
		controls.minDistance = 5;
		controls.maxDistance = 100;

		raycaster = new THREE.Raycaster();
		raycaster.params.Points = { threshold: 0.3 };

		const ambient = new THREE.AmbientLight(0xffffff, 0.6);
		const directional = new THREE.DirectionalLight(0xffffff, 0.4);
		directional.position.set(10, 10, 10);
		scene.add(ambient, directional);

		renderer.domElement.addEventListener('mousemove', handleMouseMove);
		renderer.domElement.addEventListener('click', handleClick);
		resizeObserver = new ResizeObserver(handleResize);
		resizeObserver.observe(container);
	}

	function createPointCloud() {
		if (pointCloud) scene.remove(pointCloud);
		const nodes = visiblePoints;
		if (!nodes.length) return;

		const xs = nodes.map(p => p.data.position3d.x);
		const ys = nodes.map(p => p.data.position3d.y);
		const zs = nodes.map(p => p.data.position3d.z);
		const bx = getDataBounds(xs);
		const by = getDataBounds(ys);
		const bz = getDataBounds(zs);
		// Scale so the largest axis span maps to ~60 units, preserving natural shape
		const maxSpan = Math.max(bx.max - bx.min, by.max - by.min, bz.max - bz.min) || 1;
		const scale = 60 / maxSpan;
		coordScale = scale;

		const positions = new Float32Array(nodes.length * 3);
		const colors = new Float32Array(nodes.length * 3);

		for (let i = 0; i < nodes.length; i++) {
			const p = nodes[i];
			const cx = p.data.position3d.x * scale;
			const cy = p.data.position3d.z * scale;
			const cz = p.data.position3d.y * scale;

			positions[i * 3] = cx;
			positions[i * 3 + 1] = cy;
			positions[i * 3 + 2] = cz;

			const cid = getClusterId(p);
			const isNoise = cid === -1;
			const isHighlighted =
				(msState.hoveredRealmId !== null && p.data.clusterId === msState.hoveredRealmId) ||
				(msState.hoveredTerritoryId !== null && p.data.cluster3d === msState.hoveredTerritoryId) ||
				(msState.selectedTerritoryId !== null && p.data.cluster3d === msState.selectedTerritoryId);
			const isFaded = msState.selectedTerritoryId !== null && !isHighlighted;

			const color = new THREE.Color(getColor(cid));
			let mult = 1;
			if (isNoise) mult = 0.3;
			else if (isHighlighted) mult = 1.3;
			else if (isFaded) mult = 0.25;

			colors[i * 3] = Math.min(1, color.r * mult);
			colors[i * 3 + 1] = Math.min(1, color.g * mult);
			colors[i * 3 + 2] = Math.min(1, color.b * mult);
		}

		const geometry = new THREE.BufferGeometry();
		geometry.setAttribute('position', new THREE.BufferAttribute(positions, 3));
		geometry.setAttribute('color', new THREE.BufferAttribute(colors, 3));

		const material = new THREE.PointsMaterial({
			size: POINT_SIZE,
			vertexColors: true,
			transparent: true,
			opacity: 0.85,
			sizeAttenuation: true,
		});

		pointCloud = new THREE.Points(geometry, material);
		pointCloud.visible = showPoints;
		scene.add(pointCloud);
	}

	function createSocialLayer() {
		// Remove existing social objects
		if (contactCloud) scene.remove(contactCloud);
		if (contactEdges) scene.remove(contactEdges);
		if (contactLabels) scene.remove(contactLabels);
		contactPositions.clear();

		const contacts = $visibleContacts;
		if (!contacts.length) return;

		// Compute contact positions: weighted average of territory centroids,
		// or random scatter for contacts without linked territories
		const positions = new Float32Array(contacts.length * 3);
		const colors = new Float32Array(contacts.length * 3);
		const edgePositions: number[] = [];
		const tierSizes: Record<string, number> = {
			inner: 1.0, engaged: 0.7, acknowledged: 0.5, connected: 0.3, noise: 0.2,
		};

		// Compute scene center from point cloud for fallback positioning
		let cx = 0, cy = 0, cz = 0;
		const pts = visiblePoints;
		if (pts.length > 0) {
			for (const p of pts) {
				cx += p.data.position3d.x; cy += p.data.position3d.z; cz += p.data.position3d.y;
			}
			cx = (cx / pts.length) * coordScale;
			cy = (cy / pts.length) * coordScale;
			cz = (cz / pts.length) * coordScale;
		}

		for (let i = 0; i < contacts.length; i++) {
			const c = contacts[i];
			let wx = 0, wy = 0, wz = 0, totalWeight = 0;

			for (const t of c.territories) {
				if (!t.centroid_3d) continue;
				const w = t.strength || 0.5;
				wx += t.centroid_3d[0] * coordScale * w;
				wy += t.centroid_3d[2] * coordScale * w;
				wz += t.centroid_3d[1] * coordScale * w;
				totalWeight += w;
			}

			if (totalWeight > 0) {
				wx /= totalWeight;
				wy /= totalWeight;
				wz /= totalWeight;
			} else {
				// No linked territory — scatter around scene center
				const r = 15 + Math.random() * 20;
				const theta = Math.random() * Math.PI * 2;
				const phi = Math.acos(2 * Math.random() - 1);
				wx = cx + r * Math.sin(phi) * Math.cos(theta);
				wy = cy + r * Math.sin(phi) * Math.sin(theta);
				wz = cz + r * Math.cos(phi);
			}

			// Small jitter to prevent overlap
			wx += (Math.random() - 0.5) * 1.5;
			wy += (Math.random() - 0.5) * 1.5;
			wz += (Math.random() - 0.5) * 1.5;

			positions[i * 3] = wx;
			positions[i * 3 + 1] = wy;
			positions[i * 3 + 2] = wz;

			const pos = new THREE.Vector3(wx, wy, wz);
			contactPositions.set(c.id, pos);

			// Color: gold with brightness based on tier
			const color = new THREE.Color(CONTACT_COLOR);
			const mult = tierSizes[c.tier] || 0.5;
			colors[i * 3] = Math.min(1, color.r * mult);
			colors[i * 3 + 1] = Math.min(1, color.g * mult);
			colors[i * 3 + 2] = Math.min(1, color.b * mult);

			// Edges: lines from contact to each linked territory centroid
			for (const t of c.territories) {
				if (!t.centroid_3d) continue;
				edgePositions.push(
					wx, wy, wz,
					t.centroid_3d[0] * coordScale,
					t.centroid_3d[2] * coordScale,
					t.centroid_3d[1] * coordScale,
				);
			}
		}

		// Contact particles
		const contactGeo = new THREE.BufferGeometry();
		contactGeo.setAttribute('position', new THREE.BufferAttribute(positions, 3));
		contactGeo.setAttribute('color', new THREE.BufferAttribute(colors, 3));

		const contactMat = new THREE.PointsMaterial({
			size: CONTACT_SIZE,
			vertexColors: true,
			transparent: true,
			opacity: 0.95,
			sizeAttenuation: true,
		});

		contactCloud = new THREE.Points(contactGeo, contactMat);
		scene.add(contactCloud);
		renderedContacts = contacts;

		// Edge lines
		if (edgePositions.length > 0) {
			const edgeGeo = new THREE.BufferGeometry();
			edgeGeo.setAttribute('position', new THREE.Float32BufferAttribute(edgePositions, 3));

			const edgeMat = new THREE.LineBasicMaterial({
				color: new THREE.Color(CONTACT_COLOR),
				transparent: true,
				opacity: 0.15,
			});

			contactEdges = new THREE.LineSegments(edgeGeo, edgeMat);
			scene.add(contactEdges);
		}
	}

	function animateCameraToVisiblePoints(duration = 400) {
		const nodes = visiblePoints;
		if (!nodes.length) return;

		let sx = 0, sy = 0, sz = 0;
		for (const p of nodes) {
			sx += p.data.position3d.x * coordScale;
			sy += p.data.position3d.z * coordScale;
			sz += p.data.position3d.y * coordScale;
		}
		const tx = sx / nodes.length;
		const ty = sy / nodes.length;
		const tz = sz / nodes.length;

		let maxDist = 0;
		for (const p of nodes) {
			const dx = p.data.position3d.x * coordScale - tx;
			const dy = p.data.position3d.z * coordScale - ty;
			const dz = p.data.position3d.y * coordScale - tz;
			maxDist = Math.max(maxDist, Math.sqrt(dx * dx + dy * dy + dz * dz));
		}

		const camDist = Math.max(maxDist * 2, 15);
		const endPos = new THREE.Vector3(tx + camDist * 0.7, ty + camDist * 0.5, tz + camDist * 0.7);
		const endTarget = new THREE.Vector3(tx, ty, tz);
		const startPos = camera.position.clone();
		const startTarget = controls.target.clone();
		const startTime = performance.now();

		function animate() {
			const elapsed = performance.now() - startTime;
			const t = Math.min(1, elapsed / duration);
			const ease = 1 - Math.pow(1 - t, 3);
			camera.position.lerpVectors(startPos, endPos, ease);
			controls.target.lerpVectors(startTarget, endTarget, ease);
			controls.update();
			if (t < 1) requestAnimationFrame(animate);
		}
		animate();
	}

	// Ordered list of contacts matching the contact cloud indices (set by createSocialLayer)
	let renderedContacts: typeof $visibleContacts = [];

	function handleMouseMove(event: MouseEvent) {
		const rect = container.getBoundingClientRect();
		mouse.x = ((event.clientX - rect.left) / rect.width) * 2 - 1;
		mouse.y = -((event.clientY - rect.top) / rect.height) * 2 + 1;

		raycaster.setFromCamera(mouse, camera);
		const tipX = event.clientX - rect.left + 12;
		const tipY = event.clientY - rect.top - 10;

		// Check contacts first (they're on top visually)
		if (contactCloud && contactCloud.visible && renderedContacts.length > 0) {
			const hits = raycaster.intersectObject(contactCloud);
			if (hits.length > 0 && hits[0].index != null && hits[0].index < renderedContacts.length) {
				const c = renderedContacts[hits[0].index];
				tooltipData = {
					territory: c.name || 'Unknown',
					essence: [c.position, c.company].filter(Boolean).join(' · ') || undefined,
					type: c.tier,
					date: c.connected_at ? new Date(c.connected_at).toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' }) : undefined,
				};
				tooltipX = tipX;
				tooltipY = tipY;
				tooltipVisible = true;
				hoveredIdx = -1;
				return;
			}
		}

		// Then check clustering points
		if (pointCloud && pointCloud.visible) {
			const intersects = raycaster.intersectObject(pointCloud);
			if (intersects.length > 0 && intersects[0].index != null) {
				const idx = intersects[0].index;
				if (idx !== hoveredIdx && idx < visiblePoints.length) {
					hoveredIdx = idx;
					const p = visiblePoints[idx];
					const realmId = p.data.clusterId;
					const territoryId = p.data.cluster3d;
					const realm = realmId != null && realmId >= 0 ? msState.realms[realmId] : null;
					const territory = territoryId != null && territoryId >= 0 ? msState.territories[territoryId] : null;
					tooltipData = {
						realm: realm?.name ?? (realmId === -1 ? 'Noise' : `Realm ${realmId}`),
						territory: territory?.name ?? (territoryId === -1 ? 'Unclustered' : `Territory ${territoryId}`),
						essence: territory?.essence || realm?.essence || undefined,
						type: p.data.type,
						date: p.data.timestamp ? new Date(p.data.timestamp).toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' }) : undefined,
					};
				}
				tooltipX = tipX;
				tooltipY = tipY;
				tooltipVisible = true;
				return;
			}
		}

		tooltipVisible = false;
		hoveredIdx = -1;
	}

	function handleClick() {
		if (!pointCloud) return;
		raycaster.setFromCamera(mouse, camera);
		const intersects = raycaster.intersectObject(pointCloud);
		if (intersects.length > 0) {
			const idx = intersects[0].index;
			if (idx != null && idx < visiblePoints.length) {
				const p = visiblePoints[idx];
				if (msState.selectedRealmId === null) {
					const realmId = p.data.clusterId;
					if (realmId !== -1 && realmId != null) mindscapeState.drillIntoRealm(realmId);
				} else if (msState.selectedTerritoryId === null) {
					const territoryId = p.data.cluster3d;
					if (territoryId !== -1 && territoryId != null) mindscapeState.selectTerritory(territoryId);
				}
			}
		}
	}

	function handleResize() {
		if (!container || !renderer || !camera) return;
		camera.aspect = container.clientWidth / container.clientHeight;
		camera.updateProjectionMatrix();
		renderer.setSize(container.clientWidth, container.clientHeight);
	}

	function renderLoop() {
		animationId = requestAnimationFrame(renderLoop);
		controls.update();
		renderer.render(scene, camera);
	}

	// Update scene background when theme changes
	const currentTheme = $derived($theme);
	$effect(() => {
		// Track the theme to re-run when it changes
		currentTheme;
		if (scene) {
			scene.background = new THREE.Color(getBgColor());
		}
	});

	function togglePoints() {
		showPoints = !showPoints;
		if (pointCloud) pointCloud.visible = showPoints;
	}

	let prevPointCount = 0;
	let prevRealm: number | null = null;
	let prevTerritory: number | null = null;

	$effect(() => {
		const pts = visiblePoints;
		const realm = msState.selectedRealmId;
		const territory = msState.selectedTerritoryId;

		if (!scene) return;

		const isDrilldown = realm !== prevRealm || territory !== prevTerritory;
		const dataChanged = pts.length !== prevPointCount;

		if (isDrilldown || dataChanged) {
			createPointCloud();
			createSocialLayer();
			if ((isDrilldown || (dataChanged && prevPointCount === 0)) && pts.length > 0) {
				setTimeout(() => animateCameraToVisiblePoints(400), 50);
			}
			prevPointCount = pts.length;
			prevRealm = realm;
			prevTerritory = territory;
		}
	});

	// Re-render social layer when visible contacts change
	const contactsSnapshot = $derived($visibleContacts.length + (msState.showSocialLayer ? 1 : 0));
	let prevContactsSnapshot = 0;
	$effect(() => {
		if (scene && contactsSnapshot !== prevContactsSnapshot) {
			createSocialLayer();
			prevContactsSnapshot = contactsSnapshot;
		}
	});

	onMount(async () => {
		await mindscapeState.load();
		initThree();
		createPointCloud();
		renderLoop();
	});

	onDestroy(() => {
		if (animationId) cancelAnimationFrame(animationId);
		if (renderer) {
			renderer.domElement.removeEventListener('mousemove', handleMouseMove);
			renderer.domElement.removeEventListener('click', handleClick);
			renderer.dispose();
		}
		if (resizeObserver) resizeObserver.disconnect();
	});
</script>

<div class="relative w-full h-full">
	<div bind:this={container} class="w-full h-full"></div>

	<!-- Breadcrumb nav -->
	<div class="absolute top-4 left-4 flex items-center gap-2">
		{#if msState.selectedRealmId !== null}
			<button
				onclick={() => {
					if (msState.selectedTerritoryId !== null) {
						mindscapeState.selectTerritory(null);
					} else {
						mindscapeState.goBack();
					}
				}}
				class="btn-ghost text-xs px-3 py-1.5 rounded-md bg-[var(--color-surface)]/80 backdrop-blur-sm border border-[var(--color-border)]"
			>
				&larr; Back
			</button>
		{/if}
		<span class="text-xs text-[var(--color-text-tertiary)] bg-[var(--color-surface)]/80 backdrop-blur-sm px-2 py-1 rounded">
			{#if msState.selectedRealmId === null}
				All Realms
			{:else}
				{@const realm = msState.realms[msState.selectedRealmId]}
				{realm?.name || `Realm ${msState.selectedRealmId}`}
				{#if msState.selectedTerritoryId !== null}
					{@const territory = msState.territories[msState.selectedTerritoryId]}
					&gt; {territory?.name || `Territory ${msState.selectedTerritoryId}`}
				{/if}
			{/if}
		</span>
	</div>

	<!-- Loading overlay -->
	{#if msState.loading}
		<div class="absolute inset-0 flex items-center justify-center bg-[var(--color-bg)]/80">
			<div class="text-[var(--color-text-tertiary)] text-sm animate-pulse">Loading Mindscape...</div>
		</div>
	{/if}

	<!-- Empty state -->
	{#if !msState.loading && msState.points.length === 0}
		<div class="absolute inset-0 flex items-center justify-center">
			<div class="text-center">
				<p class="text-[var(--color-text-tertiary)] text-sm">No clustering data yet</p>
				<p class="text-[var(--color-text-tertiary)] text-xs mt-1">Send more messages to build your Mindscape</p>
			</div>
		</div>
	{/if}

	<!-- Stats badge -->
	{#if msState.meta && !msState.loading}
		<div class="absolute bottom-4 left-4 text-[0.65rem] text-[var(--color-text-tertiary)] bg-[var(--color-surface)]/80 backdrop-blur-sm px-2.5 py-1 rounded border border-[var(--color-border)]">
			{msState.meta.total.toLocaleString()} points &middot;
			{Object.keys(msState.realms).length} realms &middot;
			{Object.keys(msState.territories).length} territories
			{#if $visibleContacts.length > 0}
				&middot; {$visibleContacts.length} contacts
			{/if}
		</div>
	{/if}

	<!-- Layer controls -->
	<div class="absolute bottom-4 right-4 bg-[var(--color-surface)]/90 backdrop-blur-sm rounded-lg border border-[var(--color-border)] p-2.5 min-w-[140px]">
		<div class="text-[0.55rem] uppercase tracking-wider text-[var(--color-text-tertiary)] mb-1.5 px-1">Layers</div>

		<!-- Points layer -->
		<button
			onclick={togglePoints}
			class="flex items-center gap-2 text-[0.65rem] px-1.5 py-1 rounded w-full transition-colors"
			class:text-[var(--color-text-primary)]={showPoints}
			class:text-[var(--color-text-tertiary)]={!showPoints}
			class:opacity-40={!showPoints}
		>
			<span class="w-2 h-2 rounded-full" style="background: {showPoints ? '#3B82F6' : 'var(--color-border)'}"></span>
			Points
			<span class="ml-auto text-[0.55rem] opacity-60">{visiblePoints.length.toLocaleString()}</span>
		</button>

		<!-- Contacts layer -->
		<button
			onclick={() => mindscapeState.toggleSocialLayer()}
			class="flex items-center gap-2 text-[0.65rem] px-1.5 py-1 rounded w-full transition-colors"
			class:text-[#E5B84C]={msState.showSocialLayer}
			class:text-[var(--color-text-tertiary)]={!msState.showSocialLayer}
			class:opacity-40={!msState.showSocialLayer}
		>
			<span class="w-2 h-2 rounded-full" style="background: {msState.showSocialLayer ? '#E5B84C' : 'var(--color-border)'}"></span>
			Contacts
			<span class="ml-auto text-[0.55rem] opacity-60">{msState.contacts.length}</span>
		</button>

		<!-- Tier filters (when contacts visible) -->
		{#if msState.showSocialLayer && msState.tiers.length > 0}
			<div class="flex flex-col gap-0.5 mt-1 pt-1 border-t border-[var(--color-border)] pl-4">
				{#each msState.tiers.filter(t => ['inner', 'engaged', 'acknowledged'].includes(t.tier)) as t}
					<button
						onclick={() => mindscapeState.toggleTier(t.tier)}
						class="flex items-center gap-1.5 text-[0.55rem] px-1 py-0.5 rounded w-full transition-colors"
						class:text-[var(--color-text-primary)]={msState.visibleTiers.has(t.tier)}
						class:text-[var(--color-text-tertiary)]={!msState.visibleTiers.has(t.tier)}
						class:opacity-40={!msState.visibleTiers.has(t.tier)}
					>
						<span class="w-1.5 h-1.5 rounded-full" style="background: {msState.visibleTiers.has(t.tier) ? '#E5B84C' : 'var(--color-border)'}"></span>
						{t.tier} ({t.count})
					</button>
				{/each}
			</div>
		{/if}
	</div>

	<!-- Point tooltip -->
	{#if tooltipVisible && tooltipData}
		<div
			class="absolute pointer-events-none z-50 bg-[var(--color-surface)]/95 backdrop-blur-sm border border-[var(--color-border)] rounded-lg px-3 py-2 shadow-lg max-w-[260px]"
			style="left: {tooltipX}px; top: {tooltipY}px; transform: translateY(-100%);"
		>
			{#if tooltipData.territory}
				<div class="text-[0.7rem] font-medium text-[var(--color-text-primary)] leading-tight">{tooltipData.territory}</div>
			{/if}
			{#if tooltipData.essence}
				<div class="text-[0.6rem] text-[var(--color-text-secondary)] leading-snug mt-0.5 line-clamp-2 italic">{tooltipData.essence}</div>
			{/if}
			<div class="flex items-center gap-2 mt-1 text-[0.55rem] text-[var(--color-text-tertiary)]">
				{#if tooltipData.realm}
					<span>{tooltipData.realm}</span>
				{/if}
				{#if tooltipData.type}
					<span class="capitalize">{tooltipData.type}</span>
				{/if}
				{#if tooltipData.date}
					<span>{tooltipData.date}</span>
				{/if}
			</div>
		</div>
	{/if}
</div>
