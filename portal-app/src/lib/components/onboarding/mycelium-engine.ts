// mycelium-engine — the mycelium.id hero animation (biologically-inspired hyphal
// network: slow growth, chemotropism, branching, anastomosis), ported verbatim
// from the landing page's #mycelium-canvas. Top-level classes (no nested-class
// perf cost); container-scoped; `start()` returns a stop() that cancels the RAF.

const PHI_INV = 0.6180339887;

const P = {
	curvJitter: 0.008, curvDecay: 0.97, curvMax: 0.022, angleJitter: 0.012,
	stepLenVar: 0.2,
	branchProb: 0.13, branchMinSpace: 7, branchAngleBase: 0.4, maxDepth: 22,
	childSpeedRatio: 0.95,
	dichotomyProb: 0.03, dichotomyMaxDepth: 8, dichotomySplay: PHI_INV * 0.18,
	anastProb: 0.18, anastRadius: 14, anastLineWidth: 0.35,
	hue: 34, hueVar: 8, sat: 18, light: 62,
	baseWidth: 0.55, baseAlpha: 0.32,
	seedLife: 1500, seedLifeVar: 200, seedSpeed: 0.28, seedSpeedVar: 0.06,
	chemoStrength: 0.095, chemoRadius: 65,
	seekRange: 35, seekStrength: 0.21,
	lateralProb: 0.022, lateralAngleVar: 0.4, maxTurnRate: 0.04,
};
const GRID_SIZE = 15;
const MAX_DEPTH = P.maxDepth;
const TARGET_ALIVE = 55;
const ANIM_CAP_MS = 120_000;

type GridPt = { x: number; y: number; c: number };

