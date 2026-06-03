// dns.js — create/delete the two apex DNS records per handle:
//   A     <handle>.mycelium.id            → relay IP
//   CNAME _acme-challenge.<handle>.myc.id → <acme-dns fulldomain>   (DNS-01 delegation)
// A pure wildcard can't serve the _acme-challenge TXT and the per-handle CNAME
// defeats the wildcard for that host (RFC 4592), so 2 explicit records per handle.
// Providers: 'mock' (in-memory, for tests/dry-run), 'cloudflare' (DNS-only/grey),
// 'desec' (free, DNSSEC). Real providers are best-effort fetch; verify with mock.
export function createDnsClient({ provider = 'mock', token, zone = 'mycelium.id', relayIp, records = [] } = {}) {
  const recordNames = (handle) => [`${handle}.${zone}`, `_acme-challenge.${handle}.${zone}`];

  async function cfRequest(method, path, body) {
    const zoneId = process.env.MYC_CF_ZONE_ID;
    const res = await fetch(`https://api.cloudflare.com/client/v4/zones/${zoneId}${path}`, {
      method,
      headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' },
      body: body ? JSON.stringify(body) : undefined,
    });
    if (!res.ok) throw new Error(`cloudflare dns ${method} ${path} failed (${res.status})`);
    return res.json();
  }
  async function cfCreate({ name, type, content }) {
    // proxied:false is REQUIRED — an orange-cloud record terminates TLS at CF.
    await cfRequest('POST', '/dns_records', { type, name, content, proxied: false, ttl: 120 });
  }
  async function cfDelete(name) {
    const list = await cfRequest('GET', `/dns_records?name=${encodeURIComponent(name)}`);
    for (const rec of list.result || []) await cfRequest('DELETE', `/dns_records/${rec.id}`);
  }

  async function desecRequest(method, path, body) {
    const res = await fetch(`https://desec.io/api/v1/domains/${zone}${path}`, {
      method,
      headers: { authorization: `Token ${token}`, 'content-type': 'application/json' },
      body: body ? JSON.stringify(body) : undefined,
    });
    if (!res.ok && res.status !== 404) throw new Error(`desec dns ${method} ${path} failed (${res.status})`);
    return res.status === 404 ? null : res.json();
  }
  const desecSub = (name) => (name.endsWith(`.${zone}`) ? name.slice(0, -(`.${zone}`).length) : name);
  async function desecCreate({ name, type, content }) {
    await desecRequest('POST', '/rrsets/', { subname: desecSub(name), type, ttl: 3600, records: [type === 'CNAME' ? `${content}.` : content] });
  }
  async function desecDelete({ name, type }) {
    await desecRequest('DELETE', `/rrsets/${desecSub(name)}/${type}/`);
  }

  async function createHandleRecords({ handle, acmeFulldomain }) {
    const aRec = { type: 'A', name: `${handle}.${zone}`, content: relayIp };
    const cname = { type: 'CNAME', name: `_acme-challenge.${handle}.${zone}`, content: acmeFulldomain };
    if (provider === 'mock') { records.push(aRec, cname); return { created: [aRec, cname] }; }
    if (provider === 'cloudflare') { await cfCreate(aRec); await cfCreate(cname); return { created: [aRec, cname] }; }
    if (provider === 'desec') { await desecCreate(aRec); await desecCreate(cname); return { created: [aRec, cname] }; }
    throw new Error(`unknown DNS provider: ${provider}`);
  }

  // Tear down a handle's records (on /release, or to roll back a failed provision).
  // Frees the name for everyone and orphans the acme-dns subdomain harmlessly.
  async function deleteHandleRecords({ handle }) {
    const [aName, cName] = recordNames(handle);
    if (provider === 'mock') {
      const keep = records.filter((r) => r.name !== aName && r.name !== cName);
      records.splice(0, records.length, ...keep);
      return { deleted: [aName, cName] };
    }
    if (provider === 'cloudflare') { await cfDelete(aName); await cfDelete(cName); return { deleted: [aName, cName] }; }
    if (provider === 'desec') { await desecDelete({ name: aName, type: 'A' }); await desecDelete({ name: cName, type: 'CNAME' }); return { deleted: [aName, cName] }; }
    throw new Error(`unknown DNS provider: ${provider}`);
  }

  // Does ANY record already exist at <handle>.<zone>? Lets the control-plane refuse
  // a handle that collides with a pre-existing record (legacy site, infra, another
  // tenant) WITHOUT a hand-maintained list: a name auto-frees the moment its record
  // is removed, and any new record is auto-protected. Throws on API error → the
  // caller fails closed (never create a second, conflicting record).
  async function recordExists({ handle }) {
    const name = `${handle}.${zone}`;
    if (provider === 'mock') return records.some((r) => r.name === name);
    if (provider === 'cloudflare') {
      const data = await cfRequest('GET', `/dns_records?name=${encodeURIComponent(name)}`);
      return Array.isArray(data.result) && data.result.length > 0;
    }
    if (provider === 'desec') {
      const data = await desecRequest('GET', `/rrsets/?subname=${encodeURIComponent(handle)}`);
      return Array.isArray(data) && data.length > 0;
    }
    throw new Error(`unknown DNS provider: ${provider}`);
  }

  return { provider, records, createHandleRecords, deleteHandleRecords, recordExists };
}
