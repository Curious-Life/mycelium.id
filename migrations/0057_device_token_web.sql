-- 0057_device_token_web.sql — generalize device_tokens from "phone pairing" to
-- "per-client tokens", so the SAME token+session mechanism backs BOTH the mobile
-- app (kind='phone', minted by QR pairing) and a web browser (kind='web', minted
-- after password/passkey login). See docs/UNIFIED-AUTH-DESIGN-2026-07-24.md.
--
--  • kind:            a NON-secret label only. It changes NO authorization — a
--                     kind='web' token has exactly the authority of a kind='phone'
--                     token (owner-device data credential; neither can drive the
--                     loopback-only pairing ceremony). It exists so the owner's
--                     "devices" list can show "Web — Safari" vs "Pixel 9".
--  • idle_expires_at: OPTIONAL idle-logout policy expressed AT THE TOKEN LAYER, so
--                     an idle timeout expires the TOKEN (and therefore, via the
--                     device_sessions JOIN, the session) TOGETHER — preserving
--                     validity==token-liveness (R0). NULL ⇒ no idle policy (the
--                     default for both kinds); a non-null value in the past ⇒ dead.
ALTER TABLE device_tokens ADD COLUMN kind TEXT NOT NULL DEFAULT 'phone';
ALTER TABLE device_tokens ADD COLUMN idle_expires_at TEXT DEFAULT NULL;
