// portal-app/src/lib/utils/webgl.ts
// WebGL capability probe. The Mindscape 3D view + background create a
// THREE.WebGLRenderer; on a device/browser without WebGL (disabled, old, some
// privacy modes, headless), that throws and used to leave a blank canvas + a
// crash in the render loop. Probe first so callers can degrade gracefully.
//
// Cheap + safe to call repeatedly: creates a throwaway <canvas>, asks for a
// context, never touches the DOM tree.
export function canUseWebGL(): boolean {
	if (typeof document === 'undefined') return false; // SSR / no DOM
	try {
		const canvas = document.createElement('canvas');
		const gl =
			canvas.getContext('webgl2') ||
			canvas.getContext('webgl') ||
			canvas.getContext('experimental-webgl');
		return gl != null;
	} catch {
		return false;
	}
}
