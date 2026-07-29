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
use tauri::{window::Color, Manager, RunEvent, Theme, TitleBarStyle, WebviewUrl, WebviewWindowBuilder};

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
        // NO VAULT SEAL HERE, deliberately. A previous revision sealed the vault at this
        // point, and an adversarial review showed why that is wrong: "my children are gone"
        // is NOT "nobody owns the vault". A foreign stdio MCP can own it while this app's
        // own siblings are refused and the supervisor respawns them; quitting the
        // dead-looking app then sealed the vault UNDER that live MCP, which silently lost
        // every fresh-connection write for the rest of its life. Sealing now belongs to
        // whichever process leaves LAST, decided from presence locks — src/db/vault-lease.js.
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

/// The update the UI banner reads (see get_available_update). Cleared to None when a
/// check finds we're current, set when a newer signed build is available.
#[derive(Clone)]
struct AvailableUpdate {
    version: String,
    notes: String,
}

/// Managed state: the latest known available update (None = up to date / not checked).
#[derive(Default)]
struct UpdateState(std::sync::Mutex<Option<AvailableUpdate>>);

/// Run one signature-verified check and STORE the result in UpdateState for the in-app
/// banner to surface (no native dialog — the sidebar banner is the notification, and the
/// user drives the install via install_update). Fail-open: a down endpoint never throws.
async fn perform_update_check(app: tauri::AppHandle) {
    use tauri_plugin_updater::UpdaterExt;
    let updater = match app.updater() {
        Ok(u) => u,
        Err(e) => {
            eprintln!("[updater] unavailable: {e}");
            return;
        }
    };
    match updater.check().await {
        Ok(Some(update)) => {
            let info = AvailableUpdate {
                version: update.version.clone(),
                notes: update.body.clone().unwrap_or_default(),
            };
            eprintln!("[updater] update available: {}", info.version);
            if let Some(state) = app.try_state::<UpdateState>() {
                *state.0.lock().unwrap() = Some(info);
            }
        }
        Ok(None) => {
            if let Some(state) = app.try_state::<UpdateState>() {
                *state.0.lock().unwrap() = None; // we're current
            }
        }
        Err(e) => eprintln!("[updater] check failed: {e}"), // fail-open
    }
}

/// Launch-time check — gated on a real signing pubkey + the throttle (so frequent
/// restarts don't hammer GitHub). start_update_ticker() then keeps checking while the
/// app runs so an always-open app still notices new releases.
fn maybe_check_for_update(app: tauri::AppHandle) {
    if !updater_pubkey_is_real(&app) || !update_check_due(&app) {
        return;
    }
    tauri::async_runtime::spawn(async move { perform_update_check(app).await });
}

/// Periodic re-check while the app is running (closes the "left-open app never re-checks"
/// gap). A std thread sleeps the interval, then spawns the async check. Pubkey-gated.
fn start_update_ticker(app: tauri::AppHandle) {
    if !updater_pubkey_is_real(&app) {
        return;
    }
    std::thread::spawn(move || loop {
        std::thread::sleep(std::time::Duration::from_secs(UPDATE_CHECK_INTERVAL_SECS));
        let a = app.clone();
        tauri::async_runtime::spawn(async move { perform_update_check(a).await });
    });
}

/// The in-app banner polls this. Returns `{ version, notes }` or null — built as a
/// serde_json::Value (the crate's convention: serde_json, no serde derive) so it
/// serializes over the IPC boundary.
#[tauri::command]
fn get_available_update(state: tauri::State<UpdateState>) -> Option<serde_json::Value> {
    state
        .0
        .lock()
        .ok()
        .and_then(|g| g.as_ref().map(|u| serde_json::json!({ "version": u.version, "notes": u.notes })))
}

/// The banner's "Update" button invokes this. Re-verifies against the pubkey, downloads +
/// installs, then restarts (reap() kills the sidecars first so ports don't collide).
#[tauri::command]
async fn install_update(app: tauri::AppHandle) -> Result<(), String> {
    use tauri_plugin_updater::UpdaterExt;
    let updater = app.updater().map_err(|e| e.to_string())?;
    match updater.check().await.map_err(|e| e.to_string())? {
        Some(update) => {
            update
                .download_and_install(|_chunk, _total| {}, || {})
                .await
                .map_err(|e| e.to_string())?;
            app.restart(); // fires RunEvent::Exit → reap() before the new version binds
            #[allow(unreachable_code)]
            Ok(())
        }
        None => Err("no update available".into()),
    }
}

