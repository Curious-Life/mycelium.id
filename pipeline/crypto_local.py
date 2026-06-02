"""crypto_local.py — local envelope decryption for the V1 single-user vault.

Python port of the decrypt path in ``src/crypto/crypto-local.js`` (itself a
port of the Cloudflare Worker crypto). Only the read side is implemented —
the V1 pipeline never *writes* encrypted columns from Python.

Envelope format (base64(JSON)):
    { "v": 1|2|3, "s": <scope>, "iv": b64(12B), "ct": b64, "dk": b64,
      optional "u": <userId> (v2/v3), optional "kf": "user"|"system" (v3) }

Key hierarchy (HKDF-SHA256, salt = 32 zero bytes):
    masterKey
      └─(v2/v3 with u)─ HKDF "mycelium:user:<userId>:v1"   → userKey
      └─ HKDF "mycelium:scope:<scope>:v1"                  → scopeKey (AES-KW)
    DEK = AES-KW-unwrap(scopeKey, dk)
    plaintext = AES-256-GCM-decrypt(DEK, iv, ct)   # tagLength 128 (default)

For embedding vectors specifically, the plaintext is base64-ASCII (the JS
``encodeVector`` base64-encodes the float32 buffer *before* encryption — see
``src/search/ann/decode.js``). Callers therefore base64-decode the bytes
returned by :func:`decrypt_bytes` to recover the raw float32 buffer. That
extra decode is the caller's responsibility (matches cluster.py).

The functions accessed by compute_information_harmonics.py are:
    - load_master_key() -> bytes        (32-byte key)
    - decrypt_bytes(envelope_str, master_key) -> bytes  (decrypted plaintext)
"""

from __future__ import annotations

import base64
import json
import os
from pathlib import Path
from typing import Optional

from cryptography.hazmat.primitives import hashes
from cryptography.hazmat.primitives.ciphers.aead import AESGCM
from cryptography.hazmat.primitives.kdf.hkdf import HKDF
from cryptography.hazmat.primitives.keywrap import aes_key_unwrap

_HKDF_SALT = b"\x00" * 32

# tmpfs path used on the VPS (kept as a fallback for parity with the JS side).
_TMPFS_KEY_PATH = "/run/mycelium/master.key"
_TMPFS_SYSTEM_KEY_PATH = "/run/mycelium/system.key"

# Env var names checked, in priority order. The local run-clustering harness
# exports USER_MASTER / SYSTEM_KEY (see the project README + run scripts); the
# cloud code used ENCRYPTION_MASTER_KEY. Accept all so either invocation works.
_MASTER_ENV_VARS = ("USER_MASTER", "USER_MASTER_KEY", "ENCRYPTION_MASTER_KEY")
_SYSTEM_ENV_VARS = ("SYSTEM_KEY",)


def _hex_to_bytes(hex_str: str) -> bytes:
    hex_str = hex_str.strip()
    if len(hex_str) != 64:
        raise ValueError("master key must be 64 hex chars (256 bits)")
    return bytes.fromhex(hex_str)


def _read_key_hex(env_vars: tuple[str, ...], tmpfs_path: str) -> Optional[str]:
    # Prefer tmpfs (RAM-only, never on disk) for parity with the VPS; fall
    # back to env vars for local / off-VPS invocations.
    try:
        p = Path(tmpfs_path)
        if p.exists():
            hx = p.read_text().strip()
            if len(hx) == 64:
                return hx
    except Exception:
        pass
    for name in env_vars:
        val = os.environ.get(name)
        if val and len(val.strip()) == 64:
            return val.strip()
    return None


def load_master_key() -> bytes:
    """Return the 32-byte user master key (fail-closed if unavailable)."""
    hx = _read_key_hex(_MASTER_ENV_VARS, _TMPFS_KEY_PATH)
    if not hx:
        raise RuntimeError(
            "master key not found; set USER_MASTER (64 hex chars) or place it "
            f"at {_TMPFS_KEY_PATH}"
        )
    return _hex_to_bytes(hx)


def load_system_key() -> Optional[bytes]:
    """Return the 32-byte operator system key, or None if unavailable.

    Only needed for v3 kf='system' envelopes (operator infra secrets). The
    harmonics pipeline reads vault data (kf='user'), so this is optional.
    """
    hx = _read_key_hex(_SYSTEM_ENV_VARS, _TMPFS_SYSTEM_KEY_PATH)
    return _hex_to_bytes(hx) if hx else None


def _hkdf(base_key: bytes, info: str) -> bytes:
    return HKDF(
        algorithm=hashes.SHA256(),
        length=32,
        salt=_HKDF_SALT,
        info=info.encode("utf-8"),
    ).derive(base_key)


def _derive_user_key(master_key: bytes, user_id: str) -> bytes:
    return _hkdf(master_key, f"mycelium:user:{user_id}:v1")


def _derive_scope_key(base_key: bytes, scope: str) -> bytes:
    return _hkdf(base_key, f"mycelium:scope:{scope}:v1")


def _derive_system_scope_key(system_key: bytes, scope: str) -> bytes:
    return _hkdf(system_key, f"mycelium:system-scope:{scope}:v1")


def is_encrypted(value) -> bool:
    """True if ``value`` looks like one of our base64(JSON) envelopes."""
    if not isinstance(value, str) or len(value) < 20:
        return False
    try:
        obj = json.loads(base64.b64decode(value))
    except Exception:
        return False
    return bool(
        obj.get("v") in (1, 2, 3)
        and obj.get("s")
        and obj.get("iv")
        and obj.get("ct")
        and obj.get("dk")
    )


def decrypt_bytes(envelope_str: str, master_key: bytes,
                  system_key: Optional[bytes] = None) -> bytes:
    """Decrypt a base64(JSON) envelope → plaintext bytes.

    Mirrors ``crypto-local.js::decrypt``. ``system_key`` is only consulted
    for v3 kf='system' envelopes; if needed and not supplied, it is loaded
    lazily via :func:`load_system_key`.
    """
    env = json.loads(base64.b64decode(envelope_str))
    v = env.get("v")
    if v not in (1, 2, 3):
        raise ValueError(f"unknown envelope version: {v!r}")

    scope = env["s"]
    key_family = env.get("kf", "user") if v == 3 else "user"

    if key_family == "system":
        sk = system_key if system_key is not None else load_system_key()
        if not sk:
            raise RuntimeError(
                f"SYSTEM_KEY required to decrypt envelope (scope={scope!r}) "
                "but none provided"
            )
        scope_key = _derive_system_scope_key(sk, scope)
    else:
        base_key = master_key
        if v in (2, 3) and env.get("u"):
            base_key = _derive_user_key(master_key, env["u"])
        scope_key = _derive_scope_key(base_key, scope)

    dek = aes_key_unwrap(scope_key, base64.b64decode(env["dk"]))
    iv = base64.b64decode(env["iv"])
    ct = base64.b64decode(env["ct"])
    # AES-GCM with the standard 128-bit tag appended to the ciphertext, which
    # is exactly what WebCrypto's subtle.encrypt produces.
    return AESGCM(dek).decrypt(iv, ct, None)


def decrypt_str(envelope_str: str, master_key: bytes,
                system_key: Optional[bytes] = None) -> str:
    """Decrypt an envelope whose plaintext is UTF-8 text → str."""
    return decrypt_bytes(envelope_str, master_key, system_key).decode("utf-8")
