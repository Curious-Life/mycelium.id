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

/// Is remote access enabled? Reads <data_dir>/remote.json (written by the
/// Settings UI via /api/v1/remote/config). Best-effort: false on any error
/// (missing file, parse failure, key absent) — remote stays OFF unless the
/// config explicitly says `"remoteEnabled": true`.
fn remote_enabled(data_dir: &std::path::Path) -> bool {
    std::fs::read_to_string(data_dir.join("remote.json"))
        .ok()
        .and_then(|txt| serde_json::from_str::<serde_json::Value>(&txt).ok())
        .and_then(|v| v.get("remoteEnabled").and_then(|b| b.as_bool()))
        .unwrap_or(false)
}

fn main() {
    tauri::Builder::default()
        .setup(|app| {
            let home = mycelium_home(app);
            let key_source =
                std::env::var("MYCELIUM_KEY_SOURCE").unwrap_or_else(|_| "keychain".into());

            let mut cmd = Command::new("node");
            cmd.arg("src/server-rest.js")
                .current_dir(&home)
                .env("MYCELIUM_REST_PORT", PORT.to_string())
                .env("MYCELIUM_KEY_SOURCE", &key_source);

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
                let venv_py = home.join("pipeline/.venv/bin/python3");
                let python = if venv_py.exists() {
                    venv_py.to_string_lossy().into_owned()
                } else {
                    "python3".to_string()
                };
                match Command::new(python)
                    .arg("pipeline/embed-service.py")
                    .arg("--serve")
                    .arg("--port")
                    .arg("8091")
                    .current_dir(&home)
                    .spawn()
                {
                    Ok(c) => children.push(c),
                    Err(e) => eprintln!(
                        "[mycelium] embed service did not start ({e}) — imports won't embed until it's available"
                    ),
                }
            }

            // Remote MCP (OAuth) server — started ONLY when the user enabled
            // remote access (Settings → Remote access writes remoteEnabled to
            // remote.json). Tauri OWNS this child so it dies with the app (clean
            // teardown via the Destroyed handler below). It binds 127.0.0.1:4711;
            // public reachability + TLS is the tunnel's job (Phase 3). The server
            // resolves its base URL + signing secret + operator user from the
            // persisted config (Phase 1), so no secrets are passed here.
            if let Ok(data_dir) = app.path().app_data_dir() {
                if remote_enabled(&data_dir) {
                    let spawned = Command::new("node")
                        .arg("src/index.js")
                        .arg("--http")
                        .current_dir(&home)
                        .env("MYCELIUM_PORT", "4711")
                        .env("MYCELIUM_KEY_SOURCE", &key_source)
                        .env("MYCELIUM_DATA_DIR", &data_dir)
                        .spawn();
                    match spawned {
                        Ok(c) => {
                            children.push(c);
                            eprintln!("[mycelium] remote MCP (OAuth) server starting on 127.0.0.1:4711");
                        }
                        Err(e) => eprintln!("[mycelium] remote MCP server did not start ({e})"),
                    }
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