/// The runtime app version (the installed binary's package version), for the
/// Settings → General "About" block. Uses package_info() — the REAL running version,
/// not the config string — so it's accurate for every variant.
#[tauri::command]
fn app_version(app: tauri::AppHandle) -> String {
    app.package_info().version.to_string()
}

/// Whether this is the ".dev" daily-driver variant (see setup: is_dev). Stored in
/// managed state so commands can honor the SAME production gate the auto-updater uses.
struct IsDevBuild(bool);

/// Manual "Check for updates" (Settings → General). Wraps the SAME signature-verified
/// updater the background auto-updater uses. The user explicitly asked, so this BYPASSES
/// the 6h throttle — but every other guarantee is intact: production-only (never a
/// dev-server build nor the ".dev" variant, neither of which can swap their own binary
/// or should self-update to the public release) + real-pubkey-gated + the plugin verifies
/// the minisign signature inside check(). Never throws — it returns a small status object
/// the UI renders. Mirrors any result into UpdateState so the sidebar banner stays
/// consistent with a manual check.
#[tauri::command]
async fn check_for_update(app: tauri::AppHandle) -> serde_json::Value {
    use tauri_plugin_updater::UpdaterExt;
    // Production gate: a debug/dev-server build (`cargo tauri dev`) can't replace its own
    // running binary, and the ".dev" bundled variant must never self-update to the public
    // release. Pubkey gate: no real minisign key ⇒ the updater is dormant (never prompt).
    let is_dev_build =
        cfg!(debug_assertions) || app.try_state::<IsDevBuild>().map(|s| s.0).unwrap_or(false);
    if is_dev_build || !updater_pubkey_is_real(&app) {
        return serde_json::json!({ "state": "unsupported" });
    }
    // D-022: every error branch is STAGE-LABELLED and guaranteed non-empty. A bare
    // e.to_string() can be empty (some plugin errors stringify to ""), which reaches the UI
    // as a message-less rejection ("check failed"). The label also tells the operator WHERE
    // it broke — updater-plugin init (a config/build problem) vs. the network check (the
    // common transient) — without ever leaking a path or secret (§1): these plugin/reqwest
    // errors carry the failure class, not the resolved binary location.
    let updater = match app.updater() {
        Ok(u) => u,
        Err(e) => {
            let d = e.to_string();
            let d = if d.trim().is_empty() { "plugin not initialized".to_string() } else { d };
            return serde_json::json!({ "state": "error", "error": format!("updater unavailable: {d}") });
        }
    };
    match updater.check().await {
        Ok(Some(update)) => {
            let version = update.version.clone();
            let notes = update.body.clone().unwrap_or_default();
            if let Some(state) = app.try_state::<UpdateState>() {
                // Poison-tolerant: recover the guard rather than panic. A panic here would
                // turn a SUCCESSFUL check into a message-less IPC rejection (the very D-022
                // symptom); the stored value is a plain Option, safe to write through poison.
                *state.0.lock().unwrap_or_else(|p| p.into_inner()) =
                    Some(AvailableUpdate { version: version.clone(), notes: notes.clone() });
            }
            serde_json::json!({ "state": "available", "version": version, "notes": notes })
        }
        Ok(None) => {
            if let Some(state) = app.try_state::<UpdateState>() {
                *state.0.lock().unwrap_or_else(|p| p.into_inner()) = None; // we're current
            }
            serde_json::json!({ "state": "uptodate" })
        }
        Err(e) => {
            let d = e.to_string();
            let d = if d.trim().is_empty() { "no detail from updater".to_string() } else { d };
            serde_json::json!({ "state": "error", "error": format!("update check failed: {d}") }) // fail-soft
        }
    }
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
        // D-010: open the browser sign-in URL in the OS default browser. The webview
        // is a remote http origin that swallows window.open('_blank'); the frontend
        // (open-external.ts) invokes plugin:opener|open_url instead. Scope is granted
        // in capabilities/default.json (open_url for http/https only).
        .plugin(tauri_plugin_opener::init())
        .setup(|app| {
            let home = mycelium_home(app);
            let key_source =
                std::env::var("MYCELIUM_KEY_SOURCE").unwrap_or_else(|_| "keychain".into());
            let data_dir: Option<PathBuf> = app.path().app_data_dir().ok();
            // D-082 (2026-07-27): a NON-RELEASE BUILD MUST NOT RESOLVE THE PRODUCTION
            // VAULT. This used to do the exact opposite — a ".dev" bundle was rewritten
            // onto id.mycelium.app so the dev app could be "the daily driver on the real
            // vault". Combined with D-080 that meant an unsigned local build could open,
            // and re-initialise, the production vault with no confirmation. The hazard
            // had already been recognised for the SCHEMA (at-rest is forced off under
            // `cargo tauri dev`, below) and not for the vault's IDENTITY.
            //
            // Two independent ways a build is non-release, because either alone leaks:
            //   · the bundle identifier ends in `.dev` (the `Mycelium Dev` bundle), and
            //   · debug_assertions — a plain `cargo tauri build`/`dev` of the PRODUCTION
            //     config, which keeps the production identifier and is what an unsigned
            //     local build actually is.
            // Each resolves to its own sibling directory, so the production vault is
            // reachable only from a release build of the production bundle.
            let is_dev_bundle = data_dir
                .as_ref()
                .and_then(|d| d.file_name())
                .map(|n| n.to_string_lossy().ends_with(".dev"))
                .unwrap_or(false);
            let is_dev = is_dev_bundle || cfg!(debug_assertions);
            let data_dir: Option<PathBuf> = if is_dev && !is_dev_bundle {
                data_dir.map(|d| {
                    let name = d.file_name().map(|n| n.to_string_lossy().to_string())
                        .unwrap_or_else(|| "id.mycelium.app".into());
                    d.with_file_name(format!("{name}.dev"))
                })
            } else {
                data_dir
            };
            if is_dev {
                if let Some(d) = &data_dir {
                    eprintln!(
                        "[mycelium] NON-RELEASE BUILD — using the development vault at {} (the production vault is not touched)",
                        d.display()
                    );
                }
            }
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
                        // D-081: the pre-boot snapshot is DEFAULT-ON in the node layer
                        // now (src/account/snapshot-on-boot.js). It is deliberately NOT
                        // set here any more — this dev-only setter is exactly why the
                        // production app, the one users run, had no local backup.
                        let _ = r_dev;
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
                            // D-081: default-on in the node layer; see the server-rest spawn.
                            let _ = sup_dev;
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
            app.manage(UpdateState::default()); // the in-app update banner reads this
            app.manage(IsDevBuild(is_dev)); // check_for_update honors the production gate

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
                // TRANSPARENT title bar (was Visible). `Visible` painted the strip with
                // the SYSTEM window chrome — a mid grey that never matched the app's
                // #0A0A0C, so a seam sat above the UI even once set_theme made the strip
                // "dark". Transparent makes macOS paint the strip with the WINDOW'S OWN
                // background colour instead, which we set below (and keep synced to the
                // live --color-bg on every theme change), so the strip IS the app
                // background — no seam, both themes.
                //
                // ⚠️ This is NOT the Overlay regression. Overlay was rejected because it
                // flowed content UNDER the traffic lights, forcing a left-clearance that
                // pushed the header out of line with the sidebar. Transparent does not:
                // Overlay = titlebar_transparent(true) + fullsize_content_view(TRUE),
                // Transparent = titlebar_transparent(true) + fullsize_content_view(FALSE)
                // (tauri-runtime-wry-2.11.2/src/lib.rs:1202-1209). Content still starts
                // BELOW the strip; only the strip's paint changes.
                .title_bar_style(TitleBarStyle::Transparent)
                .hidden_title(true)
                // The strip's actual colour for frame one = the dark theme's --color-bg
                // (tokens.css:20). A literal is unavoidable here — Rust can't read the
                // stylesheet — but it is only the FIRST-FRAME value: theme.ts re-reads
                // the live var and calls set_background_color, so a palette change can
                // only ever cost one frame, never a lasting mismatch. Also sets the
                // WEBVIEW layer's background (builder sets both), which kills the white
                // flash before the page paints.
                .background_color(Color(0x0A, 0x0A, 0x0C, 255))
                // Start the native window DARK to match the app's dark default, so the
                // title-bar strip is themed from the first frame (no white flash before
                // the webview loads + calls set_theme). The frontend flips it to light if
                // the user's persisted theme is light (theme.ts → plugin:window|set_theme).
                // Still needed alongside the colour: appearance drives the traffic-light
                // glyphs + native menus; background_color drives the strip's fill.
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
                maybe_check_for_update(app.handle().clone()); // once, at launch
                start_update_ticker(app.handle().clone()); // + every 6h while running
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
        .invoke_handler(tauri::generate_handler![
            destroy_and_relaunch,
            get_available_update,
            install_update,
            app_version,
            check_for_update
        ])
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
