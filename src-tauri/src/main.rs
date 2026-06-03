// Mycelium native shell (Tauri v2).
//
// Strategy: the Node server already serves BOTH the portal UI and the REST API
// at http://127.0.0.1:8787 (see src/server-rest.js). This shell just (1) spawns
// that server as a child process on launch, (2) waits for the port, (3) opens a
// window pointed at it, and (4) kills the child when the window closes.
//
// Keys: the server reads them via MYCELIUM_KEY_SOURCE (default `keychain` here)
// — see src/crypto/key-source.js — so no secrets live in this app.
//
// The Node project location is resolved from MYCELIUM_HOME (dev) or, in a
// bundled .app, from the resources dir. Node must be installed on the machine
// (the same Node you use for `npm start`).
//
// NOTE: this file is a scaffold authored without a Rust toolchain available;
// build + verify it on the Mac (see src-tauri/BUILD-MAC.md). Minor adjustments
// may be needed on first `cargo tauri dev`.

#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

use std::net::TcpStream;
use std::process::{Child, Command};
use std::sync::Mutex;
use std::time::{Duration, Instant};

use tauri::{Manager, TitleBarStyle, WebviewUrl, WebviewWindowBuilder};

const PORT: u16 = 8787;

/// Holds every spawned child process (Node server + embed service) so we can
/// kill them all on shutdown.
struct Server(Mutex<Vec<Child>>);

fn wait_for_port(port: u16, timeout: Duration) -> bool {
    let start = Instant::now();
    while start.elapsed() < timeout {
        if TcpStream::connect(("127.0.0.1", port)).is_ok() {
            return true;
        }
        std::thread::sleep(Duration::from_millis(200));
    }
    false
}

/// Where the Node project lives: MYCELIUM_HOME, else the bundled resources dir.
fn mycelium_home(app: &tauri::App) -> std::path::PathBuf {
    if let Ok(h) = std::env::var("MYCELIUM_HOME") {
        return std::path::PathBuf::from(h);
    }
    app.path()
        .resource_dir()
        .map(|r| r.join("app"))
        .unwrap_or_else(|_| std::path::PathBuf::from("."))
}