class Hypha {
	e: Engine;
	x: number; y: number; ox: number; oy: number; angle: number; targetAngle: number | null;
	curvature: number; speed: number; life: number; depth: number;
	dead = false; age = 0; lastBranch = 0; hue: number; gridAge = 0; colony: number; scout: boolean;
	constructor(e: Engine, x: number, y: number, angle: number, speed: number, life: number, depth: number, targetAngle?: number, colony?: number) {
		this.e = e; this.x = x; this.y = y; this.ox = x; this.oy = y; this.angle = angle;
		this.targetAngle = targetAngle !== undefined ? targetAngle : null;
		this.curvature = (e.rng() - 0.5) * 0.003; this.speed = speed; this.life = life;
		this.depth = depth; this.hue = P.hue + (e.rng() - 0.5) * P.hueVar;
		this.colony = colony !== undefined ? colony : e.nextColonyId++; this.scout = e.rng() < 0.4;
	}
	update() {
		if (this.dead) return;
		const e = this.e, rng = e.rng;
		this.age++; this.lastBranch++; this.gridAge++;
		if (this.targetAngle !== null && this.age < 30) {
			let diff = this.targetAngle - this.angle;
			while (diff > Math.PI) diff -= Math.PI * 2; while (diff < -Math.PI) diff += Math.PI * 2;
			this.angle += diff * 0.06;
		} else this.targetAngle = null;
		const angleStart = this.angle;
		this.curvature += (rng() - 0.5) * P.curvJitter; this.curvature *= P.curvDecay;
		this.curvature = Math.max(-P.curvMax, Math.min(P.curvMax, this.curvature));
		this.angle += this.curvature + (rng() - 0.5) * P.angleJitter;
		if (this.age > 20 && this.age % 8 === 0) {
			const ca = e.chemoGradient(this.x, this.y);
			if (ca !== 0) {
				let diff = ca - this.angle;
				while (diff > Math.PI) diff -= Math.PI * 2; while (diff < -Math.PI) diff += Math.PI * 2;
				this.angle += diff * (this.scout ? -P.chemoStrength * 1.5 : P.chemoStrength);
			}
		}
		const margin = 8; let edgeForce = 0;
		if (this.x < margin) edgeForce = (margin - this.x) / margin;
		else if (this.x > e.W - margin) edgeForce = (this.x - (e.W - margin)) / margin;
		if (this.y < margin) edgeForce = Math.max(edgeForce, (margin - this.y) / margin);
		else if (this.y > e.H - margin) edgeForce = Math.max(edgeForce, (this.y - (e.H - margin)) / margin);
		if (edgeForce > 0) {
			const toCenter = Math.atan2(e.H / 2 - this.y, e.W / 2 - this.x);
			let diff = toCenter - this.angle;
			while (diff > Math.PI) diff -= Math.PI * 2; while (diff < -Math.PI) diff += Math.PI * 2;
			this.angle += diff * 0.08 * edgeForce;
		}
		let totalTurn = this.angle - angleStart;
		while (totalTurn > Math.PI) totalTurn -= Math.PI * 2; while (totalTurn < -Math.PI) totalTurn += Math.PI * 2;
		if (Math.abs(totalTurn) > P.maxTurnRate) this.angle = angleStart + Math.sign(totalTurn) * P.maxTurnRate;
		if (this.life < 200 && this.depth > 1 && this.age % 4 === 0) {
			const target = e.findNearby(this.x, this.y, P.seekRange + this.depth * 4);
			if (target) {
				const seekAngle = Math.atan2(target.y - this.y, target.x - this.x);
				let diff = seekAngle - this.angle;
				while (diff > Math.PI) diff -= Math.PI * 2; while (diff < -Math.PI) diff += Math.PI * 2;
				this.angle += diff * P.seekStrength * ((200 - this.life) / 200);
			}
		}
		this.ox = this.x; this.oy = this.y;
		const sl = this.speed * (1 - P.stepLenVar / 2 + rng() * P.stepLenVar);
		this.x += Math.cos(this.angle) * sl; this.y += Math.sin(this.angle) * sl; this.life--;
		if (this.gridAge >= 3) { this.gridAge = 0; e.addToGrid(this.x, this.y, this.colony); }
		const _k = e.gridKey(this.x, this.y); const _localD = e.density[_k] || 0;
		if (this.age % 8 === 0) {
			if (_localD > 10) this.life -= (3 + this.depth * 2);
			else if (_localD > 4) this.life += 2;
			else if (_localD === 0) this.life += this.scout ? 3 : 1;
			else if (_localD < 2 && !this.scout && this.life > 100) this.life -= 1;
		}
		const depthFactor = Math.min(2.4, 1 + this.depth * 0.35);
		const minSpacing = Math.floor(P.branchMinSpace / depthFactor);
		if (_localD < 8 && this.lastBranch > minSpacing && this.depth < MAX_DEPTH && rng() < P.branchProb * depthFactor) {
			this.lastBranch = 0;
			const side = rng() > 0.5 ? 1 : -1;
			const ba = side * P.branchAngleBase * Math.pow(PHI_INV, this.depth * 0.15) * (0.7 + rng() * 0.6);
			const childSpeed = this.speed * P.childSpeedRatio;
			const childLife = rng() < 0.5 ? P.seedLife * (0.7 + rng() * 0.4) : Math.max(600, this.life * 0.75 * (0.85 + rng() * 0.3));
			e.tips.push(new Hypha(e, this.x, this.y, this.angle, childSpeed, childLife, this.depth + 1, this.angle + ba, this.colony));
			e.nodes.push({ x: this.x, y: this.y, p: rng() * Math.PI * 2 });
			if (this.depth < P.dichotomyMaxDepth && rng() < P.dichotomyProb) {
				const splay = P.dichotomySplay * Math.pow(PHI_INV, this.depth * 0.1) * (0.8 + rng() * 0.4);
				e.tips.push(new Hypha(e, this.x, this.y, this.angle, childSpeed, Math.max(600, childLife * 0.9), this.depth + 1, this.angle + splay, this.colony));
				e.tips.push(new Hypha(e, this.x, this.y, this.angle, childSpeed, Math.max(600, childLife * 0.9), this.depth + 1, this.angle - splay, this.colony));
				this.dead = true; e.nodes.push({ x: this.x, y: this.y, p: rng() * Math.PI * 2 });
			}
		}
		if (this.depth < 6 && _localD < 7 && this.age > 25 && rng() < P.lateralProb) {
			const side = rng() > 0.5 ? 1 : -1;
			const lateralAngle = this.angle + side * (Math.PI / 2 + (rng() - 0.5) * P.lateralAngleVar);
			e.tips.push(new Hypha(e, this.x, this.y, this.angle, this.speed * 0.85, 800 + rng() * 400, this.depth + 2, lateralAngle, this.colony));
			e.nodes.push({ x: this.x, y: this.y, p: rng() * Math.PI * 2 });
		}
		if (this.age > 25 && this.age % 12 === 0 && _localD < 8) {
			const near = e.findNearby(this.x, this.y, P.anastRadius);
			if (near && rng() < P.anastProb) {
				const dist = Math.hypot(near.x - this.x, near.y - this.y);
				if (dist > 4) {
					const interColony = near.c !== undefined && near.c !== this.colony;
					const perpX = -(near.y - this.y) / dist, perpY = (near.x - this.x) / dist;
					const bulge = (rng() - 0.5) * dist * 0.6;
					const mx = (this.x + near.x) / 2 + perpX * bulge, my = (this.y + near.y) / 2 + perpY * bulge;
					const dc = e.drawCtx;
					dc.strokeStyle = `hsla(${this.hue}, ${P.sat}%, ${P.light}%, ${interColony ? 0.25 : 0.15})`;
					dc.lineWidth = interColony ? P.anastLineWidth * 1.5 : P.anastLineWidth; dc.lineCap = 'round';
					dc.beginPath(); dc.moveTo(this.x, this.y); dc.quadraticCurveTo(mx, my, near.x, near.y); dc.stroke();
					e.nodes.push({ x: mx, y: my, p: rng() * Math.PI * 2 });
					if (interColony) {
						e.density[e.gridKey(mx, my)] = (e.density[e.gridKey(mx, my)] || 0) + 6;
						const count = 1 + Math.floor(rng() * 2);
						const fusionAngle = Math.atan2(near.y - this.y, near.x - this.x);
						for (let i = 0; i < count; i++) {
							const target = fusionAngle + (Math.PI / 2) * (i % 2 === 0 ? 1 : -1) + (rng() - 0.5) * 0.4;
							e.tips.push(new Hypha(e, mx, my, fusionAngle, P.seedSpeed * 0.8, P.seedLife * 0.4 + 150, 2, target, this.colony));
						}
						let tooClose = false;
						for (const sp of e.sporePoints) if (Math.hypot(sp.x - mx, sp.y - my) < 100) { tooClose = true; break; }
						if (!tooClose && e.sporePoints.length < 30) e.sporePoints.push({ x: mx, y: my, colony: e.nextColonyId++ });
					}
				}
			}
		}
		if (this.life <= 0) this.dead = true;
		if (this.x < -20 || this.x > e.W + 20 || this.y < -20 || this.y > e.H + 20) this.dead = true;
	}
	drawSegment(ctxx: CanvasRenderingContext2D) {
		const localD = this.e.density[this.e.gridKey(this.x, this.y)] || 0;
		const alpha = Math.max(0.1, P.baseAlpha * Math.pow(PHI_INV, this.depth * 0.15)) + Math.min(0.06, localD * 0.004);
		ctxx.strokeStyle = `hsla(${this.hue}, ${P.sat}%, ${P.light}%, ${alpha})`;
		ctxx.lineWidth = Math.max(0.35, P.baseWidth * Math.pow(PHI_INV, this.depth * 0.3));
		ctxx.lineCap = 'round'; ctxx.lineJoin = 'round';
		ctxx.beginPath(); ctxx.moveTo(this.ox, this.oy); ctxx.lineTo(this.x, this.y); ctxx.stroke();
	}
}

