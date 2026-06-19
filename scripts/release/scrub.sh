#!/usr/bin/env bash
# scripts/release/scrub.sh — re-derive the clean PUBLIC tree from a frozen `main`.
#
# Run this in a FRESH CLONE of the frozen main, on a throwaway branch — NEVER on
# the live dev tree. It stages (git rm) the deletions + curates docs + runs the
# grep gates. It does NOT commit, squash, or push — a human reviews `git status`,
# then commits → squashes → force-pushes → flips public (see
# docs/GO-LIVE-RUNBOOK-2026-06-19.md F3).
#
# It is DETERMINISTIC (operates on keep-lists / rm-lists + patterns), so it stays
# correct as `main` moves. CONTENT (governance files, README/CLAUDE/doc-accuracy +
# truth-check edits, the security fixes) must already be on `main` (Track A PRs) —
# this script only DELETES + curates; the preflight warns if Track-A content is missing.
#
# Usage:
#   git clone --branch main --single-branch <mycelium.id> /tmp/pub && cd /tmp/pub
#   git checkout -b public-release
#   bash scripts/release/scrub.sh        # stages deletions + runs gates
#   git status                            # REVIEW
#   # then: squash → force-push → flip public  (runbook F3)
set -euo pipefail
ROOT="$(git rev-parse --show-toplevel)"; cd "$ROOT"

# ── SAFETY GUARDS ─────────────────────────────────────────────────────────────
branch="$(git branch --show-current)"
origin="$(git remote get-url origin 2>/dev/null || echo '')"
if [ "$branch" = "main" ] || [ "$branch" = "master" ]; then
  echo "FATAL: on '$branch'. Run on a throwaway branch in a FRESH clone, not main." >&2; exit 1
fi
if [ -n "$(git status --porcelain)" ]; then
  echo "FATAL: working tree not clean. Start from a fresh clone of frozen main." >&2; exit 1
fi
echo "Re-deriving clean public tree from $(git rev-parse --short HEAD) on branch '$branch'"
echo "origin=$origin"; echo

# ── PREFLIGHT: is the Track-A content present? (warn, don't fail) ──────────────
warn(){ echo "  ⚠️  $*"; }
echo "── Preflight (Track-A content that must be on main BEFORE freeze) ──"
for f in SECURITY.md CONTRIBUTING.md CODE_OF_CONDUCT.md .github/PULL_REQUEST_TEMPLATE.md .github/ISSUE_TEMPLATE/config.yml; do
  [ -f "$f" ] || warn "missing governance file: $f"
done
grep -q "repository is private" README.md 2>/dev/null && warn "README still says 'repository is private' — Track-A README fix not landed"
grep -qE "E2E encrypted \| .* \*\*✓\*\*" README.md 2>/dev/null && warn "README still claims 'E2E encrypted' — truth-check fix not landed"
grep -qE "cryptography>=42,<45" pipeline/requirements.txt 2>/dev/null && warn "cryptography still capped <45 (CVE fix not landed: need >=48.0.1)"
[ -f pipeline/requirements.lock.txt ] || warn "no pipeline/requirements.lock.txt (hash-lock not landed)"
echo

# ── PHASE 0 — sensitive purge (patterns, so NEW sensitive files are caught) ────
echo "── Phase 0: purge ──"
# NOTE: grep exits 1 on no-match → with pipefail that would abort the freeze once
# the scratch _*.mjs are already gone. `|| true` keeps a no-match non-fatal.
{ git ls-files -z | grep -zE '^_[^/]*\.mjs$' | xargs -0 -r git rm -q --ignore-unmatch; } || true
for p in MEMORY.md; do git rm -q --ignore-unmatch "$p" || true; done
git ls-files -z '.claude/memory/*' | xargs -0 -r git rm -q --ignore-unmatch
# exploit-disclosure + host-leak docs (pattern + explicit)
git ls-files -z 'docs/SECURITY-REVIEW-*' 'docs/SECURITY-FOLLOWUP-*' | xargs -0 -r git rm -q --ignore-unmatch
for d in docs/CLAUDE-CONNECTOR-ISSUE-2026-06-04.md docs/DESIGN-mcp-discovery-fix-2026-06-04.md docs/REMOTE-CONNECT-HANDOFF-2026-06-03.md; do
  git rm -q --ignore-unmatch "$d" || true
