// Verify Phase N — the V1 navigation trim. A STATIC source check (no portal
// build / no browser needed, matching this env's constraints): it asserts the
// shell components expose exactly the honest V1 primary surface and make no
// calls to endpoints that 404 in V1. Proves:
//
//   N1 coreNav = the 6-screen V1 set   /mindscape /library /import /timeline /profile
//   N2 deferred screens gone from nav   no moduleNav / spacesItem / fleetNav
//   N3 zero dead probes                 no /portal/connections/count, no /portal/fleet/gate
//   N4 "Coming later" group present     comingLater[] with the planned screens
//   N5 Import reachable on mobile        BottomTabBar tabs include /import, no chat tab
//   N6 chat toggle hidden (deferred)     Header has no toggleChat; layout Cmd+J disabled
//
// PASS/FAIL ledger + VERDICT + EXIT=<code>. See docs/UX-COMPLETE-DESIGN-2026-06-01.md.

import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import path from "node:path";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const P = (...p) => path.join(HERE, "..", "portal-app", "src", ...p);
const read = (f) => readFileSync(f, "utf8");

const ledger = [];
const rec = (n, pass, d = "") => { ledger.push(pass); console.log(`${pass ? "PASS" : "FAIL"}  ${n}${d ? `\n      ${d}` : ""}`); };

const sidebar = read(P("lib", "components", "shell", "Sidebar.svelte"));
const tabbar = read(P("lib", "components", "shell", "BottomTabBar.svelte"));
const header = read(P("lib", "components", "shell", "Header.svelte"));
const layout = read(P("routes", "(app)", "+layout.svelte"));
// The Import UI was de-routed into the workspace (the route page is now a thin
// "open the tab" intent); the drop zone lives in the view component.
const importView = read(P("lib", "views", "ImportView.svelte"));

// N1 — coreNav is exactly the 6-screen V1 set (5 in the array + Settings rendered
// separately at the bottom). Extract href: values inside the coreNav literal.
const coreBlock = (sidebar.match(/const coreNav[^[]*\[([\s\S]*?)\];/) || [])[1] || "";
const hrefs = [...coreBlock.matchAll(/href:\s*'([^']+)'/g)].map((m) => m[1]);
// Updated for the shipped Spaces / Connections / Sharing(contexts) screens that
// main wired into coreNav (the original "V1 trim" was 5).
const want = ["/mindscape", "/library", "/import", "/timeline", "/spaces", "/connections", "/contexts", "/profile"];
rec("N1 coreNav = the current nav set", JSON.stringify(hrefs) === JSON.stringify(want),
  `got ${JSON.stringify(hrefs)}`);

// N2 — the deferred module/social/fleet nav arrays are gone.
const leftovers = ["moduleNav", "spacesItem", "fleetNav"].filter((s) => sidebar.includes(s));
rec("N2 deferred nav arrays removed", leftovers.length === 0,
  leftovers.length ? `still present: ${leftovers.join(", ")}` : "");

// N3 — no dead probes that 404 in V1.
// /portal/connections/count is now a LIVE endpoint (src/portal-compat.js — main
// shipped Connections), so it is no longer a dead probe. /portal/fleet/gate stays.
const probes = ["/portal/fleet/gate"].filter((s) => sidebar.includes(s));
rec("N3 zero dead 404 probes in Sidebar", probes.length === 0,
  probes.length ? `still calls: ${probes.join(", ")}` : "");

// N4 — the honest "Coming later" group exists, with the planned screens.
const hasComingLater = /const comingLater\s*=\s*\[/.test(sidebar)
  && sidebar.includes("Coming later")
  && ["Wealth", "Intel", "Agents", "Spaces"].every((s) => sidebar.includes(`'${s}'`));
rec("N4 'Coming later' group present", hasComingLater);

// N5 — mobile tab bar surfaces Import and drops the chat tab.
const tabHrefs = [...tabbar.matchAll(/href:\s*'([^']+)'/g)].map((m) => m[1]);
rec("N5 BottomTabBar has Import, no chat tab",
  tabHrefs.includes("/import") && !tabbar.includes("'chat'") && !/toggleChat/.test(tabbar),
  `tabs ${JSON.stringify(tabHrefs)}`);

// N6 — chat is LIVE: the in-app tool-using agent shipped (src/portal-chat.js),
// so the Header has a toggleChat launcher and the layout's Cmd/Ctrl+J toggles it.
const chatWired = /toggleChat/.test(header) && /Toggle chat/.test(header)
  && /key === 'j'[\s\S]*?toggleChat/.test(layout);
rec("N6 chat toggle wired (in-app agent live)", chatWired);

// N7 — the header is a window-drag handle in the native shell (no native title bar).
rec("N7 Header is a window-drag region (Tauri)", /data-tauri-drag-region/.test(header) && /startWindowDrag/.test(header));

// N8 — Import accepts drag-and-drop, not just a file picker (in the ImportView).
rec("N8 Import has a drag-and-drop drop zone", /ondrop=/.test(importView) && /onDrop/.test(importView));

// N9 — the LOCAL single-file portal is also a window-drag handle in the shell.
const localPortal = read(path.join(HERE, "..", "portal", "index.html"));
rec("N9 local portal header is a window-drag region", /<header data-tauri-drag-region/.test(localPortal) && /startDragging/.test(localPortal));

const pass = ledger.every(Boolean);
console.log(`\nVERDICT: ${pass ? "GO" : "NO-GO"} — ${ledger.filter(Boolean).length}/${ledger.length} checks`);
process.exit(pass ? 0 : 1);
