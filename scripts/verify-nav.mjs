// Verify Phase N — the launch navigation IA (NAV-IA-LOCK-2026-06-08). A STATIC
// source check (no portal build / no browser needed, matching this env's
// constraints): it asserts the shell components expose the locked 5-destination
// surface and the Streams/People groupings. Proves:
//
//   N1 PRIMARY_NAV = the launch set     /mindscape /library /streams + People(→/connections),
//                                        sourced from lib/nav/config.ts (#212 single source of truth)
//   N2 deferred nav arrays gone          no moduleNav / spacesItem / fleetNav
//   N3 zero dead 404 probes              no /portal/fleet/gate in Sidebar
//   N4 "Coming later" group present      comingLater[] with the planned screens
//   N5 mobile tabs = the launch set      BottomTabBar = Mycelium/Library/Streams/People, no chat tab
//   N6 chat toggle wired (in-app agent)  Header toggleChat + layout Cmd/Ctrl+J
//   N7 Header is a window-drag region    (Tauri native shell)
//   N8 Import has a drag-and-drop zone   (in ImportView, now a Streams facet)
//   N9 local portal header drag region
//   N10 Streams merge + People sub-nav   registry has `streams` (not import/timeline);
//                                         StreamsView + PeopleNav exist
//
// PASS/FAIL ledger + VERDICT + EXIT=<code>. See docs/NAV-IA-LOCK-2026-06-08.md.

import { readFileSync, existsSync } from "node:fs";
import { fileURLToPath } from "node:url";
import path from "node:path";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const P = (...p) => path.join(HERE, "..", "portal-app", "src", ...p);
const read = (f) => readFileSync(f, "utf8");

const ledger = [];
const rec = (n, pass, d = "") => { ledger.push(pass); console.log(`${pass ? "PASS" : "FAIL"}  ${n}${d ? `\n      ${d}` : ""}`); };

const sidebar = read(P("lib", "components", "shell", "Sidebar.svelte"));
const tabbar = read(P("lib", "components", "shell", "BottomTabBar.svelte"));
// Nav is now a SINGLE SOURCE OF TRUTH (lib/nav/config.ts, PR #212): the sidebar
// and the mobile tab bar both derive from PRIMARY_NAV. N1/N5 validate that file
// + that the surfaces derive from it (rather than the pre-#212 inline arrays).
const navConfig = read(P("lib", "nav", "config.ts"));
const header = read(P("lib", "components", "shell", "Header.svelte"));
const layout = read(P("routes", "(app)", "+layout.svelte"));
const registry = read(P("lib", "workspace", "registry.ts"));
// The Import UI is a facet of Streams now; the drop zone lives in ImportView.
const importView = read(P("lib", "views", "ImportView.svelte"));