done
# .gitignore guard
grep -q '^_\*\.mjs' .gitignore 2>/dev/null || printf '\n# public-release hygiene\n_*.mjs\n/MEMORY.md\n.claude/memory/\n' >> .gitignore
git add .gitignore

# ── PHASE 1 — structure ───────────────────────────────────────────────────────
echo "── Phase 1: structure ──"
mkdir -p docs/spikes
git ls-files -z 'spike/*RESULT*.md' 2>/dev/null | while IFS= read -r -d '' f; do
  git mv "$f" "docs/spikes/$(echo "${f#spike/}" | sed 's#/#__#g')" 2>/dev/null || true
done
[ -d research ] && for f in research/*; do [ -e "$f" ] && git mv "$f" "docs/$(basename "$f")" 2>/dev/null || true; done
git rm -rq --ignore-unmatch reference mycelium-managed spike research
# mycelium-managed verify scripts (V2 control-plane gates)
git rm -q --ignore-unmatch scripts/verify-{dns,entitlement,billing,turnstile,provision,newproxy-auth,ct-monitor}.mjs
# orphan one-off scripts
git rm -q --ignore-unmatch scripts/{recover-mindscape,recover-truncated-attachments,backfill-claude-code,cleanup-null-content-messages,demo-claims,claims-live-demo,dev-streams-preview,bench-search-recall}.mjs
# package.json: drop the 7 V2 verify:* keys + their tokens in the `verify` aggregate
node - <<'NODE'
const fs=require('fs'); const F='package.json'; let raw=fs.readFileSync(F,'utf8');
const N=['dns','entitlement','billing','turnstile','provision','newproxy-auth','ct-monitor'];
for(const n of N){ raw=raw.replace(`    "verify:${n}": "node scripts/verify-${n}.mjs",\n`,''); }
const o=JSON.parse(raw); const v=o.scripts.verify||'';
const nv=v.split(' && ').filter(s=>!N.some(n=>s.trim()===`npm run verify:${n}`)).join(' && ');
if(nv!==v) raw=raw.replace(v,nv);
JSON.parse(raw); fs.writeFileSync(F,raw); // validate then write
NODE
git add package.json

# Root CLAUDE.md: the live one is the internal dev-strategy doc (V1/V2 plans,
# the private canonical-repo name). Swap in the lean PUBLIC version, then drop the
# release tooling itself (scrub.sh + CLAUDE.public.md carry grep-target literals
# like the relay host that must not ship). The runbook is a docs/*.md → Phase 2
# curation deletes it.
if [ -f scripts/release/CLAUDE.public.md ]; then
  cp scripts/release/CLAUDE.public.md CLAUDE.md && git add CLAUDE.md
  git rm -rq --ignore-unmatch scripts/release
else
  echo "FATAL: scripts/release/CLAUDE.public.md missing — cannot produce a public CLAUDE.md." >&2; exit 1
fi

# ── PHASE 2 — docs curation (keep-list; delete the rest) ──────────────────────
echo "── Phase 2: docs curation ──"
KEEP_TOP="SETUP.md ARCHITECTURE.md HOW-IT-WORKS.md VISION.md ACCOUNT-AND-DATA.md HARNESS-RECIPES.md"
# -f because Phase 1 may have `git mv`'d files into docs/ (staged rename); a plain
# `git rm` refuses a file with staged changes. Everything here is being deleted, so
# forcing is the intent.
git ls-files -z 'docs/*' | while IFS= read -r -d '' f; do
  case "$f" in docs/guide/*|docs/legacy/*|docs/spikes/*) continue;; esac
  base="${f#docs/}"; case "$base" in */*) git rm -qf --ignore-unmatch "$f"; continue;; esac  # nested non-kept dir
  keep=0; for k in $KEEP_TOP; do [ "$base" = "$k" ] && keep=1; done
  [ "$keep" -eq 0 ] && git rm -qf --ignore-unmatch "$f"
done

