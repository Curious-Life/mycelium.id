// ct-monitor.js — Certificate Transparency monitoring for managed handles.
//
// Polls a CT source (crt.sh by default) for certs issued on <handle>.<zone> and
// flags any that are ROGUE: issued by a CA NOT in the allowlist, OR by an allowed
// CA but with a serial we never issued (catches a real Let's Encrypt cert that
// SOMEONE ELSE obtained — the malicious-DNS-operator MITM the review flagged).
//
// IMPORTANT — DETECTION ONLY. CAA (see caaRecords) + this monitor raise the bar and
// give a tripwire; they do NOT *prevent* a DNS-controlling attacker from rewriting
// CAA and passing DNS-01. Own-domain (the user controls DNS) is the cryptographic
// escape hatch. crt.sh is best-effort (60 req/IP/min, frequent 502s) — for
// production polling use Cert Spotter's cursor API (api.certspotter.com/v1/issuances
// ?domain=&include_subdomains=true&after=<id>); this module is source-pluggable via
// fetchImpl and tolerant of an unavailable source (returns checked:0, never throws).

const DEFAULT_ISSUER_ALLOW = ["Let's Encrypt"];

/** Query crt.sh JSON for a name. Tolerant: returns [] on any error / non-200. */
async function crtshLookup(name, fetchImpl) {
  try {
    const res = await fetchImpl(`https://crt.sh/?q=${encodeURIComponent(name)}&output=json`, { headers: { accept: 'application/json' } });
    if (!res || !res.ok) return [];
    const data = await res.json().catch(() => []);
    return Array.isArray(data) ? data : [];
  } catch {
    return [];
  }
}

/**
 * Check one handle for rogue certs in CT.
 * @param {{handle:string, zone?:string, issuerAllow?:string[], knownSerials?:Set<string>, fetchImpl?:Function}} args
 * @returns {Promise<{ host:string, checked:number, rogue:Array<{issuer,serial,notBefore,reason}> }>}
 */
export async function checkHandle({ handle, zone = 'mycelium.id', issuerAllow = DEFAULT_ISSUER_ALLOW, knownSerials = new Set(), fetchImpl = fetch }) {
  const host = `${handle}.${zone}`;
  const entries = await crtshLookup(host, fetchImpl);
  const seen = new Set();
  const rogue = [];
  for (const e of entries) {
    const id = e.id ?? `${e.serial_number}|${e.not_before}`;
    if (seen.has(id)) continue; // a cert appears in multiple logs — de-dupe
    seen.add(id);
    const issuer = String(e.issuer_name || '');
    const serial = String(e.serial_number || '').toLowerCase();
    const issuerOk = issuerAllow.some((a) => issuer.includes(a));
    if (!issuerOk) {
      rogue.push({ issuer, serial, notBefore: e.not_before, reason: 'issuer not in allowlist' });
    } else if (!knownSerials.has(serial)) {
      rogue.push({ issuer, serial, notBefore: e.not_before, reason: 'allowed CA but serial not in our issuance ledger' });
    }
  }
  return { host, checked: seen.size, rogue };
}

/**
 * The recommended CAA records to pin issuance (detection + bar-raising; set once on
 * the apex — CAA tree-climbs to subdomains). Let's Encrypt honors validationmethods
 * + accounturi. Forbids wildcards (we issue per-handle) + sets an iodef report addr.
 */
export function caaRecords({ zone = 'mycelium.id', accountUri } = {}) {
  const acct = accountUri ? `; accounturi=${accountUri}` : '';
  return [
    `${zone}. CAA 0 issue "letsencrypt.org; validationmethods=dns-01${acct}"`,
    `${zone}. CAA 0 issuewild ";"`,
    `${zone}. CAA 0 iodef "mailto:security@${zone}"`,
  ];
}
