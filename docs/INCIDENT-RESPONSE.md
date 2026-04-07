# Incident Response Plan

**System**: Mycelium multi-agent personal intelligence platform
**Data handled**: Private messages, financial records, health data, contacts, journal entries
**Last updated**: 2026-04-06

---

## 1. Severity Classification

| Level | Definition | Examples | Response Time |
|-------|-----------|----------|---------------|
| **P0** | Data breach or master key compromise. Attacker has or may have plaintext access to encrypted data. | Master key leak, ADMIN_SECRET exposed publicly, confirmed unauthorized D1 access | Immediate (drop everything) |
| **P1** | Service compromise. Attacker has or may have control of a system component but not the master key. | VPS root access, agent token stolen, Worker hijacked | Within 1 hour |
| **P2** | Single tenant or scope affected. Limited blast radius. | One agent's token compromised, single customer's session hijacked, scope key exposed | Within 4 hours |
| **P3** | Degraded service, no security impact. | Worker 502s, PM2 crash loops, D1 rate limiting, R2 timeout | Within 24 hours |

---

## 2. Detection

### What to monitor

| Source | What to look for | Location |
|--------|-----------------|----------|
| **audit_log (D1)** | Failed auth attempts, unusual agent_id values, bulk data reads, admin endpoint access from unknown IPs | `SELECT * FROM audit_log WHERE success = 0 ORDER BY created_at DESC` |
| **Sentry** | Unhandled exceptions, crypto errors (decryption failures may indicate tampering), auth middleware rejections | Sentry dashboard (SENTRY_DSN in env) |
| **PM2 logs** | Agent crash loops, unexpected restarts, `ECONNREFUSED` to Worker, bootstrap-secrets failures | `/var/log/mycelium/<agent>-out.log` and `pm2 logs` |
| **AIDE** | File integrity changes on VPS: modified binaries, new cron jobs, changed `.env` files | AIDE report (if configured) |
| **Cloudflare Analytics** | Unusual request volume to Worker, requests from unexpected IPs/countries | Cloudflare dashboard |
| **D1 metrics** | Read/write volume spikes, unusual query patterns | Cloudflare D1 dashboard |

### Red flags requiring immediate investigation

- `bootstrap-secrets.js` decryption failures (may indicate key or ciphertext tampering)
- `audit_log` entries with unknown `agent_id` values
- PM2 processes restarting without code deploy
- SSH login from unrecognized IP (check `auth.log`)
- Worker returning 401s for agents that were previously authenticated

---

## 3. Escalation Chain

### Owner notification

1. **Discord webhook** (primary): Post to private `#incidents` channel
   ```bash
   curl -H "Content-Type: application/json" \
     -d '{"content":"[P0] Master key compromise suspected. Details: ..."}' \
     "$DISCORD_INCIDENT_WEBHOOK"
   ```

2. **Email** (secondary): Via Resend API (RESEND_API_KEY in env)
   ```bash
   curl -X POST https://api.resend.com/emails \
     -H "Authorization: Bearer $RESEND_API_KEY" \
     -H "Content-Type: application/json" \
     -d '{"from":"alerts@mya.is","to":"<owner-email>","subject":"[P0] Mycelium Incident","text":"..."}'
   ```

3. **For managed hosting customers**: Notify via their configured contact method within SLA timelines (see Section 7).

---

## 4. Response Playbooks

### 4.1 Master Key Compromise (P0)

**Trigger**: ENCRYPTION_MASTER_KEY value exposed in logs, git, public endpoint, or attacker access to VPS `.env` confirmed.

**Blast radius**: ALL encrypted data across ALL scopes (personal, org, wealth, moms). 22K+ messages, 192 documents, 74 attachments, 20K+ clustering points, 2.4K contacts, all secrets.

**Steps**:

1. **Contain immediately** (minutes 0-5):
   ```bash
   # Stop all agents to prevent further data access
   ssh mycelium-vps "pm2 stop all"
   ```

2. **Revoke all sessions**:
   ```bash
   # Clear all portal sessions in D1
   cd worker && npx wrangler d1 execute mycelium-v2 --remote \
     --command="DELETE FROM sessions;"
   ```

3. **Generate new master key**:
   ```bash
   node -e "console.log(require('crypto').randomBytes(32).toString('base64url'))"
   ```

4. **Rotate via envelope encryption** (if implemented):
   - Generate new scope keys
   - Re-wrap all DEKs with new scope keys (does not require re-encrypting content)
   - Update `.env` on VPS with new ENCRYPTION_MASTER_KEY
   - Update 1Password backup

5. **If envelope encryption is NOT yet implemented** (current state):
   - This is a full re-encryption. Every encrypted field must be decrypted with the old key and re-encrypted with the new key.
   - Use the old key to decrypt, new key to encrypt, row by row.
   - This will take hours for 22K+ messages. Plan for downtime.

6. **Rotate all secrets** stored in D1 `secrets` table:
   ```bash
   # Each secret must be re-encrypted with the new master key
   # Use scripts/seed-secret.js for each one
   node scripts/seed-secret.js <key> <value> <scope>
   ```

