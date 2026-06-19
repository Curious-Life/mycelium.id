## What & why

<!-- What does this change do, and why? Link any related issue. -->

## Surface touched

<!-- Tick anything this PR touches — security-sensitive areas always need human review. -->
- [ ] Encryption / key handling / at-rest
- [ ] Auth / transport (OAuth, REST, portal, remote)
- [ ] Egress / send chokepoints
- [ ] Embedding / clustering pipeline
- [ ] MCP tools
- [ ] UI (portal-app)
- [ ] Docs / build / CI only

## Verification

- [ ] `npm run verify` is green (or the focused gates for the surface touched)
- [ ] New behavior has a test or a verify gate
- [ ] No secrets, keys, or vault data in logs, errors, responses, or fixtures

## Notes for reviewers

<!-- Anything reviewers should focus on. Flag security-sensitive diffs explicitly. -->
