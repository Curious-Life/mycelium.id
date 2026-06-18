// Mycelium native shell (Tauri v2).
//
// Spawns the Node servers + (when remote is on) the caddy/frpc sidecars, opens a
// window at the local REST/portal, and reaps every child on exit. Children are
// put in their OWN process group so a group-kill reaps grandchildren too; the reap
// runs on RunEvent::Exit (every graceful quit). A HARD crash (SIGKILL/panic) fires
// no event, so caddy/frpc pids are recorded to a pidfile and reaped at the NEXT
// launch — PID-reuse-safe (only kill if the live process image still matches).
//
// Keys: the server reads them via MYCELIUM_KEY_SOURCE (default `keychain`) — see
// src/crypto/key-source.js — so no secrets live in this app. The Node project is
// MYCELIUM_HOME (dev) or the bundled resources dir.

#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

use std::io::Write;
use std::net::TcpStream;
use std::path::{Path, PathBuf};
use std::process::{Child, Command};
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, Mutex};
use std::time::{Duration, Instant};

use tauri::menu::{Menu, MenuItem, Submenu};
use tauri::{Manager, RunEvent, TitleBarStyle, WebviewUrl, WebviewWindowBuilder};

const PORT: u16 = 8787;

/// Every spawned child (Node REST, embed, --http, caddy, frpc) + the pidfile that
/// lets us reap sidecars orphaned by a PRIOR hard crash. Killed on app exit.
struct Server {
    children: Mutex<Vec<Child>>,
    pidfile: Option<PathBuf>,
    // Set on shutdown so the :4711 supervisor thread stops respawning. The current
    // live :4711 pid (owned by that thread, NOT `children`) so reap() can group-kill it.
    shutting_down: Arc<AtomicBool>,
    http_pid: Arc<Mutex<Option<u32>>>,
}

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

/// Read <data_dir>/remote.json (written by the Settings UI / connect-managed).
/// Best-effort: Null on any error (missing file, parse failure).
fn read_remote_json(data_dir: &Path) -> serde_json::Value {
    std::fs::read_to_string(data_dir.join("remote.json"))
        .ok()
        .and_then(|txt| serde_json::from_str::<serde_json::Value>(&txt).ok())
        .unwrap_or(serde_json::Value::Null)
}

/// remoteMode: 'off' | 'managed' | 'own-relay' | 'direct' (default 'off').
fn remote_mode(cfg: &serde_json::Value) -> String {
    cfg.get("remoteMode").and_then(|v| v.as_str()).unwrap_or("off").to_string()
}

/// Legacy Phase-1/2 toggle: start the --http server even with remoteMode 'off'.
fn remote_enabled_legacy(cfg: &serde_json::Value) -> bool {
    cfg.get("remoteEnabled").and_then(|b| b.as_bool()).unwrap_or(false)
}

/// Resolve a bundled sidecar binary. In a packaged .app, Tauri places sidecars
/// beside the main executable. SECURITY: in a RELEASE build we resolve ONLY there
/// and return None otherwise — never a bare name / $PATH lookup, because a poisoned
/// PATH could run an attacker's `caddy`/`frpc` with the acme-dns creds. Dev checkout
/// paths + PATH fallback are compiled in ONLY for debug builds.
fn resolve_sidecar(home: &Path, name: &str) -> Option<PathBuf> {
    if let Ok(exe) = std::env::current_exe() {
        if let Some(dir) = exe.parent() {
            let p = dir.join(name);
            if p.exists() {
                return Some(p);
            }
        }
    }
    #[cfg(debug_assertions)]
    {
        for cand in [
            home.join("src-tauri").join("binaries").join(name),
            home.join("binaries").join(name),
        ] {
            if cand.exists() {
                return Some(cand);
            }
        }
        return Some(PathBuf::from(name)); // dev only: PATH fallback
    }
    #[cfg(not(debug_assertions))]
    {
        let _ = home;
        None
    }
}

/// Put a child in its own process group so a group-kill reaps it + grandchildren.
#[cfg(unix)]
fn set_group(cmd: &mut Command) {
    use std::os::unix::process::CommandExt;
    cmd.process_group(0); // pgid == child pid
}
#[cfg(not(unix))]
fn set_group(_cmd: &mut Command) {}

/// Record a sidecar's pid (+ binary name, for the PID-reuse-safe match) so a
/// crash-orphan can be reaped at next launch.
fn record_pid(pidfile: &Path, pid: u32, name: &str) {
    if let Ok(mut f) = std::fs::OpenOptions::new().create(true).append(true).open(pidfile) {
        let _ = writeln!(f, "{pid}\t{name}");
    }
}

