// Pairing + launch for the Mycelium mobile shell.
//
// Flow: if a handle was already paired, (optionally) gate on biometrics, then
// navigate the webview to the user's box (https://<handle>.mycelium.id) — from
// there it IS the portal (login, data, everything) over the relay. Otherwise
// show the pairing form. The handle is the only thing stored on-device; no vault
// data or keys ever live in the shell.
//
// Capacitor plugins are imported defensively: this same file must also run in a
// plain browser during development (where the plugins are absent).

const HANDLE_KEY = 'mycelium.handle';
const HANDLE_RE = /^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/; // DNS label

async function preferences() {
  try { return (await import('@capacitor/preferences')).Preferences; }
  catch { // browser/dev fallback → localStorage shim
    return {
      get: async ({ key }) => ({ value: localStorage.getItem(key) }),
      set: async ({ key, value }) => localStorage.setItem(key, value),
      remove: async ({ key }) => localStorage.removeItem(key),
    };
  }
}

function boxUrl(handle) {
  return `https://${handle}.mycelium.id`;
}

// Native biometric app-lock (Face ID / fingerprint) before revealing the vault.
// App-lock convenience ONLY — it does NOT hold or unlock vault keys (those live
// on the box). Best-effort: if no plugin / not enrolled, proceed.
async function biometricGate() {
  try {
    const mod = await import('@aparajita/capacitor-biometric-auth').catch(() => null);
    if (!mod?.BiometricAuth) return true;
    await mod.BiometricAuth.authenticate({
      reason: 'Unlock Mycelium',
      cancelTitle: 'Cancel',
      allowDeviceCredential: true,
    });
    return true;
  } catch {
    return false; // user cancelled / failed → stay on this screen
  }
}

async function launch(handle) {
  if (!(await biometricGate())) return;
  window.location.replace(boxUrl(handle));
}

async function main() {
  const Preferences = await preferences();
  const input = document.getElementById('handle');
  const button = document.getElementById('connect');
  const err = document.getElementById('err');

  // Already paired → go straight to the vault.
  const stored = (await Preferences.get({ key: HANDLE_KEY })).value;
  if (stored && HANDLE_RE.test(stored)) { launch(stored); return; }

  const normalize = (v) => String(v || '').trim().toLowerCase().replace(/\.mycelium\.id$/, '');
  const validate = () => { button.disabled = !HANDLE_RE.test(normalize(input.value)); };
  input.addEventListener('input', () => { err.textContent = ''; validate(); });

  button.addEventListener('click', async () => {
    const handle = normalize(input.value);
    if (!HANDLE_RE.test(handle)) { err.textContent = 'Enter a valid handle (letters, numbers, hyphens).'; return; }
    await Preferences.set({ key: HANDLE_KEY, value: handle });
    launch(handle);
  });

  validate();
}

main();