class Engine {
	canvas: HTMLCanvasElement; ctx: CanvasRenderingContext2D;
	persist: HTMLCanvasElement; drawCtx: CanvasRenderingContext2D;
	dpr: number; isDark: boolean; bg: string;
	W = 0; H = 0; time = 0; raf = 0; started = 0;
	tips: Hypha[] = []; nodes: { x: number; y: number; p: number }[] = [];
	grid: Record<string, GridPt[]> = {}; density: Record<string, number> = {};
	sporePoints: { x: number; y: number; colony: number }[] = [];
	nextColonyId = 0; _seed = 137;
	ro: ResizeObserver | null = null;
	rng = () => { this._seed = (this._seed * 16807) % 2147483647; return this._seed / 2147483647; };

	constructor(canvas: HTMLCanvasElement) {
		this.canvas = canvas;
		this.ctx = canvas.getContext('2d')!;
		this.dpr = window.devicePixelRatio || 1;
		this.persist = document.createElement('canvas');
		this.drawCtx = this.persist.getContext('2d')!;
		// Follow the APP theme ([data-theme] toggle), not the OS scheme — else a
		// user on light-app/dark-OS gets a dark canvas behind a light panel.
		const themeAttr = document.documentElement.getAttribute('data-theme');
		this.isDark = themeAttr ? themeAttr === 'dark' : window.matchMedia('(prefers-color-scheme: dark)').matches;
		this.bg = this.isDark ? '#0A0A0C' : '#F7F5EF';
	}
	gridKey(x: number, y: number) { return `${Math.floor(x / GRID_SIZE)},${Math.floor(y / GRID_SIZE)}`; }
	addToGrid(x: number, y: number, colony: number) {
		const jx = x + (this.rng() - 0.5) * 2, jy = y + (this.rng() - 0.5) * 2;
		const k = this.gridKey(x, y);
		(this.grid[k] ||= []).push({ x: jx, y: jy, c: colony });
		this.density[k] = (this.density[k] || 0) + 1;
	}
	findNearby(x: number, y: number, radius: number): GridPt | null {
		const cx = Math.floor(x / GRID_SIZE), cy = Math.floor(y / GRID_SIZE), r = Math.ceil(radius / GRID_SIZE);
		const candidates: GridPt[] = [];
		for (let dx = -r; dx <= r; dx++) for (let dy = -r; dy <= r; dy++) {
			const cell = this.grid[`${cx + dx},${cy + dy}`];
			if (!cell) continue;
			for (const p of cell) { const d = Math.hypot(p.x - x, p.y - y); if (d > 4 && d < radius) candidates.push(p); }
		}
		return candidates.length ? candidates[Math.floor(this.rng() * candidates.length)] : null;
	}
	chemoGradient(x: number, y: number) {
		const cx = Math.floor(x / GRID_SIZE), cy = Math.floor(y / GRID_SIZE), r = Math.ceil(P.chemoRadius / GRID_SIZE);
		let gx = 0, gy = 0;
		for (let dx = -r; dx <= r; dx++) for (let dy = -r; dy <= r; dy++) {
			if (dx === 0 && dy === 0) continue;
			const d = this.density[`${cx + dx},${cy + dy}`] || 0; if (d === 0) continue;
			const dist = Math.sqrt(dx * dx + dy * dy), w = d / (dist * dist + 1); gx += dx * w; gy += dy * w;
		}
		const mag = Math.sqrt(gx * gx + gy * gy);
		return mag < 0.01 ? 0 : Math.atan2(gy, gx);
	}
	sizeTo(w: number, h: number) {
		this.W = w; this.H = h;
		this.canvas.width = w * this.dpr; this.canvas.height = h * this.dpr;
		this.persist.width = w * this.dpr; this.persist.height = h * this.dpr;
		this.canvas.style.width = w + 'px'; this.canvas.style.height = h + 'px';
		this.ctx.setTransform(this.dpr, 0, 0, this.dpr, 0, 0);
		this.drawCtx.setTransform(this.dpr, 0, 0, this.dpr, 0, 0);
		this.drawCtx.fillStyle = this.bg; this.drawCtx.fillRect(0, 0, w, h);
	}
	seed() {
		const positions = [[0.05, 0.92], [0.92, 0.70], [0.50, 0.10]];
		for (const [px, py] of positions) {
			const colonyId = this.nextColonyId++;
			const x = this.W * px + (this.rng() - 0.5) * this.W * 0.02, y = this.H * py + (this.rng() - 0.5) * this.H * 0.02;
			this.sporePoints.push({ x, y, colony: colonyId });
			const count = 5 + Math.floor(this.rng() * 3);
			for (let j = 0; j < count; j++) {
				const a = (Math.PI * 2 / count) * j + (this.rng() - 0.5) * 0.3;
				this.tips.push(new Hypha(this, x, y, a, P.seedSpeed + this.rng() * P.seedSpeedVar, P.seedLife + this.rng() * P.seedLifeVar, 0, undefined, colonyId));
			}
			this.nodes.push({ x, y, p: this.rng() * Math.PI * 2 });
		}
	}
	maybeSpawn() {
		const alive = this.tips.filter((t) => !t.dead).length;
		const spawnChance = 0.12 * (1 - Math.min(1, alive / TARGET_ALIVE) * 0.7);
		if (this.nodes.length > 0 && this.rng() < spawnChance) {
			const n = this.nodes[Math.floor(this.rng() * this.nodes.length)], target = this.rng() * Math.PI * 2;
			this.tips.push(new Hypha(this, n.x, n.y, target + Math.PI / 2, P.seedSpeed + this.rng() * P.seedSpeedVar, P.seedLife * 0.6 + this.rng() * P.seedLifeVar, 1, target));
		}
		if (this.sporePoints.length > 0 && this.time % 30 === 0) {
			const sp = this.sporePoints[Math.floor(this.rng() * this.sporePoints.length)];
			if (!this.tips.some((t) => !t.dead && Math.hypot(t.x - sp.x, t.y - sp.y) < 60)) {
				const count = 2 + Math.floor(this.rng() * 3), baseA = this.rng() * Math.PI * 2;
				for (let i = 0; i < count; i++) {
					const target = baseA + (Math.PI * 2 / count) * i + (this.rng() - 0.5) * 0.3;
					this.tips.push(new Hypha(this, sp.x, sp.y, target + Math.PI / 2, P.seedSpeed, P.seedLife * 0.7, 0, target, sp.colony));
				}
			}
		}
		if (this.rng() < spawnChance * 0.25) {
			const edge = Math.floor(this.rng() * 4);
			const x = edge === 2 ? -5 : edge === 3 ? this.W + 5 : this.rng() * this.W;
			const y = edge === 0 ? -5 : edge === 1 ? this.H + 5 : this.rng() * this.H;
			this.tips.push(new Hypha(this, x, y, Math.atan2(this.H / 2 - y, this.W / 2 - x) + (this.rng() - 0.5) * 0.5, P.seedSpeed, P.seedLife, 0));
		}
	}
	frame = () => {
		if (performance.now() - this.started > ANIM_CAP_MS) return;
		this.raf = requestAnimationFrame(this.frame);
		this.time++;
		if (this.time > 500 && this.time % 6 === 0) {
			this.drawCtx.fillStyle = this.isDark ? 'rgba(10,10,12,0.0005)' : 'rgba(247,245,239,0.0005)';
			this.drawCtx.fillRect(0, 0, this.W, this.H);
		}
		for (const t of this.tips) { t.update(); if (!t.dead) t.drawSegment(this.drawCtx); }
		this.ctx.clearRect(0, 0, this.W, this.H); this.ctx.drawImage(this.persist, 0, 0, this.W, this.H);
		this.maybeSpawn();
		this.tips = this.tips.filter((t) => !t.dead);
		if (this.tips.length > 800) this.tips = this.tips.slice(-600);
		if (this.nodes.length > 800) this.nodes = this.nodes.slice(-600);
		if (this.time % 200 === 0) for (const k of Object.keys(this.density)) { this.density[k] = Math.floor(this.density[k] * 0.8); if (this.density[k] <= 0) delete this.density[k]; }
		if (this.time % 2000 === 0) { const keys = Object.keys(this.grid); if (keys.length > 500) for (const k of keys.slice(0, keys.length - 300)) delete this.grid[k]; }
	};
	start() {
		const parent = this.canvas.parentElement!;
		this.sizeTo(parent.clientWidth || 1, parent.clientHeight || 1);
		this.seed();
		this.started = performance.now();
		this.frame();
		this.ro = new ResizeObserver(() => {
			const nw = parent.clientWidth || 1, nh = parent.clientHeight || 1;
			if (nw !== this.W || nh !== this.H) this.sizeTo(nw, nh);
		});
		this.ro.observe(parent);
		return () => { cancelAnimationFrame(this.raf); this.ro?.disconnect(); };
	}
}

/** Start the mycelium animation on a canvas. Returns a stop() that cancels it. */
export function startMycelium(canvas: HTMLCanvasElement): () => void {
	return new Engine(canvas).start();
}
