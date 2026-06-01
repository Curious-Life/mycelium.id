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

/// Holds the spawned Node server so we can kill it on shutdown.
struct Server(Mutex<Option<Child>>);

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

            let child = Command::new("node")
                .arg("src/server-rest.js")
                .current_dir(&home)
                .env("MYCELIUM_REST_PORT", PORT.to_string())
                .env("MYCELIUM_KEY_SOURCE", key_source)
                .spawn()
                .expect("failed to start the mycelium server — is `node` installed and MYCELIUM_HOME correct?");

            app.manage(Server(Mutex::new(Some(child))));

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
                        if let Some(mut child) = guard.take() {
                            let _ = child.kill();
                        }
                    }
                }
            }
        })
        .run(tauri::generate_context!())
        .expect("error while running the mycelium tauri application");
}
