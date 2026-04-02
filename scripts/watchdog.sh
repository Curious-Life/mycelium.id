#!/bin/bash
# Mycelium Watchdog — checks critical services and restarts if down
# Run via PM2 cron every 5 minutes
#
# Checks:
# 1. PM2 processes that should be online
# 2. Agent HTTP health endpoints
# 3. Agent git repos (lock files, disk space)
# 4. War room dashboard + daemon

set -euo pipefail

LOG_PREFIX="[watchdog]"
DISCORD_WEBHOOK="${DISCORD_ALERT_WEBHOOK:-}"
RESTART_COUNT=0
ISSUES=()

log() { echo "$(date -u '+%Y-%m-%d %H:%M:%S') $LOG_PREFIX $*"; }

alert() {
  log "ALERT: $*"
  if [ -n "$DISCORD_WEBHOOK" ]; then
    curl -s -X POST "$DISCORD_WEBHOOK" \
      -H "Content-Type: application/json" \
      -d "{\"content\":\"🚨 **Watchdog Alert**\\n$*\"}" > /dev/null 2>&1 || true
  fi
}

# Services that should always be running (PM2 process names)
CRITICAL_PROCESSES=(
  "orchestrator"
  "personal-agent"
  "company-agent"
  "research-agent"
  "commercial-intelligence-agent"
  "publishing-agent"
  "wealth-agent"
  "intel-agent"
  "qa-agent"
  "mya-discord-bot"
  "mya-telegram-bot"
  "research-discord-bot"
  "commercial-intel-discord-bot"
  "publishing-discord-bot"
  "wealth-discord-bot"
  "intel-discord-bot"
  "com-scheduler"
  "mya-scheduler"
  "wealth-scheduler"
  "intel-scheduler"
  "warroom-daemon"
  "warroom-dashboard"
)

# Health check endpoints (agent port map)
declare -A HEALTH_ENDPOINTS=(
  ["personal-agent"]="http://127.0.0.1:3004/health"
  ["company-agent"]="http://127.0.0.1:3002/health"
  ["research-agent"]="http://127.0.0.1:5002/health"
  ["commercial-intelligence-agent"]="http://127.0.0.1:5004/health"
  ["publishing-agent"]="http://127.0.0.1:5006/health"
  ["wealth-agent"]="http://127.0.0.1:5010/health"
  ["intel-agent"]="http://127.0.0.1:5012/health"
  ["qa-agent"]="http://127.0.0.1:5008/health"
  ["warroom-dashboard"]="http://127.0.0.1:8050/api/state"
)

# Agent repos — agents run Claude Code inside these directories
AGENT_REPOS_DIR="${AGENT_REPOS_DIR:-/home/claude/agents}"
AGENT_REPOS=(
  "personal-agent"
  "company-agent"
  "research-agent"
  "commercial-intelligence-agent"
  "publishing-agent"
  "wealth-agent"
  "intel-agent"
  "qa-agent"
)

# Cache pm2 jlist once (avoid calling it per-process)
PM2_JSON=$(pm2 jlist 2>/dev/null || echo "[]")

get_pm2_status() {
  echo "$PM2_JSON" | python3 -c "
import sys, json
procs = json.load(sys.stdin)
for p in procs:
    if p['name'] == '$1':
        print(p['pm2_env']['status'])
        break
else:
    print('not_found')
" 2>/dev/null || echo "error"
}

get_pm2_restarts() {
  echo "$PM2_JSON" | python3 -c "
import sys, json
procs = json.load(sys.stdin)
for p in procs:
    if p['name'] == '$1':
        print(p['pm2_env'].get('restart_time', 0))
        break
else:
    print('0')
" 2>/dev/null || echo "0"
}

# --- Check 1: PM2 process status ---
log "Checking PM2 processes..."
for proc in "${CRITICAL_PROCESSES[@]}"; do
  status=$(get_pm2_status "$proc")

  if [ "$status" = "online" ]; then
    continue
  elif [ "$status" = "stopped" ] || [ "$status" = "errored" ]; then
    log "$proc is $status — restarting..."
    pm2 restart "$proc" 2>/dev/null || true
    RESTART_COUNT=$((RESTART_COUNT + 1))
    alert "$proc was **$status** — restarted"
  elif [ "$status" = "not_found" ]; then
    log "$proc not found in PM2 — skipping"
  else
    log "$proc status: $status"
  fi
done

