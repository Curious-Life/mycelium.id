// Verify Phase 3 — Gmail + Linear adapter normalize() + pull() logic.
// No network: pull() takes an injected fetchImpl returning fixtures. (Real
// OAuth + live API round-trips are host-verified.)
//
//   A1 gmail.normalize    full message → captureMessage args
//   A2 gmail.pull         list + get fixtures → items + advancing cursor
//   A3 gmail guard         no token → throws
//   A4 linear.normalize   issue node → captureMessage args
//   A5 linear.pull        graphql fixture → items + max-updatedAt cursor
//   A6 linear error        graphql errors surface
//
// PASS/FAIL ledger + VERDICT + EXIT=<code>.

import { normalize as gmailNormalize, gmailAdapter } from '../src/connectors/adapters/gmail.js';
import { normalize as linearNormalize, linearAdapter } from '../src/connectors/adapters/linear.js';

const ledger = [];
const rec = (n, p, d = '') => { ledger.push(p); console.log(`${p ? 'PASS' : 'FAIL'}  ${n}${d ? `\n      ${d}` : ''}`); };
const jsonRes = (obj, ok = true, status = 200) => ({ ok, status, json: async () => obj });
const b64url = (s) => Buffer.from(s, 'utf8').toString('base64').replace(/\+/g, '-').replace(/\//g, '_');

const gmailMsg = (id, subject, from, bodyText, internalDate) => ({
  id, threadId: `t${id}`, internalDate: String(internalDate), snippet: bodyText.slice(0, 20),
  payload: {
    mimeType: 'multipart/alternative',
    headers: [{ name: 'Subject', value: subject }, { name: 'From', value: from }, { name: 'Date', value: 'Mon, 01 Jan 2026 00:00:00 +0000' }],
    parts: [{ mimeType: 'text/plain', body: { data: b64url(bodyText) } }],
  },
});

async function main() {
  // ── A1 gmail.normalize ──
  const n1 = gmailNormalize(gmailMsg('g1', 'Hello world', 'alice@example.com', 'this is the email body', 1735689600000));
  rec('A1. gmail.normalize → captureMessage args',
    n1.source === 'gmail' && n1.id === 'gmail:g1' && n1.content.includes('Hello world')
      && n1.content.includes('this is the email body') && n1.metadata.from === 'alice@example.com'
      && typeof n1.createdAt === 'string',
    `id=${n1.id} from=${n1.metadata.from} hasBody=${n1.content.includes('this is the email body')}`);

  // ── A2 gmail.pull ──
  const gFetch = async (url) => {
    if (url.includes('/messages?')) return jsonRes({ messages: [{ id: 'g1' }, { id: 'g2' }] });
    if (url.includes('/messages/g1')) return jsonRes(gmailMsg('g1', 'First', 'a@x.com', 'body one', 1735689600000));
    if (url.includes('/messages/g2')) return jsonRes(gmailMsg('g2', 'Second', 'b@x.com', 'body two', 1735776000000));
    return jsonRes({}, false, 404);
  };
  const g = await gmailAdapter.pull({ tokens: { access_token: 'tok' }, fetchImpl: gFetch }, { cursor: null });
  rec('A2. gmail.pull → 2 items + advancing cursor',
    g.items.length === 2 && g.items[0].id === 'gmail:g1' && Number(g.nextCursor) > 1735689600000,
    `items=${g.items.length} cursor=${g.nextCursor}`);

  // ── A3 gmail guard ──
  let gThrew = false;
  try { await gmailAdapter.pull({ tokens: {}, fetchImpl: gFetch }, {}); } catch { gThrew = true; }
  rec('A3. gmail.pull without token throws', gThrew);

  // ── A4 linear.normalize ──
  const ln = linearNormalize({ id: 'iss1', identifier: 'ENG-1', title: 'Fix the bug', description: 'steps to repro', updatedAt: '2026-01-02T00:00:00.000Z', url: 'https://linear.app/x/ENG-1', state: { name: 'In Progress' } });
  rec('A4. linear.normalize → captureMessage args (stable id, no updatedAt)',
    ln.source === 'linear' && ln.id === 'linear:iss1'
      && ln.content.includes('Fix the bug') && ln.metadata.identifier === 'ENG-1' && ln.metadata.state === 'In Progress',
    `id=${ln.id} ident=${ln.metadata.identifier}`);

  // ── A5 linear.pull ──
  const lFetch = async () => jsonRes({ data: { issues: { nodes: [
    { id: 'i1', identifier: 'ENG-1', title: 'A', description: 'a', updatedAt: '2026-01-02T00:00:00.000Z', url: 'u', state: { name: 'Todo' } },
    { id: 'i2', identifier: 'ENG-2', title: 'B', description: 'b', updatedAt: '2026-01-03T00:00:00.000Z', url: 'u', state: { name: 'Done' } },
  ] } } });
  const l = await linearAdapter.pull({ tokens: { access_token: 'tok' }, fetchImpl: lFetch }, { cursor: '2026-01-01T00:00:00.000Z' });
  rec('A5. linear.pull → 2 items + max-updatedAt cursor',
    l.items.length === 2 && l.items[1].id.startsWith('linear:i2') && l.nextCursor === '2026-01-03T00:00:00.000Z',
    `items=${l.items.length} cursor=${l.nextCursor}`);

  // ── A6 linear graphql error ──
  let lThrew = false;
  try { await linearAdapter.pull({ tokens: { access_token: 't' }, fetchImpl: async () => jsonRes({ errors: [{ message: 'bad' }] }) }, {}); } catch { lThrew = true; }
  rec('A6. linear.pull surfaces graphql errors', lThrew);

  const allPass = ledger.every(Boolean);
  console.log(`VERDICT: ${allPass ? 'GO — gmail + linear adapters: normalize + incremental pull + cursor + guards' : 'NO-GO — see FAIL rows'}`);
  process.exit(allPass ? 0 : 1);
}

main().catch((e) => { console.error('verify-adapters threw:', e); process.exit(1); });
