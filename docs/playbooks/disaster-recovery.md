# Disaster Recovery Playbook

**System**: Mycelium
**Last updated**: 2026-04-06

---

## Architecture Resilience Summary

| Component | Where it lives | Survives VPS loss? | Backup mechanism |
|-----------|---------------|-------------------|------------------|
| Encrypted messages, documents, contacts | Cloudflare D1 (`mycelium-v2`) | Yes | D1 automatic backups + time travel |
| Embeddings | Cloudflare Vectorize | Yes | Regenerable from source data |
| Attachments | Cloudflare R2 | Yes | R2 11-nines durability |
| Master encryption key | VPS `.env` + 1Password | VPS copy lost, 1Password survives | 1Password + physical backup |
| Agent code | GitHub private repo | Yes | Git history |
| Agent config / prompts | VPS filesystem | No (must redeploy) | Git repo + 1Password for secrets |
| PM2 process state | VPS | No (stateless, restart from config) | `ecosystem.config.cjs` |
| Worker code | Cloudflare (deployed) | Yes | `worker/src/` in git |

**Key insight**: All persistent data lives in Cloudflare (D1, R2, Vectorize). The VPS is a stateless compute node with one critical secret: the master key.

---

## Scenario 1: VPS Total Loss

**Cause**: Hardware failure, provider outage, accidental deletion, or compromised server destroyed.

**Data impact**: Zero data loss. All data is in Cloudflare D1/R2/Vectorize.

**Recovery time**: 30-60 minutes for basic service, 2-4 hours for full restoration.

### Steps

1. **Provision new VPS**:
   ```bash
   # Option A: Manual (Hetzner console)
   # Create CAX11 (ARM, 4GB RAM), Ubuntu 24.04, region fsn1
   # Add SSH key from 1Password

   # Option B: Scripted (from local machine with env vars set)
   ./scripts/provision-customer.sh <job-id>
   ```

2. **Install dependencies**:
   ```bash
   ssh new-vps
   apt update && apt install -y nodejs npm git
   npm install -g pm2
   # Install Claude CLI if agents need it
   ```

3. **Clone codebase**:
   ```bash
   git clone git@github.com:Curious-Life/mycelium.git ~/mycelium
   cd ~/mycelium && npm install
   ```

4. **Restore secrets from 1Password**:
   - `ENCRYPTION_MASTER_KEY` -- critical, without this all data is inaccessible
   - `ADMIN_SECRET` -- Worker authentication
   - `MYA_WORKER_URL` -- Worker endpoint
   - All agent tokens (`AGENT_TOKEN_*`)
   - Discord bot tokens, API keys, etc.
   - Write to the 6 scoped `.env` files: `.env`, `.env.discord`, `.env.database`, `.env.crypto`, `.env.agents`, `.env.cloudflare`

5. **Start agents**:
   ```bash
   cd ~/mycelium && pm2 start ecosystem.config.cjs
   pm2 save
   ```

6. **Verify**:
   ```bash
   # Check all agents are running
   pm2 status

   # Verify bootstrap-secrets works (agents can decrypt)
   pm2 logs personal-agent --lines 20 | grep -i "bootstrap\|secret\|decrypt"

   # Test portal access
   curl -s http://localhost:5173/health
   ```

7. **Update DNS** if IP changed:
   - Cloudflare DNS: Update A record for `mya.is` (or relevant domain)

8. **Verify end-to-end**:
   - Log into portal via WebAuthn
   - Check that messages decrypt and display correctly
   - Verify agent responses work (send a test message)

---

## Scenario 2: D1 Database Corruption

**Cause**: Bad migration, bulk update gone wrong, Worker bug writing garbage data.

**Data impact**: Depends on scope of corruption. D1 has automatic backups.

### Steps

