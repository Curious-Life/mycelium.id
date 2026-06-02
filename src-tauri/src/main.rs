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
#[cfg(target_os = "macos")]
use window_vibrancy::{apply_vibrancy, NSVisualEffectMaterial};

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

            let mut children: Vec<Child> = vec![child];

            // Embed service (:8091) — the in-process enrichment drainer needs it to
            // turn imported messages into vectors (without it, Generate has nothing
            // to cluster). Skip if something already serves :8091 (e.g. a manually
            // started one); else spawn the ONNX embed service from the provisioned
            // venv (pipeline/.venv) if present, falling back to python3. Best-effort:
            // the drainer health-checks :8091 and degrades gracefully if it never
            // comes up (the UI's preflight then says "still processing").
            if TcpStream::connect(("127.0.0.1", 8091u16)).is_err() {
                let mut ecmd = Command::new(&python_bin);
                ecmd.arg("pipeline/embed-service.py")
                    .arg("--serve")
                    .arg("--port")
                    .arg("8091")
                    .current_dir(&home);
                if hf_home.exists() {
                    ecmd.env("HF_HOME", &hf_home).env("HF_HUB_OFFLINE", "1");
                }
                match ecmd.spawn() {
                    Ok(c) => children.push(c),
                    Err(e) => eprintln!(
                        "[mycelium] embed service did not start ({e}) — imports won't embed until it's available"
                    ),
                }
            }

            app.manage(Server(Mutex::new(children)));

            if !wait_for_port(PORT, Duration::from_secs(25)) {
                eprintln!("[mycelium] server did not open port {PORT} in time");
            }

            let url = format!("http://127.0.0.1:{PORT}");
            let win = WebviewWindowBuilder::new(app, "main", WebviewUrl::External(url.parse().unwrap()))
                .title("Mycelium")
                .inner_size(1100.0, 760.0)
                .min_inner_size(820.0, 560.0)
                .transparent(true)        // let the glass show the desktop through
                .title_bar_style(TitleBarStyle::Overlay) // content flows under the traffic-lights
                // Disable Tauri's native OS file-drop handler so the webview's
                // HTML5 drag-drop (the Import drop zone) receives dropped files.
                // Without this, WKWebView swallows the drop and dataTransfer.files
                // is empty — "drag an export in" silently does nothing.
                .disable_drag_drop_handler()
                .build()?;

            // See-through Mac mode: native window vibrancy behind the transparent
            // webview. (macOS only; no-op elsewhere.) The portal's CSS adds the
            // `glass-os` class when it detects Tauri so its panels stay glassy.
            #[cfg(target_os = "macos")]
            {
                let _ = apply_vibrancy(&win, NSVisualEffectMaterial::HudWindow, None, None);
            }
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