fn main() {
    tauri::Builder::default()
        .setup(|app| {
            let home = mycelium_home(app);
            let key_source =
                std::env::var("MYCELIUM_KEY_SOURCE").unwrap_or_else(|_| "keychain".into());

            // Self-contained runtimes (Option B). A packaged .app bundles its own
            // Node binary + a relocatable Python + the model under Resources/app/
            // (see scripts/build-app-bundle.sh); a dev checkout has none of these,
            // so each lookup falls back to the dev location / PATH. `bundled` gates
            // the packaged-only wiring so dev behaviour is unchanged.
            let bundled_py = home.join("python/bin/python3");
            let bundled = bundled_py.exists();
            let node_bin = {
                let b = home.join("node");
                if b.exists() { b.to_string_lossy().into_owned() } else { "node".to_string() }
            };
            let python_bin = {
                let venv = home.join("pipeline/.venv/bin/python3");
                if bundled { bundled_py.to_string_lossy().into_owned() }
                else if venv.exists() { venv.to_string_lossy().into_owned() }
                else { "python3".to_string() }
            };
            let hf_home = home.join("hf-cache");

            let mut cmd = Command::new(&node_bin);
            cmd.arg("src/server-rest.js")
                .current_dir(&home)
                .env("MYCELIUM_REST_PORT", PORT.to_string())
                .env("MYCELIUM_KEY_SOURCE", key_source);
            if bundled {
                // Make the bundled node + python resolvable to the clustering child
                // (src/jobs.js → run-clustering.sh, whose JS stages call bare `node`),
                // and hand the explicit python down via MYCELIUM_PYTHON (the
                // run-clustering.sh $PYTHON seam from the fresh-user-provisioning work).
                let path = std::env::var("PATH").unwrap_or_default();
                cmd.env(
                    "PATH",
                    format!("{}:{}:{}", home.display(), home.join("python/bin").display(), path),
                )
                .env("MYCELIUM_PYTHON", &python_bin);
            }
            if hf_home.exists() {
                // Offline embedding model bundled under Resources/app/hf-cache.
                cmd.env("HF_HOME", &hf_home).env("HF_HUB_OFFLINE", "1");
            }

            // Durable per-OS data dir — on macOS this is
            // ~/Library/Application Support/id.mycelium.app. Passing it as
            // MYCELIUM_DATA_DIR puts the encrypted vault OUTSIDE the app bundle
            // (see src/paths.js), so updating/replacing the .app never wipes the
            // user's history. Falls back silently to ./data if unresolvable.
            if let Ok(data_dir) = app.path().app_data_dir() {
                cmd.env("MYCELIUM_DATA_DIR", &data_dir);
            }

            let child = cmd
                .spawn()
                .expect("failed to start the mycelium server — is `node` installed and MYCELIUM_HOME correct?");

            // Embed service (:8091) is now OWNED BY THE NODE SERVER
            // (src/embed/supervisor.js): it dep-checks, adopts-or-spawns, RESTARTS
            // on crash, and surfaces health to the UI via /processing-status. That
            // single owner works identically in npm-dev, Tauri-dev and the bundled
            // app — unlike the old fire-and-forget spawn here, which never noticed a
            // post-spawn crash and left the UI hanging at "Processing 0/N". The
            // bundled python is handed to Node via MYCELIUM_PYTHON above; the
            // supervisor's child inherits HF_HOME/HF_HUB_OFFLINE from this process.
            let children: Vec<Child> = vec![child];
            app.manage(Server(Mutex::new(children)));

            if !wait_for_port(PORT, Duration::from_secs(25)) {
                eprintln!("[mycelium] server did not open port {PORT} in time");
            }

            let url = format!("http://127.0.0.1:{PORT}");
            let win = WebviewWindowBuilder::new(app, "main", WebviewUrl::External(url.parse().unwrap()))
                .title("Mycelium")
                .inner_size(1100.0, 760.0)
                .min_inner_size(820.0, 560.0)
                // OPAQUE window (was .transparent(true)). The app body is a solid
                // #0A0A0C, so the "glass" never actually showed the desktop — but a
                // transparent WKWebView layer FLICKERS on every repaint (it clears to
                // transparent before the opaque content repaints → "the text reloads
                // and flashes"). Opaque eliminates that flicker with zero visual change
                // and removes the transparent⇄WebGL interaction that hung the webview.
                // Standard title bar (was Overlay). The macOS window buttons get their
                // own slim strip at the very top; the in-app header then sits BELOW it,
                // full-width at normal padding, so the hamburger + "Mycelium" line up
                // with the sidebar and never collide with the close/min/max controls.
                // (Overlay flowed content UNDER the buttons, forcing a left-clearance
                // that pushed the header right and out of line with the sidebar.)
                // `hidden_title` drops the redundant title TEXT — the brand is the
                // in-app wordmark. The window stays opaque (the #52 flicker fix).
                .title_bar_style(TitleBarStyle::Visible)
                .hidden_title(true)
                // Disable Tauri's native OS file-drop handler so the webview's
                // HTML5 drag-drop (the Import drop zone) receives dropped files.
                // Without this, WKWebView swallows the drop and dataTransfer.files
                // is empty — "drag an export in" silently does nothing.
                .disable_drag_drop_handler()
                .build()?;

            let _ = &win;

            Ok(())
        })
        .on_window_event(|window, event| {
            if let tauri::WindowEvent::Destroyed = event {
                if let Some(state) = window.app_handle().try_state::<Server>() {
                    if let Ok(mut guard) = state.0.lock() {
                        for mut child in guard.drain(..) {
                            let _ = child.kill();
                        }
                    }
                }
            }
        })
        .run(tauri::generate_context!())
        .expect("error while running the mycelium tauri application");
}