1. **Assess the damage**:
   ```bash
   # Check recent data integrity
   cd worker && npx wrangler d1 execute mycelium-v2 --remote \
     --command="SELECT COUNT(*) FROM messages WHERE created_at > datetime('now', '-1 hour');"
   ```

2. **Use D1 Time Travel for point-in-time recovery**:
   ```bash
   # List available restore points (D1 keeps 30 days of backups)
   cd worker && npx wrangler d1 time-travel mycelium-v2 --before="2026-04-06T12:00:00Z"

   # Restore to a specific point
   cd worker && npx wrangler d1 time-travel restore mycelium-v2 \
     --timestamp="2026-04-06T11:30:00Z"
   ```

3. **If Time Travel is insufficient** (corruption older than 30 days):
   - Data in the corrupted rows is likely unrecoverable
   - Vectorize embeddings still exist and can identify affected content
   - R2 attachments are independent and unaffected

4. **After restore, verify**:
   ```bash
   # Check row counts match expectations
   cd worker && npx wrangler d1 execute mycelium-v2 --remote \
     --command="SELECT 'messages' as t, COUNT(*) as c FROM messages UNION ALL SELECT 'documents', COUNT(*) FROM documents UNION ALL SELECT 'people', COUNT(*) FROM people;"
   ```

5. **Re-run enrichment** if needed (tags/embeddings may be stale):
   ```bash
   ssh mycelium-vps "cd ~/mycelium && node scripts/backfill-enrich.js"
   ```

---

## Scenario 3: Master Key Loss

**THIS IS UNRECOVERABLE BY DESIGN.**

If the `ENCRYPTION_MASTER_KEY` is lost and no backup exists, ALL encrypted data becomes permanently inaccessible. This includes:

- 22,000+ messages
- 192 documents
- 74 attachments (encrypted content)
- 20,000+ clustering points
- 2,400+ contacts (name, email, company, position, LinkedIn URL)
- All secrets in the D1 `secrets` table

### What survives (unencrypted)

- Message metadata: timestamps, agent_id, conversation_id, type
- Contact metadata: source, engagement_tier, territory links
- Clustering structure: realm/territory assignments, cluster events
- Vectorize embeddings (but cannot map back to readable content)
- R2 attachment metadata

### Prevention (DO ALL OF THESE)

1. **1Password**: Store ENCRYPTION_MASTER_KEY in the Mycelium vault. Verify quarterly.
2. **Physical backup**: Print the key on paper, store in a secure physical location.
3. **Test recovery quarterly**: Confirm you can retrieve the key from 1Password and use it to decrypt a test record.

### If key is lost

1. Accept that historical encrypted data is gone.
2. Generate a new master key.
3. Re-initialize the system with empty encrypted fields.
4. Unencrypted metadata and structure remain -- the system is functional but amnesic.

---

## Scenario 4: R2 Storage Loss

**Cause**: Accidental bucket deletion, Cloudflare outage.

**Data impact**: Minimal. R2 has 99.999999999% (11-nines) durability.

**What's in R2**: File attachments (documents, images uploaded through agents).

### If it happens

1. Attachment metadata in D1 still references the files (URLs, filenames, sizes).
2. The core data (messages, contacts, financial records) is in D1, not R2.
3. Attachments are supplementary -- the system continues functioning without them.
4. Contact Cloudflare support for R2 recovery options.

### Prevention

- For critical attachments, consider periodic export to local backup.
- R2's durability makes this scenario extremely unlikely.

---

## Scenario 5: Worker Outage

**Cause**: Cloudflare Workers platform outage, bad deploy, exceeded limits.

**Data impact**: None. No data is written or lost during a Worker outage.

**Service impact**: ALL agents lose database access. Portal cannot load data.

### Symptoms

- All agents log `ECONNREFUSED` or `502` when calling `MYA_WORKER_URL`
- Portal shows loading spinners indefinitely
- `bootstrap-secrets.js` fails to refresh (but agents keep cached secrets for current session)

### Steps

