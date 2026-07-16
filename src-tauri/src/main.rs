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
use std::process::{Child, Command, Stdio};
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, Mutex};
use std::time::{Duration, Instant};

use tauri::menu::{Menu, MenuItem, Submenu};
use tauri::{Manager, RunEvent, Theme, TitleBarStyle, WebviewUrl, WebviewWindowBuilder};

const PORT: u16 = 8787;

/// Every spawned child (Node REST, embed, --http, caddy, frpc) + the pidfile that
/// lets us reap sidecars orphaned by a PRIOR hard crash. Killed on app exit.
struct Server {
    children: Mutex<Vec<Child>>,
    pidfile: Option<PathBuf>,
    // Set on shutdown so the supervisor threads stop respawning. The current live
    // :4711 / :8787 pids (owned by those threads, NOT `children`) so reap() can
    // group-kill them.
    shutting_down: Arc<AtomicBool>,
    http_pid: Arc<Mutex<Option<u32>>>,
    rest_pid: Arc<Mutex<Option<u32>>>,
}

/// Append-mode log file for a supervised child's stdout/stderr, under
/// <dataDir>/logs/. Without this, a Finder-launched app discards child stderr
/// entirely — server-rest died three times on 2026-07-15 and the only diagnosis
/// path was re-running it by hand with a pipe.
///
/// Rotation happens AT SPAWN only (name → name.1 when >8MB): a long-lived healthy
/// child keeps its fd and grows the file until its next respawn, and after a
/// rotation the still-running writer keeps appending to the renamed .1 (same open
/// file description) — only the NEXT spawn gets the fresh file. Good enough for a
/// diagnostics tail; not a bounded-size guarantee.
fn child_log(data_dir: &Option<PathBuf>, name: &str) -> Option<std::fs::File> {
    let dir = data_dir.as_ref()?.join("logs");
    std::fs::create_dir_all(&dir).ok()?;
    let p = dir.join(name);
    if std::fs::metadata(&p).map(|m| m.len() > 8 * 1024 * 1024).unwrap_or(false) {
        let _ = std::fs::rename(&p, dir.join(format!("{name}.1")));
    }
    std::fs::OpenOptions::new().create(true).append(true).open(&p).ok()
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

/// Mint one per-launch vault "family" token. Every node process THIS shell spawns that
/// opens the vault (server-rest + the :4711 --http remote MCP, which are SIBLINGS, plus
/// their pipeline children via jobs.js) gets the same token in MYCELIUM_VAULT_FAMILY, so
/// the fail-closed writer lock (src/db/writer-lock.js) recognizes them as one family and
/// lets them share the vault. A FOREIGN process (a stray `node src/index.js` MCP launched
/// by Claude Desktop) has no matching token → it is refused instead of corrupting the WAL.
/// 16 random bytes from /dev/urandom; time+pid fallback (still unique per launch).
fn mint_vault_family_token() -> String {
    use std::io::Read;
    let mut buf = [0u8; 16];
    if let Ok(mut f) = std::fs::File::open("/dev/urandom") {
        if f.read_exact(&mut buf).is_ok() {
            return buf.iter().map(|b| format!("{:02x}", b)).collect();
        }
    }
    let nanos = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.as_nanos())
        .unwrap_or(0);
    format!("{:032x}{:x}", nanos, std::process::id())
}

/// Record a sidecar's pid (+ binary name, for the PID-reuse-safe match) so a
/// crash-orphan can be reaped at next launch.
fn record_pid(pidfile: &Path, pid: u32, name: &str) {
    if let Ok(mut f) = std::fs::OpenOptions::new().create(true).append(true).open(pidfile) {
        let _ = writeln!(f, "{pid}\t{name}");
    }
}

/// SIGTERM a child's whole process group (process_group made pgid == pid).
#[cfg(unix)]
fn term_group(pid: u32) {
    let pgid = pid as i32;
    unsafe { libc::kill(-pgid, libc::SIGTERM); }
}
#[cfg(not(unix))]
fn term_group(_pid: u32) {}

/// Is any member of the group still alive? (signal 0 probe)
#[cfg(unix)]
fn group_alive(pid: u32) -> bool {
    let pgid = pid as i32;
    (unsafe { libc::kill(-pgid, 0) }) == 0
}
#[cfg(not(unix))]
fn group_alive(_pid: u32) -> bool { false }

