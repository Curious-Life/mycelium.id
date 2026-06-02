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
use std::sync::Mutex;
use std::time::{Duration, Instant};

use tauri::{Manager, RunEvent, TitleBarStyle, WebviewUrl, WebviewWindowBuilder};
#[cfg(target_os = "macos")]
use window_vibrancy::{apply_vibrancy, NSVisualEffectMaterial};

const PORT: u16 = 8787;

/// Every spawned child (Node REST, embed, --http, caddy, frpc) + the pidfile that
/// lets us reap sidecars orphaned by a PRIOR hard crash. Killed on app exit.
struct Server {
    children: Mutex<Vec<Child>>,
    pidfile: Option<PathBuf>,
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

            // Node REST + portal (:8787) — required.
            let mut cmd = Command::new("node");
            cmd.arg("src/server-rest.js")
                .current_dir(&home)
                .env("MYCELIUM_REST_PORT", PORT.to_string())
                .env("MYCELIUM_KEY_SOURCE", &key_source);
            // Durable per-OS data dir — keeps the encrypted vault OUTSIDE the .app.
            if let Some(d) = &data_dir {
                cmd.env("MYCELIUM_DATA_DIR", d);
            }
            set_group(&mut cmd);
            let child = cmd
                .spawn()
                .expect("failed to start the mycelium server — is `node` installed and MYCELIUM_HOME correct?");
            let mut children: Vec<Child> = vec![child];

            // Embed service (:8091) — best-effort; the drainer degrades if it's absent.
            if TcpStream::connect(("127.0.0.1", 8091u16)).is_err() {
                let venv_py = home.join("pipeline/.venv/bin/python3");
                let python = if venv_py.exists() {
                    venv_py.to_string_lossy().into_owned()
                } else {
                    "python3".to_string()
                };
                let mut e = Command::new(python);
                e.arg("pipeline/embed-service.py")
                    .arg("--serve")
                    .arg("--port")
                    .arg("8091")
                    .current_dir(&home);
                set_group(&mut e);
                match e.spawn() {
                    Ok(c) => children.push(c),
                    Err(err) => eprintln!(
                        "[mycelium] embed service did not start ({err}) — imports won't embed until it's available"
                    ),
                }
            }

            // Remote stack (--http + caddy + frpc) — only when remote is configured.
            if let Some(d) = &data_dir {
                let cfg = read_remote_json(d);
                let mode = remote_mode(&cfg);
                if mode != "off" || remote_enabled_legacy(&cfg) {
                    // --http OAuth/MCP server (loopback). Pass the public base URL so
                    // OAuth metadata/redirects use the real hostname (empty → localhost).
                    let public_host = cfg.get("publicHost").and_then(|v| v.as_str()).unwrap_or("");
                    let mut http = Command::new("node");
                    http.arg("src/index.js")
                        .arg("--http")
                        .current_dir(&home)
                        .env("MYCELIUM_PORT", "4711")
                        .env("MYCELIUM_KEY_SOURCE", &key_source)
                        .env("MYCELIUM_DATA_DIR", d);
                    if !public_host.is_empty() {
                        http.env("MYCELIUM_BASE_URL", format!("https://{public_host}"));
                    }
                    set_group(&mut http);
                    match http.spawn() {
                        Ok(c) => {
                            children.push(c);
                            eprintln!("[mycelium] remote MCP (OAuth) server on 127.0.0.1:4711");
                        }
                        Err(e) => eprintln!("[mycelium] remote MCP server did not start ({e})"),
                    }

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

            app.manage(Server { children: Mutex::new(children), pidfile });

            if !wait_for_port(PORT, Duration::from_secs(25)) {
                eprintln!("[mycelium] server did not open port {PORT} in time");
            }

            let url = format!("http://127.0.0.1:{PORT}");
            let win = WebviewWindowBuilder::new(app, "main", WebviewUrl::External(url.parse().unwrap()))
                .title("Mycelium")
                .inner_size(1100.0, 760.0)
                .min_inner_size(820.0, 560.0)
                .transparent(true)
                .title_bar_style(TitleBarStyle::Overlay)
                .disable_drag_drop_handler()
                .build()?;

            #[cfg(target_os = "macos")]
            {
                let _ = apply_vibrancy(&win, NSVisualEffectMaterial::HudWindow, None, None);
            }
            let _ = &win;

            Ok(())
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