/// Group-kill a child (process_group made pgid == pid): SIGTERM, then SIGKILL.
#[cfg(unix)]
fn kill_group(pid: u32) {
    let pgid = pid as i32;
    unsafe {
        libc::kill(-pgid, libc::SIGTERM);
        libc::kill(-pgid, libc::SIGKILL);
    }
}
#[cfg(not(unix))]
fn kill_group(_pid: u32) {}

/// Reap every tracked child + clear the pidfile. Idempotent (drain empties).
fn reap(server: &Server) {
    // Tell the :4711 supervisor to stop respawning, then group-kill the live child
    // it owns (it isn't in `children`). Order matters: flag BEFORE kill so the
    // supervisor sees shutdown when its wait() returns and exits instead of respawning.
    server.shutting_down.store(true, Ordering::SeqCst);
    if let Ok(g) = server.http_pid.lock() {
        if let Some(pid) = *g {
            kill_group(pid);
        }
    }
    if let Ok(mut guard) = server.children.lock() {
        for mut child in guard.drain(..) {
            kill_group(child.id());
            let _ = child.kill();
            let _ = child.wait();
        }
    }
    if let Some(pf) = &server.pidfile {
        let _ = std::fs::remove_file(pf);
    }
}

/// At launch, reap caddy/frpc orphaned by a PRIOR hard crash (no Exit/Destroyed
/// fired). PID-reuse-safe: only kill a recorded pid if its live process image still
/// matches the recorded name. We track ONLY caddy/frpc — matching generic
/// "node"/"python" by comm would risk killing an innocent process on a reused pid.
#[cfg(unix)]
fn reap_stale_pids(pidfile: &Path) {
    let contents = match std::fs::read_to_string(pidfile) {
        Ok(c) => c,
        Err(_) => return,
    };
    for line in contents.lines() {
        let mut it = line.split('\t');
        let pid_s = it.next().unwrap_or("");
        let name = it.next().unwrap_or("");
        let pid: i32 = match pid_s.parse() {
            Ok(p) => p,
            Err(_) => continue,
        };
        if name.is_empty() {
            continue;
        }
        let comm = Command::new("ps")
            .args(["-p", &pid.to_string(), "-o", "comm="])
            .output()
            .ok()
            .map(|o| String::from_utf8_lossy(&o.stdout).trim().to_string())
            .unwrap_or_default();
        let base = comm.rsplit('/').next().unwrap_or("");
        if !comm.is_empty() && base == name {
            unsafe {
                libc::kill(-pid, libc::SIGKILL);
            }
            eprintln!("[mycelium] reaped stale sidecar pid {pid} ({name}) from a prior run");
        }
    }
    let _ = std::fs::remove_file(pidfile);
}
#[cfg(not(unix))]
fn reap_stale_pids(_pidfile: &Path) {}

