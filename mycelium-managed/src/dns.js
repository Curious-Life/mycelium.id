// dns.js — create the two apex DNS records per handle:
//   A     <handle>.mycelium.id            → relay IP
//   CNAME _acme-challenge.<handle>.myc.id → <acme-dns fulldomain>   (DNS-01 delegation)
// A pure wildcard can't serve the _acme-challenge TXT and the per-handle CNAME
// defeats the wildcard for that host (RFC 4592), so 2 explicit records per handle.
// Providers: 'mock' (in-memory, for tests/dry-run), 'cloudflare' (DNS-only/grey),
// 'desec' (free, DNSSEC). Real providers are best-effort fetch; verify with mock.
export function createDnsClient({ provider = 'mock', token, zone = 'mycelium.id', relayIp, records = [] } = {}) {
  async function cloudflare({ name, type, content }) {
    const zoneId = process.env.MYC_CF_ZONE_ID;
    const res = await fetch(`https://api.cloudflare.com/client/v4/zones/${zoneId}/dns_records`, {
      method: 'POST',
      headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' },
      // proxied:false is REQUIRED — an orange-cloud record terminates TLS at CF.
      body: JSON.stringify({ type, name, content, proxied: false, ttl: 120 }),
    });
    if (!res.ok) throw new Error(`cloudflare dns ${type} failed (${res.status})`);
  }
  async function desec({ name, type, content }) {
    const suffix = `.${zone}`;
    const subname = name.endsWith(suffix) ? name.slice(0, -suffix.length) : name;
    const res = await fetch(`https://desec.io/api/v1/domains/${zone}/rrsets/`, {
      method: 'POST',
      headers: { authorization: `Token ${token}`, 'content-type': 'application/json' },
      body: JSON.stringify({ subname, type, ttl: 3600, records: [type === 'CNAME' ? `${content}.` : content] }),
    });
    if (!res.ok) throw new Error(`desec dns ${type} failed (${res.status})`);
  }

  async function createHandleRecords({ handle, acmeFulldomain }) {
    const aRec = { type: 'A', name: `${handle}.${zone}`, content: relayIp };
    const cname = { type: 'CNAME', name: `_acme-challenge.${handle}.${zone}`, content: acmeFulldomain };
    if (provider === 'mock') { records.push(aRec, cname); return { created: [aRec, cname] }; }
    if (provider === 'cloudflare') { await cloudflare(aRec); await cloudflare(cname); return { created: [aRec, cname] }; }
    if (provider === 'desec') { await desec(aRec); await desec(cname); return { created: [aRec, cname] }; }
    throw new Error(`unknown DNS provider: ${provider}`);
  }

  return { provider, records, createHandleRecords };
}