// N1 — PRIMARY_NAV (the single source of truth) is exactly the launch set, and the
// Sidebar derives its nav from it (no pre-#212 inline `coreNav`). Profile +
// Settings are pinned in the footer; Curious Life / Agents are NAV_SECTIONS. The
// People entry routes to /connections (its cluster — Spaces / Sharing — lives in
// the contextual sub-nav).
const primaryBlock = (navConfig.match(/export const PRIMARY_NAV[^[]*\[([\s\S]*?)\];/) || [])[1] || "";
const hrefs = [...primaryBlock.matchAll(/href:\s*'([^']+)'/g)].map((m) => m[1]);
const want = ["/mindscape", "/library", "/streams", "/connections"];
const sidebarDerives = /\$lib\/nav\/config/.test(sidebar) && /PRIMARY_NAV/.test(sidebar);
rec("N1 PRIMARY_NAV = the launch set + Sidebar derives from it",
  JSON.stringify(hrefs) === JSON.stringify(want) && sidebarDerives,
  `got ${JSON.stringify(hrefs)} sidebarDerives=${sidebarDerives}`);

// N2 — the deferred module/social/fleet nav arrays are gone.
const leftovers = ["moduleNav", "spacesItem", "fleetNav"].filter((s) => sidebar.includes(s));
rec("N2 deferred nav arrays removed", leftovers.length === 0,
  leftovers.length ? `still present: ${leftovers.join(", ")}` : "");

// N3 — no dead probes that 404 in V1. /portal/connections/count is LIVE
// (src/portal-compat.js) and legitimately powers the People badge; /portal/fleet/gate stays banned.
const probes = ["/portal/fleet/gate"].filter((s) => sidebar.includes(s));
rec("N3 zero dead 404 probes in Sidebar", probes.length === 0,
  probes.length ? `still calls: ${probes.join(", ")}` : "");

// N4 — the not-yet-shipped life-domain facets (Wealth/Intel/…) moved INTO Streams
// in the nav redesign (c9dcf4f): the Sidebar no longer carries a separate
// `comingLater` nav group. Mirrors N2's "deferred nav arrays removed" intent.
const noComingLaterNav = !/const comingLater\s*=\s*\[/.test(sidebar);
rec("N4 'Coming later' nav group removed (now Streams facets)", noComingLaterNav);

// N5 — mobile tab bar = the launch set, derived from the SAME PRIMARY_NAV as the
// sidebar (no chat tab; Import is a Streams facet, not a standalone tab). Since the
// tabs ARE PRIMARY_NAV, the destination set is N1's `hrefs`; here we assert the
// derivation + that no chat/import leaks in.
const tabDerives = /\$lib\/nav\/config/.test(tabbar) && /PRIMARY_NAV/.test(tabbar);
rec("N5 BottomTabBar = launch set (derives PRIMARY_NAV), no chat/import tab",
  tabDerives && hrefs.includes("/streams") && hrefs.includes("/connections")
    && !hrefs.includes("/import") && !/'chat'/.test(tabbar) && !/toggleChat/.test(tabbar),
  `tabDerives=${tabDerives} tabs=${JSON.stringify(hrefs)}`);

// N6 — chat is LIVE: the in-app tool-using agent shipped (src/portal-chat.js),
// so the Header has a toggleChat launcher and the layout's Cmd/Ctrl+J toggles it.
const chatWired = /toggleChat/.test(header) && /key === 'j'[\s\S]*?toggleChat/.test(layout);
rec("N6 chat toggle wired (in-app agent live)", chatWired);

// N7 — the header is a window-drag handle in the native shell (no native title bar).
rec("N7 Header is a window-drag region (Tauri)", /data-tauri-drag-region/.test(header) && /startWindowDrag/.test(header));

// N8 — Import accepts drag-and-drop, not just a file picker (in the ImportView).
rec("N8 Import has a drag-and-drop drop zone", /ondrop=/.test(importView) && /onDrop/.test(importView));

// N9 — the LOCAL single-file portal is also a window-drag handle in the shell.
const localPortal = read(path.join(HERE, "..", "portal", "index.html"));
rec("N9 local portal header is a window-drag region", /<header data-tauri-drag-region/.test(localPortal) && /startDragging/.test(localPortal));

// N10 — Streams merge (Import + Timeline → one registry view) + People sub-nav exist.
const streamsMerged = /\bstreams:\s*{/.test(registry)
  && !/\bimport:\s*{/.test(registry) && !/\btimeline:\s*{/.test(registry);
const viewsExist = existsSync(P("lib", "views", "StreamsView.svelte"))
  && existsSync(P("lib", "components", "people", "PeopleNav.svelte"));
rec("N10 Streams merged + PeopleNav present", streamsMerged && viewsExist,
  `registry streams=${streamsMerged} views=${viewsExist}`);

const pass = ledger.every(Boolean);
console.log(`\nVERDICT: ${pass ? "GO" : "NO-GO"} — ${ledger.filter(Boolean).length}/${ledger.length} checks`);
process.exit(pass ? 0 : 1);