fn main() {
    let app = tauri::Builder::default()
        .setup(|app| {
            let home = mycelium_home(app);
            let key_source =
                std::env::var("MYCELIUM_KEY_SOURCE").unwrap_or_else(|_| "keychain".into());
            let data_dir: Option<PathBuf> = app.path().app_data_dir().ok();
            let pidfile: Option<PathBuf> = data_dir.as_ref().map(|d| d.join("sidecars.pids"));

            // Reap any sidecars orphaned by a prior hard crash BEFORE spawning new ones.
            if let Some(pf) = &pidfile {
                reap_stale_pids(pf);
            }

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

            // Node REST + portal (:8787) — required.
            // Give V8 headroom: a "bring-your-vault-home" import assembles a
            // multi-GB export in memory then JSZip-loads it; the default heap
            // (~2GB) OOMs on large vaults. 4GB floor covers a ~2GB zip; the user
            // can raise it via NODE_OPTIONS for bigger vaults. Preserve any
            // existing NODE_OPTIONS (don't clobber a user override).
            let node_options = {
                let existing = std::env::var("NODE_OPTIONS").unwrap_or_default();
                if existing.contains("--max-old-space-size") { existing }
                else if existing.is_empty() { "--max-old-space-size=4096".to_string() }
                else { format!("{} --max-old-space-size=4096", existing) }
            };
            let mut cmd = Command::new(&node_bin);
            cmd.arg("src/server-rest.js")
                .current_dir(&home)
                .env("NODE_OPTIONS", &node_options)
                .env("MYCELIUM_REST_PORT", PORT.to_string())
                // At-rest blindness (A′) is the app DEFAULT: a fresh vault is born
                // encrypted; an existing plaintext vault migrates once (race-safe via
                // the cross-process lock in src/db/init.js initVaultStorage). NOT a
                // code default — the verify gates (which open plaintext fixtures) must
                // stay opt-out, so it's set only for the real app's node processes.
                .env("MYCELIUM_AT_REST", "1")
                .env("MYCELIUM_KEY_SOURCE", &key_source);
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

            // Durable per-OS data dir — keeps the encrypted vault OUTSIDE the .app
            // (see src/paths.js), so replacing the .app never wipes the user's history.
            if let Some(d) = &data_dir {
                cmd.env("MYCELIUM_DATA_DIR", d);
            }
            set_group(&mut cmd);
            let child = cmd
                .spawn()
                .expect("failed to start the mycelium server — is `node` installed and MYCELIUM_HOME correct?");

            // Embed service (:8091) is now OWNED BY THE NODE SERVER
            // (src/embed/supervisor.js): it dep-checks, adopts-or-spawns, RESTARTS
            // on crash, and surfaces health to the UI via /processing-status — so no
            // fire-and-forget Rust spawn here (which never noticed a post-spawn crash
            // and left the UI hanging at "Processing 0/N").
            let mut children: Vec<Child> = vec![child];
            // Shared with the :4711 supervisor thread (created below, when remote is on).
            let shutting_down = Arc::new(AtomicBool::new(false));
            let http_pid: Arc<Mutex<Option<u32>>> = Arc::new(Mutex::new(None));

            // Remote stack (--http + caddy + frpc) — only when remote is configured.
            if let Some(d) = &data_dir {
                let cfg = read_remote_json(d);
                let mode = remote_mode(&cfg);
                if mode != "off" || remote_enabled_legacy(&cfg) {
                    // --http OAuth/MCP server (loopback). Pass the public base URL so
                    // OAuth metadata/redirects use the real hostname (empty → localhost).
                    // :4711 (remote MCP/OAuth + the LOCAL capture surface the memory
                    // bridge posts to) is the one child we SUPERVISE. A dedicated thread
                    // respawns it (capped exponential backoff) if it dies, so a crash no
                    // longer silently kills capture/sync until the next app relaunch. It
                    // also now gets the 4GB heap (NODE_OPTIONS) the one-shot spawn lacked
                    // — the likely OOM when a large history backfill hit it. Shutdown is
                    // clean: reap() flips `shutting_down` and group-kills the live pid.
                    let public_host =
                        cfg.get("publicHost").and_then(|v| v.as_str()).unwrap_or("").to_string();
                    let sup_node = node_bin.clone();
                    let sup_home = home.clone();
                    let sup_key = key_source.clone();
                    let sup_data = d.clone();
                    let sup_opts = node_options.clone();
                    let sup_flag = shutting_down.clone();
                    let sup_pid = http_pid.clone();
                    std::thread::spawn(move || {
                        let spawn_http = || {
                            let mut http = Command::new(&sup_node);
                            http.arg("src/index.js")
                                .arg("--http")
                                .current_dir(&sup_home)
                                .env("NODE_OPTIONS", &sup_opts)
                                .env("MYCELIUM_PORT", "4711")
                                .env("MYCELIUM_KEY_SOURCE", &sup_key)
                                // At-rest default (see server-rest spawn). BOTH app
                                // node processes carry it so both serialize on the
                                // init lock → neither opens the plaintext vault while
                                // the other migrates (no split-brain).
                                .env("MYCELIUM_AT_REST", "1")
                                .env("MYCELIUM_DATA_DIR", &sup_data);
                            if !public_host.is_empty() {
                                http.env("MYCELIUM_BASE_URL", format!("https://{public_host}"));
                            }
                            set_group(&mut http);
                            http.spawn()
                        };
                        let mut backoff = Duration::from_secs(1);
                        loop {
                            if sup_flag.load(Ordering::SeqCst) {
                                break;
                            }
                            match spawn_http() {
                                Ok(mut c) => {
                                    if let Ok(mut g) = sup_pid.lock() {
                                        *g = Some(c.id());
                                    }
                                    eprintln!("[mycelium] remote MCP (OAuth) server on 127.0.0.1:4711 (supervised)");
                                    let started = Instant::now();
                                    let _ = c.wait();
                                    if let Ok(mut g) = sup_pid.lock() {
                                        *g = None;
                                    }
                                    if sup_flag.load(Ordering::SeqCst) {
                                        break;
                                    }
                                    // A healthy run resets the backoff; a fast crash grows
                                    // it (capped) so we never hot-loop a broken server.
                                    if started.elapsed() >= Duration::from_secs(60) {
                                        backoff = Duration::from_secs(1);
                                    }
                                    eprintln!("[mycelium] :4711 exited — restarting in {}s", backoff.as_secs());
                                    std::thread::sleep(backoff);
                                    backoff = std::cmp::min(backoff * 2, Duration::from_secs(30));
                                }
                                Err(e) => {
                                    eprintln!("[mycelium] remote MCP server did not start ({e}); retry in {}s", backoff.as_secs());
                                    std::thread::sleep(backoff);
                                    backoff = std::cmp::min(backoff * 2, Duration::from_secs(30));
                                }
                            }
                        }
                    });

                    // Caddy terminates TLS for <publicHost> (managed/own-relay/direct).
                    if mode == "managed" || mode == "own-relay" || mode == "direct" {
                        match resolve_sidecar(&home, "caddy") {
                            Some(caddy) => {
                                let mut cc = Command::new(&caddy);
                                cc.arg("run")
                                    .arg("--config")
                                    .arg(d.join("Caddyfile"))
                                    .arg("--adapter")
                                    .arg("caddyfile")
                                    .current_dir(d);
                                set_group(&mut cc);
                                match cc.spawn() {
                                    Ok(c) => {
                                        if let Some(pf) = &pidfile {
                                            record_pid(pf, c.id(), "caddy");
                                        }
                                        children.push(c);
                                        eprintln!("[mycelium] caddy (TLS terminator) started");
                                    }
                                    Err(e) => eprintln!("[mycelium] caddy did not start ({e})"),
                                }
                            }
                            None => eprintln!("[mycelium] caddy sidecar not found beside the app — TLS will not start (run scripts/fetch-sidecars.sh + rebuild)"),
                        }
                    }

                    // frpc reverse tunnel (relay modes only; direct has no relay).
                    if mode == "managed" || mode == "own-relay" {
                        match resolve_sidecar(&home, "frpc") {
                            Some(frpc) => {
                                let mut fc = Command::new(&frpc);
                                fc.arg("-c").arg(d.join("frpc.toml")).current_dir(d);
                                set_group(&mut fc);
                                match fc.spawn() {
                                    Ok(c) => {
                                        if let Some(pf) = &pidfile {
                                            record_pid(pf, c.id(), "frpc");
                                        }
                                        children.push(c);
                                        eprintln!("[mycelium] frpc (reverse tunnel) started");
                                    }
                                    Err(e) => eprintln!("[mycelium] frpc did not start ({e})"),
                                }
                            }
                            None => eprintln!("[mycelium] frpc sidecar not found beside the app — tunnel will not start (run scripts/fetch-sidecars.sh + rebuild)"),
                        }
                    }
                }
            }

            app.manage(Server {
                children: Mutex::new(children),
                pidfile,
                shutting_down,
                http_pid,
            });

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

            // Reload binding (Cmd/Ctrl+R). WKWebView in a Tauri dev build binds no
            // reload by default, so a frontend deploy "won't show" until the app is
            // fully restarted (cost a debugging round-trip 2026-06-15). A menu item
            // is how desktop accelerators are registered in Tauri v2 — we keep the
            // standard app menu (Quit/Copy/Paste/…) and append a View › Reload.
            // Paired with the `no-store` SPA shell in server-rest.js so the reload
            // fetches the current hashed bundle rather than a cached shell.
            let reload = MenuItem::with_id(app, "reload", "Reload", true, Some("CmdOrCtrl+R"))?;
            let view = Submenu::with_items(app, "View", true, &[&reload])?;
            let menu = Menu::default(app.handle())?;
            menu.append(&view)?;
            app.set_menu(menu)?;

            Ok(())
        })
        .on_menu_event(|app, event| {
            if event.id().as_ref() == "reload" {
                if let Some(w) = app.get_webview_window("main") {
                    let _ = w.eval("window.location.reload()");
                }
            }
        })
        .on_window_event(|window, event| {
            // Reap on window close (redundant with RunEvent::Exit; covers either path).
            if let tauri::WindowEvent::Destroyed = event {
                if let Some(state) = window.app_handle().try_state::<Server>() {
                    reap(state.inner());
                }
            }
        })
        .build(tauri::generate_context!())
        .expect("error while building the mycelium tauri application");

    // Reap sidecars on EVERY graceful exit (window close, Cmd-Q, app.exit()). A hard
    // crash fires neither this nor Destroyed — reap_stale_pids() at the next launch
    // is the backstop for orphaned caddy/frpc.
    app.run(|app_handle, event| {
        if let RunEvent::Exit = event {
            if let Some(state) = app_handle.try_state::<Server>() {
                reap(state.inner());
            }
        }
    });
}
