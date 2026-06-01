<script lang="ts">
	import { onMount, onDestroy } from 'svelte';
	import { browser } from '$app/environment';
	import { theme } from '$lib/stores/theme';

	interface Props {
		density?: number;
		speed?: number;
		connectionDistance?: number;
		interactive?: boolean;
	}

	let { density = 120, speed = 0.15, connectionDistance = 80, interactive = true }: Props = $props();

	let canvas: HTMLCanvasElement;
	let ctx: CanvasRenderingContext2D;
	let animationId: number;
	let particles: Particle[] = [];
	let mouse = { x: -1000, y: -1000 };
	let width = 0;
	let height = 0;

	const isDark = $derived($theme === 'dark');

	interface Particle {
		x: number;
		y: number;
		vx: number;
		vy: number;
		size: number;
		opacity: number;
		baseOpacity: number;
		hue: number; // 0 = white, 1 = aurum/gold
		pulse: number;
		pulseSpeed: number;
	}

	function createParticle(): Particle {
		return {
			x: Math.random() * width,
			y: Math.random() * height,
			vx: (Math.random() - 0.5) * speed,
			vy: (Math.random() - 0.5) * speed,
			size: Math.random() * 1.5 + 0.3,
			opacity: 0,
			baseOpacity: Math.random() * 0.4 + 0.08,
			hue: Math.random() < 0.3 ? 1 : 0,
			pulse: Math.random() * Math.PI * 2,
			pulseSpeed: Math.random() * 0.008 + 0.002,
		};
	}

	function init() {
		if (!canvas) return;
		ctx = canvas.getContext('2d')!;
		resize();
	}

	function resize() {
		if (!canvas?.parentElement) return;
		const rect = canvas.parentElement.getBoundingClientRect();
		width = rect.width;
		height = rect.height;
		canvas.width = width * devicePixelRatio;
		canvas.height = height * devicePixelRatio;
		canvas.style.width = width + 'px';
		canvas.style.height = height + 'px';
		ctx?.scale(devicePixelRatio, devicePixelRatio);

		const count = Math.floor((width * height) / (10000 / density * 100));
		const target = Math.min(count, 400);

		while (particles.length < target) particles.push(createParticle());
		while (particles.length > target) particles.pop();
	}

	function render() {
		if (!ctx) return;
		animationId = requestAnimationFrame(render);

		ctx.clearRect(0, 0, width, height);

		const aurumR = isDark ? 229 : 184;
		const aurumG = isDark ? 184 : 134;
		const aurumB = isDark ? 76 : 11;

		const whiteR = isDark ? 200 : 80;
		const whiteG = isDark ? 200 : 80;
		const whiteB = isDark ? 210 : 90;

		// Update + draw particles
		for (let i = 0; i < particles.length; i++) {
			const p = particles[i];

			// Move
			p.x += p.vx;
			p.y += p.vy;

			// Wrap
			if (p.x < -10) p.x = width + 10;
			if (p.x > width + 10) p.x = -10;
			if (p.y < -10) p.y = height + 10;
			if (p.y > height + 10) p.y = -10;

			// Pulse
			p.pulse += p.pulseSpeed;
			p.opacity = p.baseOpacity + Math.sin(p.pulse) * p.baseOpacity * 0.4;

			// Mouse interaction — subtle attraction
			if (interactive) {
				const dx = mouse.x - p.x;
				const dy = mouse.y - p.y;
				const dist = Math.sqrt(dx * dx + dy * dy);
				if (dist < 150 && dist > 0) {
					const force = (150 - dist) / 150 * 0.0003;
					p.vx += dx * force;
					p.vy += dy * force;
					p.opacity = Math.min(p.opacity + (150 - dist) / 150 * 0.15, 0.7);
				}
			}

			// Damping
			p.vx *= 0.999;
			p.vy *= 0.999;

			// Clamp velocity
			const v = Math.sqrt(p.vx * p.vx + p.vy * p.vy);
			if (v > speed * 2) {
				p.vx = (p.vx / v) * speed * 2;
				p.vy = (p.vy / v) * speed * 2;
			}

			// Draw particle
			const r = p.hue ? aurumR : whiteR;
			const g = p.hue ? aurumG : whiteG;
			const b = p.hue ? aurumB : whiteB;
			ctx.beginPath();
			ctx.arc(p.x, p.y, p.size, 0, Math.PI * 2);
			ctx.fillStyle = `rgba(${r},${g},${b},${p.opacity})`;
			ctx.fill();

			// Draw connections to nearby particles
			for (let j = i + 1; j < particles.length; j++) {
				const q = particles[j];
				const cdx = p.x - q.x;
				const cdy = p.y - q.y;
				const cdist = cdx * cdx + cdy * cdy;
				const maxDist = connectionDistance * connectionDistance;

				if (cdist < maxDist) {
					const alpha = (1 - cdist / maxDist) * Math.min(p.opacity, q.opacity) * 0.6;
					if (alpha > 0.01) {
						ctx.beginPath();
						ctx.moveTo(p.x, p.y);
						ctx.lineTo(q.x, q.y);
						ctx.strokeStyle = `rgba(${aurumR},${aurumG},${aurumB},${alpha})`;
						ctx.lineWidth = 0.3;
						ctx.stroke();
					}
				}
			}
		}
	}

	function handleMouseMove(e: MouseEvent) {
		if (!canvas) return;
		const rect = canvas.getBoundingClientRect();
		mouse.x = e.clientX - rect.left;
		mouse.y = e.clientY - rect.top;
	}

	function handleMouseLeave() {
		mouse.x = -1000;
		mouse.y = -1000;
	}

	onMount(() => {
		if (!browser) return;
		init();
		render();
		const ro = new ResizeObserver(() => {
			resize();
		});
		if (canvas?.parentElement) ro.observe(canvas.parentElement);
		return () => ro.disconnect();
	});

	onDestroy(() => {
		if (animationId) cancelAnimationFrame(animationId);
	});
</script>

<canvas
	bind:this={canvas}
	class="absolute inset-0 pointer-events-auto"
	onmousemove={handleMouseMove}
	onmouseleave={handleMouseLeave}
	style="z-index: 0;"
></canvas>