# --- Check 2: HTTP health endpoints ---
log "Checking health endpoints..."
for proc in "${!HEALTH_ENDPOINTS[@]}"; do
  url="${HEALTH_ENDPOINTS[$proc]}"
  http_code=$(curl -s -o /dev/null -w '%{http_code}' --connect-timeout 5 --max-time 10 "$url" 2>/dev/null || echo "000")

  if [ "$http_code" = "200" ]; then
    continue
  elif [ "$http_code" = "000" ]; then
    pm2_status=$(get_pm2_status "$proc")
    if [ "$pm2_status" = "online" ]; then
      log "$proc HTTP unreachable (PM2 says online) — restarting..."
      pm2 restart "$proc" 2>/dev/null || true
      RESTART_COUNT=$((RESTART_COUNT + 1))
      alert "$proc was **unresponsive** (HTTP dead) — restarted"
    fi
  else
    log "$proc returned HTTP $http_code (may be transient)"
  fi
done

# --- Check 3: Agent git repos ---
log "Checking agent repos..."
for agent in "${AGENT_REPOS[@]}"; do
  repo_path="$AGENT_REPOS_DIR/$agent/repo"

  if [ ! -d "$repo_path" ]; then
    log "$agent repo not found at $repo_path — skipping"
    continue
  fi

  # Check for stale git lock files (> 10 min old = likely orphaned)
  lock_file="$repo_path/.git/index.lock"
  if [ -f "$lock_file" ]; then
    lock_age=$(( $(date +%s) - $(stat -c %Y "$lock_file" 2>/dev/null || echo "0") ))
    if [ "$lock_age" -gt 600 ]; then
      log "$agent has stale git lock ($lock_age s old) — removing..."
      rm -f "$lock_file"
      ISSUES+=("$agent: removed stale git lock (${lock_age}s old)")
      alert "$agent had a **stale git lock** (${lock_age}s) — removed"
    else
      log "$agent has git lock (${lock_age}s old, still fresh)"
    fi
  fi

  # Check for corrupted git state
  if ! cd "$repo_path" || ! git status > /dev/null 2>&1; then
    log "$agent git repo may be corrupted"
    ISSUES+=("$agent: git status failed")
    alert "$agent **git repo error** — may need manual fix"
  fi

  # Check disk usage of repo (warn if > 2GB)
  repo_size=$(du -sm "$repo_path" 2>/dev/null | cut -f1 || echo "0")
  if [ "$repo_size" -gt 2048 ]; then
    log "$agent repo is ${repo_size}MB — may need cleanup"
    ISSUES+=("$agent: repo ${repo_size}MB")
  fi
done

# --- Check 4: War room repo ---
WARROOM_PATH="${WARROOM_PATH:-/home/claude/repos/war-room}"
if [ -d "$WARROOM_PATH" ]; then
  log "Checking war room repo..."
  lock_file="$WARROOM_PATH/.git/index.lock"
  if [ -f "$lock_file" ]; then
    lock_age=$(( $(date +%s) - $(stat -c %Y "$lock_file" 2>/dev/null || echo "0") ))
    if [ "$lock_age" -gt 600 ]; then
      log "War room has stale git lock ($lock_age s old) — removing..."
      rm -f "$lock_file"
      alert "War room had a **stale git lock** — removed"
    fi
  fi
fi

# --- Check 5: Disk space ---
disk_pct=$(df / 2>/dev/null | tail -1 | awk '{print $5}' | tr -d '%')
if [ "$disk_pct" -gt 90 ]; then
  alert "**Disk usage at ${disk_pct}%** — running low"
  ISSUES+=("Disk at ${disk_pct}%")
elif [ "$disk_pct" -gt 80 ]; then
  log "Disk usage at ${disk_pct}% — getting high"
fi

# --- Check 6: Crash loop detection ---
log "Checking for crash loops..."
for proc in "${CRITICAL_PROCESSES[@]}"; do
  restarts=$(get_pm2_restarts "$proc")
  if [ "$restarts" -gt 20 ]; then
    log "$proc has $restarts restarts — possible crash loop"
    ISSUES+=("$proc: $restarts restarts (crash loop?)")
    # Don't auto-restart crash-looping processes — they need investigation
  fi
done

# --- Summary ---
log "=== Summary ==="
log "Restarts: $RESTART_COUNT"
log "Issues: ${#ISSUES[@]}"
for issue in "${ISSUES[@]}"; do
  log "  - $issue"
done
log "Done"
