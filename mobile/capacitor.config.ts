import type { CapacitorConfig } from '@capacitor/cli';

// Mycelium mobile — a thin REMOTE-WEBVIEW client. The only bundled web asset is
// the pairing landing (www/index.html); after pairing, the webview navigates to
// the user's own box at https://<handle>.mycelium.id and behaves exactly like the
// browser portal (same-origin cookies, CSRF, the auth gate). `allowNavigation`
// lets the webview leave the bundled origin for the box; the Capacitor bridge
// (Preferences, StatusBar, App, biometric app-lock) stays available on the
// navigated remote origin. See README.md.
const config: CapacitorConfig = {
  appId: 'id.mycelium.app',
  appName: 'Mycelium',
  webDir: 'www',
  server: {
    androidScheme: 'https',
    iosScheme: 'https',
    // Only the user's own vault subdomains. NEVER widen this to '*'.
    allowNavigation: ['*.mycelium.id'],
  },
  ios: {
    contentInset: 'always',
    limitsNavigationsToAppBoundDomains: false,
  },
};

export default config;