7. **Rotate ADMIN_SECRET and AGENT_REGISTRY**:
   ```bash
   # New ADMIN_SECRET
   cd worker && npx wrangler secret put ADMIN_SECRET
   # New AGENT_REGISTRY (JSON of agent tokens)
   cd worker && npx wrangler secret put AGENT_REGISTRY
   ```

8. **Restart all agents**:
   ```bash
   ssh mycelium-vps "pm2 start ecosystem.config.cjs"
   ```

9. **Audit**: Review `audit_log` for unauthorized access during the exposure window.

10. **Notify customers** within 24 hours (see Section 7).

---

### 4.2 Agent Token Compromise (P1/P2)

**Trigger**: An AGENT_TOKEN value is exposed. Attacker can impersonate that agent against the Worker.

**Blast radius**: Limited to the compromised agent's scopes. E.g., if Mya's token leaks, attacker can read/write personal + org scope ciphertext (but cannot decrypt without master key).

**Steps**:

1. **Identify which agent token leaked** and its scopes.

2. **Revoke the token in AGENT_REGISTRY**:
   ```bash
   # Get current registry, remove/replace the compromised token
   # Then update the Worker secret
   cd worker && npx wrangler secret put AGENT_REGISTRY
   # Paste the updated JSON with a new token for the affected agent
   ```

3. **Update the agent's AGENT_TOKEN** on VPS:
   ```bash
   ssh mycelium-vps "vim ~/mycelium/.env.agents"
   # Update AGENT_TOKEN_<AGENT_NAME> to the new value
   ```

4. **Restart the affected agent** (must delete+start for PM2 to pick up new env):
   ```bash
   ssh mycelium-vps "pm2 delete <agent-name> && pm2 start ecosystem.config.cjs --only <agent-name>"
   ```

5. **Check audit_log** for unauthorized requests using the old token:
   ```sql
   SELECT * FROM audit_log
   WHERE agent_id = '<agent-id>'
   AND created_at > '<leak-estimated-time>'
   ORDER BY created_at;
   ```

6. **Note**: The attacker only has ciphertext. Without the master key, data remains encrypted. Assess whether the master key may also be compromised.

---

### 4.3 VPS Compromise (P1)

**Trigger**: Unauthorized SSH access, rootkit detected, unexpected processes, AIDE alerts on system files.

**Blast radius**: CRITICAL. VPS has the master key, all agent tokens, and can decrypt everything. Treat as potential P0.

**Steps**:

1. **Isolate the VPS immediately** (do NOT SSH in if rootkit suspected -- use provider console):
   ```bash
   # Via Hetzner Cloud API or console:
   # - Add firewall rule blocking all inbound/outbound
   # - Or power off the server
   ```

2. **Assume master key compromised** -- follow Playbook 4.1 in parallel.

3. **Revoke all Worker secrets** (ADMIN_SECRET, AGENT_REGISTRY):
   ```bash
   cd worker && npx wrangler secret put ADMIN_SECRET
   cd worker && npx wrangler secret put AGENT_REGISTRY
   ```

4. **Provision new VPS**:
   ```bash
   # Use provision-customer.sh or manual setup
   # Clone fresh from private repo
   # D1 data survives -- it's in Cloudflare, not on VPS
   ```

5. **Restore secrets from 1Password**:
   - ENCRYPTION_MASTER_KEY (or new one if rotating)
   - ADMIN_SECRET (new)
   - All `.env` values

6. **Deploy and start**:
   ```bash
   ssh new-vps "cd ~/mycelium && pm2 start ecosystem.config.cjs"
   ```

7. **Update DNS** if VPS IP changed (Cloudflare DNS for mya.is).

8. **Forensics** on the old VPS (if safe to access):
   - Check `auth.log` for SSH access
   - Check `.bash_history` for executed commands
   - Check `crontab -l` for persistence mechanisms
   - Snapshot the disk for later analysis before destroying

---

### 4.4 Secret Leak -- API Keys, Discord Tokens, etc. (P2)

**Trigger**: Third-party API key, Discord bot token, Resend key, Polymarket credentials, or similar exposed.

**Steps**:

1. **Identify the scope** of the leaked secret:
   - Which agent uses it?
   - What can it access? (e.g., Discord bot token = full bot control, Resend = send email as mya.is)

2. **Rotate at the source** (provider dashboard):
   - Discord: Bot settings > Reset Token
   - Resend: API Keys > Revoke + Create
   - Polymarket: Reset credentials
   - Google: Service account > Create new key, delete old

3. **Update in D1 secrets** (encrypted storage):
   ```bash
   node scripts/seed-secret.js <SECRET_NAME> <new-value> <scope>
   ```

4. **Update `.env` on VPS** if the secret is also there:
   ```bash
   ssh mycelium-vps "vim ~/mycelium/.env.<relevant-file>"
   ```

5. **Restart affected agent(s)**:
   ```bash
   ssh mycelium-vps "pm2 delete <agent> && pm2 start ecosystem.config.cjs --only <agent>"
   ```

6. **Check audit_log** for abuse during the exposure window.

---

### 4.5 Session Hijacking (P2)