# ── PHASE 3 — neutralize dead doc links ───────────────────────────────────────
# The kept docs (README, the 6 top docs, guide/**) link to internal design docs
# that Phase 2 just deleted → those would be 404s in the public repo. Rewrite any
# markdown link [text](target.md) whose target no longer exists into plain `text`,
# keeping the prose. Dev docs are untouched (this runs only on the frozen public
# tree); handles future drift automatically. Only .md targets are touched (code
# paths / images left alone) and only when the resolved target is truly gone.
echo "── Phase 3: de-link deleted docs ──"
node - <<'NODE'
const { execSync } = require('child_process');
const fs = require('fs'); const path = require('path');
const kept = new Set(execSync('git ls-files', {encoding:'utf8'}).split('\n').filter(Boolean));
const mdFiles = [...kept].filter(f => f.endsWith('.md'));
const linkRe = /\[([^\]]+)\]\(([^)]+)\)/g;
let changedFiles = 0, changedLinks = 0;
for (const f of mdFiles) {
  const src = fs.readFileSync(f, 'utf8'); const dir = path.dirname(f);
  let touched = false;
  const out = src.replace(linkRe, (m, text, target) => {
    const t = target.trim();
    if (/^(https?:|mailto:|#|\/\/)/.test(t)) return m;          // external / anchor
    const clean = t.split('#')[0].split('?')[0];
    if (!clean.endsWith('.md')) return m;                       // only doc links
    const resolved = path.normalize(path.join(dir, clean));
    if (kept.has(resolved)) return m;                           // target survives
    touched = true; changedLinks++; return text;               // dead → plain text
  });
  if (touched) { fs.writeFileSync(f, out); execSync(`git add "${f}"`); changedFiles++; }
}
console.log(`  de-linked ${changedLinks} dead doc link(s) across ${changedFiles} file(s)`);
NODE

# ── GATES ─────────────────────────────────────────────────────────────────────
echo; echo "── Grep gates (must all be clean) ──"
fail=0
chk(){ local n="$1"; shift; local out; out="$("$@" 2>/dev/null || true)"; if [ -n "$out" ]; then echo "  ✗ $n:"; echo "$out"|sed 's/^/      /'|head; fail=1; else echo "  ✓ $n"; fi; }
chk "no root _*.mjs"        bash -c "git ls-files | grep -E '^_[^/]*\.mjs$' || true"
chk "no MEMORY.md"          bash -c "git ls-files | grep -E '^MEMORY\.md$' || true"
chk "no .claude/memory"     bash -c "git ls-files | grep '^\.claude/memory/' || true"
chk "no exploit docs"       bash -c "git ls-files | grep -E 'SECURITY-REVIEW-|SECURITY-FOLLOWUP-' || true"
chk "no 0m.mycelium.id"     bash -c "git grep -n '0m\.mycelium\.id' -- . | grep -v node_modules || true"
chk "no /Users home paths"  bash -c "git grep -nE '/Users/(altus|sfn)/' -- . | grep -v node_modules || true"
chk "no reference/ etc"     bash -c "git ls-files | grep -E '^(reference|mycelium-managed|spike|research)/' || true"
# private canonical-repo name (Curious-Life/mycelium) but NOT the public repo (…/mycelium.id)
chk "no private repo name"  bash -c "git grep -nE 'Curious-Life/mycelium([^.]|\$)' -- . | grep -v node_modules || true"
chk "no internal CLAUDE.md" bash -c "git grep -l 'REDESIGN-LIVING-SPEC' -- CLAUDE.md || true"
chk "no release tooling"    bash -c "git ls-files | grep -E '^scripts/release/' || true"
chk "no dead doc links"     node -e 'const{execSync}=require("child_process"),fs=require("fs"),path=require("path");const kept=new Set(execSync("git ls-files",{encoding:"utf8"}).split("\n").filter(Boolean));let bad=[];for(const f of [...kept].filter(x=>x.endsWith(".md"))){const s=fs.readFileSync(f,"utf8"),d=path.dirname(f);let m;const re=/\[([^\]]+)\]\(([^)]+)\)/g;while(m=re.exec(s)){const t=m[2].trim();if(/^(https?:|mailto:|#|\/\/)/.test(t))continue;const c=t.split("#")[0].split("?")[0];if(!c.endsWith(".md"))continue;if(!kept.has(path.normalize(path.join(d,c))))bad.push(f+" -> "+c)}}if(bad.length)console.log(bad.join("\n"))'

echo
echo "docs/ files now: $(git ls-files 'docs/*' | wc -l | tr -d ' ')  | total deletions staged: $(git diff --cached --name-status | grep -c '^D')"
if [ "$fail" -ne 0 ]; then echo "❌ GATES FAILED — do not publish. Review above."; exit 1; fi
echo "✅ Gates clean. Review 'git status', then: full npm run verify (ML checkout) + clean-clone smoke → squash w/ project author → force-push → flip public (runbook F2–F3)."
