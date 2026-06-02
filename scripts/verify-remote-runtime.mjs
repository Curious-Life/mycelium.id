// verify:remote-runtime — the on-disk config renderers for the bundled sidecars.
//   RT1 renderFrpcToml: serverAddr/serverPort parsed; type=https passthrough; token in metadatas
//   RT2 renderCaddyfile: site=publicHost:8443, bind loopback, acme-dns creds, reverse_proxy :4711, storage
//   RT3 materialize(managed): frpc.toml + Caddyfile at 0600
//   RT4 materialize(direct): Caddyfile only (public :443), no frpc.toml
//   RT5 materialize(off): nothing (removes stale)
// Pure fs to a temp dir; no network/server; never logs a secret value.
import { rmSync, mkdirSync, existsSync, readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';
import os from 'node:os';
import { parseRelayAddr, renderFrpcToml, renderCaddyfile, materializeRemoteConfigs } from '../src/remote/runtime.js';

const TMP = join(os.tmpdir(), `myc-runtime-${process.pid}`);
const ledger = [];
const rec = (n, ok, d = '') => { ledger.push(ok); console.log(`${ok ? 'PASS' : 'FAIL'}  ${n}${d ? '\n      ' + d : ''}`); };
rmSync(TMP, { recursive: true, force: true });
mkdirSync(TMP, { recursive: true });

const fixture = { remoteMode: 'managed', publicHost: 'alice.mycelium.id', relayAddr: 'relay.mycelium.id:7000', relayVhostPort: 443 };
const acmeDns = { username: 'u1', password: 'p1', subdomain: 'sub1', serverUrl: 'https://acme-dns.mycelium.id' };
const TOKEN = 'tenant-token-xyz';
const mode0600 = (p) => (statSync(p).mode & 0o777) === 0o600;

// RT1
const frpc = renderFrpcToml({ relayAddr: fixture.relayAddr, publicHost: fixture.publicHost, token: TOKEN });
const pr = parseRelayAddr(fixture.relayAddr);
rec('RT1. frpc.toml: serverAddr/Port parsed, type=https, customDomains, token in metadatas',
  pr.host === 'relay.mycelium.id' && pr.port === 7000
  && frpc.includes('serverAddr = "relay.mycelium.id"') && frpc.includes('serverPort = 7000')
  && frpc.includes('type = "https"') && frpc.includes('customDomains = ["alice.mycelium.id"]')
  && frpc.includes(`metadatas.token = "${TOKEN}"`) && frpc.includes('localPort = 8443'),
  `host=${pr.host} port=${pr.port}`);

// RT2
const caddy = renderCaddyfile({ publicHost: fixture.publicHost, dataDir: TMP, acmeDns, mode: 'managed' });
rec('RT2. Caddyfile: site host:8443, bind loopback, acme-dns creds, reverse_proxy :4711, storage',
  caddy.includes('https://alice.mycelium.id:8443') && caddy.includes('bind 127.0.0.1')
  && caddy.includes('dns acmedns') && caddy.includes('username u1') && caddy.includes('subdomain sub1')
  && caddy.includes('server_url https://acme-dns.mycelium.id')
  && caddy.includes('reverse_proxy 127.0.0.1:4711') && caddy.includes(`storage file_system ${join(TMP, 'caddy')}`),
  '');

// RT3 — managed writes both at 0600
const r3 = materializeRemoteConfigs({ dataDir: TMP, config: fixture, relayToken: TOKEN, acmeDns });
rec('RT3. materialize(managed) writes frpc.toml + Caddyfile at 0600',
  existsSync(join(TMP, 'frpc.toml')) && existsSync(join(TMP, 'Caddyfile'))
  && mode0600(join(TMP, 'frpc.toml')) && mode0600(join(TMP, 'Caddyfile')) && r3.wrote.length === 2,
  `wrote=${r3.wrote.length}`);

// RT4 — direct writes Caddyfile only (public :443), no frpc.toml
rmSync(TMP, { recursive: true, force: true });
mkdirSync(TMP, { recursive: true });
materializeRemoteConfigs({ dataDir: TMP, config: { ...fixture, remoteMode: 'direct', publicHost: 'box.example.com' }, acmeDns });
const caddy4 = readFileSync(join(TMP, 'Caddyfile'), 'utf8');
rec('RT4. materialize(direct): Caddyfile only (public :443), no frpc.toml',
  existsSync(join(TMP, 'Caddyfile')) && !existsSync(join(TMP, 'frpc.toml'))
  && caddy4.includes('box.example.com {') && !caddy4.includes(':8443') && !caddy4.includes('bind 127.0.0.1'),
  `frpcExists=${existsSync(join(TMP, 'frpc.toml'))}`);

// RT5 — off removes stale
const r5 = materializeRemoteConfigs({ dataDir: TMP, config: { ...fixture, remoteMode: 'off' } });
rec('RT5. materialize(off): no configs (stale removed)',
  !existsSync(join(TMP, 'frpc.toml')) && !existsSync(join(TMP, 'Caddyfile')) && r5.wrote.length === 0, '');

// RT6 — parseRelayAddr: host:port, bare host, [ipv6]:port, bare ipv6.
const pa = (s) => parseRelayAddr(s);
rec('RT6. parseRelayAddr handles host:port, bare host, and IPv6',
  pa('relay.x:7000').host === 'relay.x' && pa('relay.x:7000').port === 7000
  && pa('relay.x').host === 'relay.x' && pa('relay.x').port === 7000
  && pa('[::1]:7000').host === '::1' && pa('[::1]:7000').port === 7000
  && pa('2001:db8::1').host === '2001:db8::1' && pa('2001:db8::1').port === 7000,
  `v6bracket=${pa('[::1]:7000').host}:${pa('[::1]:7000').port} v6bare=${pa('2001:db8::1').host}`);

rmSync(TMP, { recursive: true, force: true });
const allPass = ledger.every(Boolean);
console.log('\n' + '='.repeat(64));
console.log(`VERDICT: ${allPass ? 'GO — sidecar config renderers correct' : 'NO-GO — see FAIL rows'}`);
console.log('='.repeat(64));
process.exit(allPass ? 0 : 1);