1. **Check if it's Cloudflare-wide**:
   - https://www.cloudflarestatus.com/
   - If yes, wait for resolution. No action needed.

2. **Check if it's a bad deploy**:
   ```bash
   # Roll back to previous version
   cd worker && npx wrangler rollback
   ```

3. **Check Worker logs**:
   ```bash
   cd worker && npx wrangler tail
   ```

4. **If Worker is rate-limited** (D1 row limits, CPU time):
   - Check Cloudflare dashboard for limit warnings
   - Reduce request volume (stop non-essential agents)
   - Contact Cloudflare if on paid plan

5. **Agents auto-recover**: Once the Worker is back, agents retry with backoff. No manual intervention needed for the agents themselves.

---

## Scenario 6: Quarterly DR Drill

Run this every quarter to verify recovery capability. Takes ~1 hour.

### Checklist

```markdown
# DR Drill — Q[N] [YEAR]

**Date**: YYYY-MM-DD
**Performed by**: [name]

## Pre-drill

- [ ] 1Password access verified (can log in, can see Mycelium vault)
- [ ] ENCRYPTION_MASTER_KEY retrievable from 1Password
- [ ] ADMIN_SECRET retrievable from 1Password
- [ ] GitHub repo access verified (can clone mycelium private repo)

## Provision test environment

- [ ] Provision test VPS (Hetzner CAX11, any region)
- [ ] Clone repo, install dependencies
- [ ] Write .env files from 1Password values
- [ ] Set MYA_WORKER_URL to production Worker

## Verify data access (READ-ONLY)

- [ ] Start one agent (e.g., personal-agent) with read-only intent
- [ ] Verify bootstrap-secrets.js decrypts successfully
- [ ] Query messages and confirm decryption works:
      `node -e "const db = require('./lib/db-d1'); db.init(); db.messages.recent({limit:5}).then(m => console.log(m.map(x=>x.content?.substring(0,50))))"`
- [ ] Query contacts and confirm name decryption
- [ ] Query secrets table and confirm local decryption

## Verify backups

- [ ] D1 time-travel: list available restore points
      `cd worker && npx wrangler d1 time-travel mycelium-v2`
- [ ] R2: list bucket contents
      `cd worker && npx wrangler r2 object list mycelium-attachments --prefix="" | head -20`

## Tear down

- [ ] Stop all PM2 processes on test VPS
- [ ] Delete test VPS via Hetzner console
- [ ] Remove any local .env files created during drill
- [ ] Record results below

## Results

| Check | Status | Notes |
|-------|--------|-------|
| 1Password access | PASS/FAIL | |
| Master key decryption | PASS/FAIL | |
| D1 data accessible | PASS/FAIL | |
| D1 time-travel works | PASS/FAIL | |
| Agent bootstrap works | PASS/FAIL | |
| End-to-end decryption | PASS/FAIL | |

## Issues found
[List any issues discovered during the drill]

## Actions
[List follow-up actions with owners and deadlines]
```

---

## Recovery Time Objectives

| Scenario | RTO | RPO | Notes |
|----------|-----|-----|-------|
| VPS total loss | 2-4 hours | 0 (D1 is current) | Bottleneck: restoring secrets from 1Password |
| D1 corruption | 30 min | Up to 5 min (D1 WAL) | D1 time-travel, point-in-time recovery |
| Master key loss | **Unrecoverable** | **Total loss** | Prevention is the only strategy |
| R2 storage loss | N/A | N/A | System continues without attachments |
| Worker outage | Auto-recovery | 0 | Agents retry, no data loss |

---

## Emergency Contacts

| Resource | How to reach |
|----------|-------------|
| Hetzner support | https://console.hetzner.cloud/ (ticket) |
| Cloudflare support | https://dash.cloudflare.com/ (ticket, or Enterprise hotline if applicable) |
| 1Password | https://my.1password.com/ |
| GitHub | https://support.github.com/ |