/// SIGKILL a child's whole process group. Last resort — see reap() for the grace.
#[cfg(unix)]
fn kill_group(pid: u32) {
    let pgid = pid as i32;
    unsafe { libc::kill(-pgid, libc::SIGKILL); }
}
#[cfg(not(unix))]
fn kill_group(_pid: u32) {}

/// Reap every tracked child + clear the pidfile. Idempotent (drain empties).
///
/// GRACEFUL: SIGTERM every group first, then ONE shared grace window, then SIGKILL
/// the stragglers. The old shape (TERM immediately followed by KILL on the next
/// line) gave a SQLite writer ZERO time to finish an in-flight WAL checkpoint —
/// on every quit/update/relaunch. A checkpoint torn mid-write leaves -wal/-shm
/// state that the NEXT boot replays against the database, which is one of the few
/// remaining candidate mechanisms for the recurring vault corruption (five events
/// in two weeks as of 2026-07-16). Six seconds is far above any honest shutdown
/// and the window is shared, not per-child, so quit stays fast.
fn reap(server: &Server) {
    // Flag BEFORE kill so the supervisors see shutdown when their wait() returns
    // and exit instead of respawning.
    server.shutting_down.store(true, Ordering::SeqCst);
    let mut pids: Vec<u32> = Vec::new();
    if let Ok(g) = server.http_pid.lock() {
        if let Some(pid) = *g { pids.push(pid); }
    }
    if let Ok(g) = server.rest_pid.lock() {
        if let Some(pid) = *g { pids.push(pid); }
    }
    let mut kids: Vec<Child> = Vec::new();
    if let Ok(mut guard) = server.children.lock() {
        kids = guard.drain(..).collect();
    }
    for c in &kids { pids.push(c.id()); }

    for p in &pids { term_group(*p); }
    let deadline = Instant::now() + Duration::from_secs(6);
    while Instant::now() < deadline && pids.iter().any(|p| group_alive(*p)) {
        std::thread::sleep(Duration::from_millis(100));
    }
    for p in &pids {
        if group_alive(*p) { kill_group(*p); }
    }
    for mut child in kids {
        let _ = child.kill(); // no-op if already dead; reaps the zombie either way
        let _ = child.wait();
    }
    // Late-publish sweep (review B3): a supervisor that was INSIDE spawn() when we
    // collected pids publishes its child's pid after the fact. The flag stops further
    // respawns and the supervisor's own post-publish check reaps its child — but if
    // that thread is preempted past our exit, the child outlives the app holding the
    // vault. Belt: re-read both slots and reap anything that appeared meanwhile.
    for slot in [&server.http_pid, &server.rest_pid] {
        if let Ok(g) = slot.lock() {
            if let Some(pid) = *g {
                if !pids.contains(&pid) {
                    term_group(pid);
                    std::thread::sleep(Duration::from_millis(300));
                    if group_alive(pid) { kill_group(pid); }
                }
            }
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

// ── Auto-updater ─────────────────────────────────────────────────────────────
// Sentinel meaning "no signing key configured yet". While the pubkey equals this,
// the updater is DORMANT (never checks) — so a dev/unsigned build can't prompt.
const UPDATER_PUBKEY_PLACEHOLDER: &str = "REPLACE_WITH_MINISIGN_PUBLIC_KEY";
// Don't hammer the endpoint on frequent restarts — at most one check per interval.
const UPDATE_CHECK_INTERVAL_SECS: u64 = 6 * 60 * 60;

/// True only when tauri.conf.json plugins.updater.pubkey holds a REAL minisign key
/// (not empty, not the placeholder). Signature verification is mandatory, so an
/// unset key means the updater must stay off rather than prompt-then-fail.
fn updater_pubkey_is_real(app: &tauri::AppHandle) -> bool {
    app.config()
        .plugins
        .0
        .get("updater")
        .and_then(|u| u.get("pubkey"))
        .and_then(|k| k.as_str())
        .map(|k| !k.trim().is_empty() && k != UPDATER_PUBKEY_PLACEHOLDER)
        .unwrap_or(false)
}

/// Best-effort throttle. Returns true (and stamps "now") if no check happened
/// within UPDATE_CHECK_INTERVAL_SECS; fail-open (unreadable stamp → check now).
fn update_check_due(app: &tauri::AppHandle) -> bool {
    use std::time::{SystemTime, UNIX_EPOCH};
    let Ok(dir) = app.path().app_data_dir() else { return true; };
    let stamp = dir.join(".update-check");
    let now = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|d| d.as_secs())
        .unwrap_or(0);
    if let Ok(s) = std::fs::read_to_string(&stamp) {
        if let Ok(prev) = s.trim().parse::<u64>() {
            if now.saturating_sub(prev) < UPDATE_CHECK_INTERVAL_SECS {
                return false;
            }
        }
    }
    let _ = std::fs::create_dir_all(&dir);
    let _ = std::fs::write(&stamp, now.to_string());
    true
}

/// Fire-and-forget update check. Gated on a real signing pubkey + the throttle;
/// on an available, signature-verified update it shows a NATIVE prompt (no webview
/// IPC), and on accept downloads + installs + relaunches. Every failure path is
/// fail-open — a down endpoint or network error never blocks or crashes the app.
/// The vault lives outside the .app bundle, so the swap preserves all user data.
fn maybe_check_for_update(app: tauri::AppHandle) {
    use tauri_plugin_dialog::{DialogExt, MessageDialogButtons, MessageDialogKind};
    use tauri_plugin_updater::UpdaterExt;

    if !updater_pubkey_is_real(&app) || !update_check_due(&app) {
        return;
    }

    tauri::async_runtime::spawn(async move {
        let updater = match app.updater() {
            Ok(u) => u,
            Err(e) => {
                eprintln!("[updater] unavailable: {e}");
                return;
            }
        };
        match updater.check().await {
            Ok(Some(update)) => {
                let version = update.version.clone();
                let notes = update.body.clone().unwrap_or_default();
                let app_for_dialog = app.clone();
                app.dialog()
                    .message(format!(
                        "Mycelium {version} is available.\n\n{}\n\nUpdate now? The app will restart; your vault is untouched.",
                        notes.trim()
                    ))
                    .title("Update available")
                    .kind(MessageDialogKind::Info)
                    .buttons(MessageDialogButtons::OkCancelCustom(
                        "Update & Restart".into(),
                        "Later".into(),
                    ))
                    .show(move |accepted| {
                        if !accepted {
                            return;
                        }
                        let app_for_install = app_for_dialog.clone();
                        tauri::async_runtime::spawn(async move {
                            // download_and_install verifies the Ed25519 signature over
                            // the tarball against the configured pubkey before swapping.
                            match update
                                .download_and_install(|_chunk, _total| {}, || {})
                                .await
                            {
                                // restart() fires RunEvent::Exit → reap() kills the
                                // node/frpc/caddy sidecars first, so the new version
                                // doesn't collide on :4711 / :8787.
                                Ok(()) => app_for_install.restart(),
                                Err(e) => eprintln!("[updater] install failed: {e}"),
                            }
                        });
                    });
            }
            Ok(None) => { /* already up to date */ }
            Err(e) => eprintln!("[updater] check failed: {e}"), // fail-open
        }
    });
}

/// Relaunch the app after a destroy-vault (factory reset). The node REST endpoint
/// `POST /api/v1/account/destroy` — gated by the recovery key + typed phrase — has
/// ALREADY wiped the vault, keys, and app data before the UI invokes this. This
/// only restarts: `restart()` fires `RunEvent::Exit` → `reap()` (kills the node /
/// frpc / caddy sidecars) → the fresh process boots against an empty data dir +
/// empty Keychain → onboarding. It performs no deletion itself and takes no args,
/// so the new Tauri IPC surface can't be abused to destroy anything.
#[tauri::command]
fn destroy_and_relaunch(app: tauri::AppHandle) {
    app.restart();
}

fn main() {
    let app = tauri::Builder::default()
        .plugin(tauri_plugin_updater::Builder::new().build())
        .plugin(tauri_plugin_process::init())
        .plugin(tauri_plugin_dialog::init())
        .setup(|app| {
            let home = mycelium_home(app);
            let key_source =
                std::env::var("MYCELIUM_KEY_SOURCE").unwrap_or_else(|_| "keychain".into());
            let data_dir: Option<PathBuf> = app.path().app_data_dir().ok();
            // DEV BUILD ("Mycelium Dev", identifier id.mycelium.app.dev): run against
            // the PRODUCTION vault (id.mycelium.app) AND enable the fail-closed
            // pre-migration snapshot — so the dev app can be the daily driver on the
            // real vault while every schema change is snapshotted first. Detected by
            // the data-dir suffix (no config plumbing); production (non-.dev) is
            // byte-for-byte unaffected.
            let is_dev = data_dir
                .as_ref()
                .and_then(|d| d.file_name())
                .map(|n| n.to_string_lossy().ends_with(".dev"))
                .unwrap_or(false);
            let data_dir: Option<PathBuf> = if is_dev {
                data_dir.map(|d| d.with_file_name("id.mycelium.app"))
            } else {
                data_dir
            };
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
                else if existing.is_empty() { "--max-old-space-size=6144".to_string() }
                else { format!("{} --max-old-space-size=6144", existing) }
            };
            // One vault-family token per launch, shared by server-rest + the :4711 --http
            // sibling (and their pipeline children) so the writer lock treats them as one
            // family. See mint_vault_family_token() + src/db/writer-lock.js.
            let vault_family = mint_vault_family_token();

            // Node REST + portal (:8787) — SUPERVISED (same pattern as the :4711
            // thread below). It used to be a fire-and-forget spawn: when server-rest
            // died on an uncaught error the shell never noticed, the UI kept talking
            // to a dead port ("Load failed"), and its stderr — the only diagnosis —
            // went to /dev/null under a Finder launch. Observed three times on
            // 2026-07-15 alone. Now: respawn with backoff, stderr/stdout captured to
            // <dataDir>/logs/server-rest.log, stop flag honoured on quit.
            let shutting_down = Arc::new(AtomicBool::new(false));
            let rest_pid: Arc<Mutex<Option<u32>>> = Arc::new(Mutex::new(None));
            {
                let r_node = node_bin.clone();
                let r_home = home.clone();
                let r_opts = node_options.clone();
                let r_family = vault_family.clone();
                let r_key = key_source.clone();
                let r_python = python_bin.clone();
                let r_hf = hf_home.clone();
                let r_data = data_dir.clone();
                let r_flag = shutting_down.clone();
                let r_pid = rest_pid.clone();
                let r_bundled = bundled;
                let r_dev = is_dev;
                std::thread::spawn(move || {
                    let spawn_rest = || {
                        let mut cmd = Command::new(&r_node);
                        cmd.arg("src/server-rest.js")
                            .current_dir(&r_home)
                            .env("NODE_OPTIONS", &r_opts)
                            .env("MYCELIUM_REST_PORT", PORT.to_string())
                            .env("MYCELIUM_VAULT_FAMILY", &r_family)
                            .env("MYCELIUM_KEY_SOURCE", &r_key);
                        if r_bundled {
                            // Make the bundled node + python resolvable to the clustering child
                            // (src/jobs.js → run-clustering.sh, whose JS stages call bare `node`),
                            // and hand the explicit python down via MYCELIUM_PYTHON (the
                            // run-clustering.sh $PYTHON seam from the fresh-user-provisioning work).
                            let path = std::env::var("PATH").unwrap_or_default();
                            cmd.env(
                                "PATH",
                                format!("{}:{}:{}", r_home.display(), r_home.join("python/bin").display(), path),
                            )
                            .env("MYCELIUM_PYTHON", &r_python);
                            // Whole-vault at-rest encryption (A′) — ON in the packaged app, OFF
                            // in `cargo tauri dev` (bundled=false) so a dev vault is never
                            // surprise-migrated. index.js boot derives the DB key from the
                            // master key, runs the idempotent encrypt-in-place migration (fresh
                            // vaults are born encrypted), then opens every connection keyed.
                            // MUST also be set on the :4711 supervisor below — it opens the SAME
                            // vault, and a plaintext open of an encrypted file fail-closes.
                            cmd.env("MYCELIUM_AT_REST", "1");
                            // On-disk search (FTS5 + sqlite-vec INSIDE the encrypted vault) is a
                            // package deal with at-rest: the in-RAM index would otherwise
                            // re-decrypt + rebuild ALL messages into the heap on every boot
                            // (minutes of event-loop starvation through the cipher). The on-disk
                            // index persists + queries run in C. @see src/search/index.js.
                            cmd.env("MYCELIUM_SEARCH_BACKEND", "sqlite");
                        }
                        if r_hf.exists() {
                            // Offline embedding model bundled under Resources/app/hf-cache.
                            cmd.env("HF_HOME", &r_hf).env("HF_HUB_OFFLINE", "1");
                        }
                        // Durable per-OS data dir — keeps the encrypted vault OUTSIDE the .app
                        // (see src/paths.js), so replacing the .app never wipes the user's history.
                        if let Some(d) = &r_data {
                            cmd.env("MYCELIUM_DATA_DIR", d);
                        }
                        if r_dev {
                            cmd.env("MYCELIUM_SNAPSHOT_ON_BOOT", "1");
                        }
                        // Child diagnostics survive a Finder launch (see child_log).
                        if let Some(f) = child_log(&r_data, "server-rest.log") {
                            if let Ok(out) = f.try_clone() {
                                cmd.stdout(Stdio::from(out));
                            }
                            cmd.stderr(Stdio::from(f));
                        }
                        set_group(&mut cmd);
                        cmd.spawn()
                    };
                    let mut backoff = Duration::from_secs(1);
                    loop {
                        if r_flag.load(Ordering::SeqCst) {
                            break;
                        }
                        match spawn_rest() {
                            Ok(mut c) => {
                                if let Ok(mut g) = r_pid.lock() {
                                    *g = Some(c.id());
                                }
                                // CLOSE THE QUIT RACE (review B3): reap() may have collected
                                // pids while we were inside spawn_rest() — the shutdown flag
                                // is set, but nobody knows OUR child yet. Re-check now that
                                // the pid is published and reap our own child, or it outlives
                                // the app HOLDING THE VAULT (the exact two-writer hazard).
                                if r_flag.load(Ordering::SeqCst) {
                                    term_group(c.id());
                                    std::thread::sleep(Duration::from_millis(500));
                                    if group_alive(c.id()) { kill_group(c.id()); }
                                    let _ = c.wait();
                                    if let Ok(mut g) = r_pid.lock() { *g = None; }
                                    break;
                                }
                                let started = Instant::now();
                                let _ = c.wait();
                                if let Ok(mut g) = r_pid.lock() {
                                    *g = None;
                                }
                                if r_flag.load(Ordering::SeqCst) {
                                    break;
                                }
                                // A healthy run resets the backoff; a fast crash grows
                                // it (capped) so we never hot-loop a broken server.
                                if started.elapsed() >= Duration::from_secs(60) {
                                    backoff = Duration::from_secs(1);
                                }
                                eprintln!("[mycelium] server-rest (:8787) exited — restarting in {}s (see logs/server-rest.log)", backoff.as_secs());
                                std::thread::sleep(backoff);
                                backoff = std::cmp::min(backoff * 2, Duration::from_secs(30));
                            }
                            Err(e) => {
                                eprintln!("[mycelium] server-rest did not start ({e}) — is `node` installed and MYCELIUM_HOME correct? retry in {}s", backoff.as_secs());
                                std::thread::sleep(backoff);
                                backoff = std::cmp::min(backoff * 2, Duration::from_secs(30));
                            }
                        }
                    }
                });
            }

            // Embed service (:8091) is now OWNED BY THE NODE SERVER
            // (src/embed/supervisor.js): it dep-checks, adopts-or-spawns, RESTARTS
            // on crash, and surfaces health to the UI via /processing-status — so no
            // fire-and-forget Rust spawn here (which never noticed a post-spawn crash
            // and left the UI hanging at "Processing 0/N").
            let mut children: Vec<Child> = vec![];
            // Shared with the :4711 supervisor thread (created below, when remote is on).
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
                    let sup_family = vault_family.clone(); // same family token as server-rest
                    let sup_flag = shutting_down.clone();
                    let sup_pid = http_pid.clone();
                    // Same at-rest decision as the :8787 server (bundled = packaged
                    // app). This process opens the SAME vault; without the flag it
                    // would try a plaintext open of the encrypted file and fail-close.
                    let sup_at_rest = bundled;
                    let sup_dev = is_dev;
                    std::thread::spawn(move || {
                        let spawn_http = || {
                            let mut http = Command::new(&sup_node);
                            http.arg("src/index.js")
                                .arg("--http")
                                .current_dir(&sup_home)
                                .env("NODE_OPTIONS", &sup_opts)
                                .env("MYCELIUM_PORT", "4711")
                                .env("MYCELIUM_VAULT_FAMILY", &sup_family)
                                .env("MYCELIUM_KEY_SOURCE", &sup_key)
                                .env("MYCELIUM_DATA_DIR", &sup_data);
                            if sup_at_rest {
                                http.env("MYCELIUM_AT_REST", "1");
                                http.env("MYCELIUM_SEARCH_BACKEND", "sqlite"); // on-disk search (see server-rest spawn)
                            }
                            if sup_dev {
                                http.env("MYCELIUM_SNAPSHOT_ON_BOOT", "1");
                            }
                            if !public_host.is_empty() {
                                http.env("MYCELIUM_BASE_URL", format!("https://{public_host}"));
                            }
                            // Child diagnostics survive a Finder launch (see child_log).
                            if let Some(f) = child_log(&Some(sup_data.clone()), "mcp-4711.log") {
                                if let Ok(out) = f.try_clone() {
                                    http.stdout(Stdio::from(out));
                                }
                                http.stderr(Stdio::from(f));
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
                                    // Same quit-race close as the server-rest supervisor
                                    // (review B3) — this race pre-existed here too.
                                    if sup_flag.load(Ordering::SeqCst) {
                                        term_group(c.id());
                                        std::thread::sleep(Duration::from_millis(500));
                                        if group_alive(c.id()) { kill_group(c.id()); }
                                        let _ = c.wait();
                                        if let Ok(mut g) = sup_pid.lock() { *g = None; }
                                        break;
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
                rest_pid,
            });

            // Wait for the REST server to bind before pointing the webview at it.
            // A build that adds DB migrations makes the FIRST boot slow: snapshot-on-boot
            // does a `VACUUM INTO` of the (multi-GB) vault + applyMigrations BEFORE the
            // server listens, which can exceed this window. WKWebView loads the not-yet-up
            // URL exactly once and does NOT retry → a white screen that needed a manual
            // Cmd+R. So we DON'T block forever here (fast boots shouldn't wait): we record
            // whether the server was ready, and if not, a watcher below re-navigates the
            // webview the instant the port binds. Normal relaunches are unaffected.
            let server_ready = wait_for_port(PORT, Duration::from_secs(25));
            if !server_ready {
                eprintln!("[mycelium] server not up within 25s (slow first-boot migration?); webview will self-heal on bind");
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
                // Start the native window DARK to match the app's dark default, so the
                // title-bar strip is themed from the first frame (no white flash before
                // the webview loads + calls set_theme). The frontend flips it to light if
                // the user's persisted theme is light (theme.ts → plugin:window|set_theme).
                .theme(Some(Theme::Dark))
                // Disable Tauri's native OS file-drop handler so the webview's
                // HTML5 drag-drop (the Import drop zone) receives dropped files.
                // Without this, WKWebView swallows the drop and dataTransfer.files
                // is empty — "drag an export in" silently does nothing.
                .disable_drag_drop_handler()
                .build()?;

            // Self-heal a slow first boot: if the server wasn't listening when we built
            // the window, WKWebView is now showing a failed-load (white) page and won't
            // retry on its own. Poll for the port on a longer ceiling and re-navigate the
            // webview the instant it binds — turning a white screen into an automatic
            // reload. Only runs when the initial 25s wait failed, so a fast boot never
            // re-navigates (no flicker). `navigate` forces a fresh load regardless of the
            // current error page (unlike an in-page reload, which a dead page can't run).
            if !server_ready {
                let win_heal = win.clone();
                let heal_url = url.clone();
                std::thread::spawn(move || {
                    if wait_for_port(PORT, Duration::from_secs(300)) {
                        std::thread::sleep(Duration::from_millis(500)); // let the listener accept connections
                        if let Ok(u) = heal_url.parse() {
                            if let Err(e) = win_heal.navigate(u) {
                                eprintln!("[mycelium] self-heal navigate failed: {e}");
                            } else {
                                eprintln!("[mycelium] server bound late — reloaded the webview");
                            }
                        }
                    } else {
                        eprintln!("[mycelium] server still not up after 300s — leaving the webview as-is");
                    }
                });
            }

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

            // Auto-updater — PRODUCTION builds only. The "Mycelium Dev" variant (0.1.0,
            // .dev data dir) must never self-update to the public release. Fire-and-
            // forget, throttled, signature-verified, fail-open — never blocks launch.
            if !is_dev {
                maybe_check_for_update(app.handle().clone());
            }

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
        .invoke_handler(tauri::generate_handler![destroy_and_relaunch])
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