**Trigger**: Unauthorized portal access detected, session token stolen, WebAuthn bypass suspected.

**Steps**:

1. **Revoke ALL sessions immediately**:
   ```bash
   cd worker && npx wrangler d1 execute mycelium-v2 --remote \
     --command="DELETE FROM sessions;"
   ```

2. **Check audit_log for session activity**:
   ```sql
   SELECT * FROM audit_log
   WHERE event_type LIKE '%session%' OR event_type LIKE '%login%'
   ORDER BY created_at DESC LIMIT 100;
   ```

3. **Review what data was accessed** during the hijacked session. Portal has read access to all scopes.

4. **Force re-login**: All legitimate users must re-authenticate via WebAuthn.

5. **If WebAuthn credentials are suspected compromised**:
   ```bash
   # Remove stored credentials and re-register
   cd worker && npx wrangler d1 execute mycelium-v2 --remote \
     --command="DELETE FROM webauthn_credentials WHERE user_id = '<user-id>';"
   ```

6. **Consider**: Was this a stolen cookie, XSS, or network-level attack? Fix the vector.

---

## 5. Post-Incident Review Template

Complete within 48 hours of incident resolution.

```markdown
# Post-Incident Review: [TITLE]

**Date**: YYYY-MM-DD
**Severity**: P0/P1/P2/P3
**Duration**: HH:MM (detection to resolution)
**Lead responder**: [name]

## Timeline
| Time (UTC) | Event |
|------------|-------|
| HH:MM | [First indicator observed] |
| HH:MM | [Incident confirmed] |
| HH:MM | [Containment action taken] |
| HH:MM | [Root cause identified] |
| HH:MM | [Resolution confirmed] |

## Root Cause
[What caused the incident. Be specific.]

## Impact
- Data exposed: [scope, volume, sensitivity]
- Service downtime: [duration]
- Users affected: [count, who]

## Actions Taken
1. [What was done to contain]
2. [What was done to remediate]
3. [What was done to verify resolution]

## Prevention Measures
1. [Specific change to prevent recurrence]
2. [Detection improvement]
3. [Process change]

## Secrets Rotated
- [ ] ENCRYPTION_MASTER_KEY
- [ ] ADMIN_SECRET
- [ ] AGENT_REGISTRY / agent tokens
- [ ] Discord bot tokens
- [ ] Other: ___

## 1Password Updated
- [ ] Recovery kit values current
- [ ] All rotated secrets backed up
```

---

## 6. Evidence Preservation

For P0 and P1 incidents:

1. **Before touching the VPS**, snapshot the disk via Hetzner API or console.
2. **Export audit_log** for the incident window:
   ```bash
   cd worker && npx wrangler d1 execute mycelium-v2 --remote \
     --command="SELECT * FROM audit_log WHERE created_at > '<start>' AND created_at < '<end>';" \
     --json > incident-audit-$(date +%Y%m%d).json
   ```
3. **Save PM2 logs**:
   ```bash
   ssh mycelium-vps "tar czf /tmp/pm2-logs-$(date +%Y%m%d).tar.gz /var/log/mycelium/"
   scp mycelium-vps:/tmp/pm2-logs-*.tar.gz ./
   ```
4. **Save Cloudflare Worker analytics** (screenshot or export from dashboard).
5. Store all evidence in a private, dated directory. Do not store on the compromised system.

---

## 7. Customer Notification

### Timelines

| Severity | Notification deadline | Channel |
|----------|----------------------|---------|
| **P0** | 24 hours from confirmation | Email + in-app banner |
| **P1** | 72 hours from confirmation | Email |
| **P2** | Best effort, within 1 week | Email if data affected |
| **P3** | No notification required | Status page update |

### Template

```
Subject: Mycelium Security Incident Notice — [DATE]

We identified a security incident on [DATE] affecting [SCOPE].

What happened:
[1-2 sentence description]

What data was affected:
[Specific data types and approximate volume]

What we did:
[Actions taken, including key rotation, service restoration]

What you should do:
[Any user actions required — re-login, review activity, etc.]

We take the security of your data seriously. If you have questions,
contact [support channel].
```

---

## Quick Reference

| Action | Command |
|--------|---------|
| Stop all agents | `ssh mycelium-vps "pm2 stop all"` |
| Kill all agents | `ssh mycelium-vps "pm2 delete all"` |
| Clear all sessions | `wrangler d1 execute mycelium-v2 --remote --command="DELETE FROM sessions;"` |
| Check audit log | `wrangler d1 execute mycelium-v2 --remote --command="SELECT * FROM audit_log ORDER BY created_at DESC LIMIT 50;"` |
| Rotate Worker secret | `cd worker && npx wrangler secret put <SECRET_NAME>` |
| Seed D1 secret | `node scripts/seed-secret.js <key> <value> <scope>` |
| Restart agent (fresh env) | `pm2 delete <name> && pm2 start ecosystem.config.cjs --only <name>` |
| Check agent env | `PID=$(pm2 pid <name>) && cat /proc/$PID/environ \| tr "\0" "\n" \| grep <VAR>` |
