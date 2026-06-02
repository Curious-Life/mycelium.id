// acmedns.js — register a per-handle account with our self-hosted acme-dns server
// (run with disable_registration=true so ONLY the control-plane can register).
// Returns {username,password,subdomain,fulldomain}: the scoped credential the
// user's Caddy uses for DNS-01, and the fulldomain we CNAME _acme-challenge to.
// A leaked credential can only rewrite its own subdomain's TXT (verified upstream).
export function createAcmeDnsClient({ serverUrl, mock = false, registrations = [] } = {}) {
  async function register() {
    if (mock) {
      const i = registrations.length;
      const r = {
        username: `u-${i}-${Math.floor(Math.random() * 1e6)}`,
        password: `p-${i}`,
        subdomain: `sub-${i}`,
        fulldomain: `sub-${i}.auth.mycelium.id`,
        allowfrom: [],
      };
      registrations.push(r);
      return r;
    }
    const res = await fetch(`${String(serverUrl).replace(/\/$/, '')}/register`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: '{}', // allowfrom left open: the renewing Mac has a variable residential IP
    });
    if (!res.ok) throw new Error(`acme-dns register failed (${res.status})`);
    return res.json();
  }
  return { register, registrations };
}
