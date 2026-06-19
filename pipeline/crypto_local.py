"""crypto_local.py — local envelope crypto for the V1 single-user vault.

A self-contained, reusable Python codec for the wrapped-DEK envelope used by
Mycelium. It is a faithful port of BOTH the read and write paths in
``src/crypto/crypto-local.js`` (itself a port of the Cloudflare Worker crypto),
so any Python service can encrypt/decrypt vault columns and the result is
byte-compatible with the JS adapter (envelopes written here decrypt in Node and
vice-versa).

Public surface:
    Keys:    load_master_key() · load_system_key()
    Decrypt: decrypt_bytes() · decrypt_str() · decrypt_safe() · decrypt_vector()
    Encrypt: encrypt_bytes() · encrypt_str() · encrypt_vector()
    Util:    is_encrypted()

Envelope format (base64(JSON)):
    { "v": 1|2|3, "s": <scope>, "iv": b64(12B), "ct": b64, "dk": b64,
      optional "u": <userId> (v2/v3), optional "kf": "user"|"system" (v3) }

Crypto invariants (must match the JS side byte-for-byte):
    - AES-256-GCM, 12-byte random IV, 128-bit tag appended to ciphertext
      (exactly what WebCrypto's subtle.encrypt produces).
    - DEK = random 32 bytes, wrapped with AES-KW (RFC 3394, default IV).
    - HKDF-SHA256, salt = 32 zero bytes, for every key derivation.
    - Float32 vectors are base64-encoded BEFORE encryption (see encrypt_vector /
      the JS encodeVector) so the plaintext is base64-ASCII. Little-endian.

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
from cryptography.hazmat.primitives.keywrap import aes_key_unwrap, aes_key_wrap

_HKDF_SALT = b"\x00" * 32

# Envelope constants — mirror src/crypto/crypto-local.js (IV_BYTES / DEK_BITS /
# TAG_LENGTH / ENVELOPE_VERSION). Changing any of these breaks cross-language
# compatibility, so they live next to the salt as load-bearing constants.
_ENVELOPE_VERSION = 1   # v1 = scope key derived straight from master (no userId)
_IV_BYTES = 12          # AES-GCM nonce
_DEK_BYTES = 32         # 256-bit data-encryption key

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


def decrypt_safe(envelope_str, master_key: bytes,
                 system_key: Optional[bytes] = None) -> Optional[str]:
    """Best-effort decrypt → str, or ``None`` on ANY failure (wrong key, not an
    envelope, corrupt ciphertext, non-UTF-8 plaintext).

    Never raises — for bulk reads that tolerate per-row skips (e.g. content
    encrypted under a rotated key). Callers branch on ``None``.
    """
    try:
        return decrypt_str(envelope_str, master_key, system_key)
    except Exception:
        return None


def decrypt_vector(envelope_str: str, master_key: bytes, dim: Optional[int] = None,
                   system_key: Optional[bytes] = None):
    """Decrypt a vector envelope → contiguous numpy float32 array.

    Inverse of :func:`encrypt_vector`. The envelope plaintext is base64-ASCII of
    the float32 buffer (see the module docstring), so we decrypt → base64-decode
    → ``np.frombuffer`` as little-endian float32. If ``dim`` is given the result
    is truncated to the matryoshka prefix (and validated to be long enough).

    numpy is imported lazily so the rest of the module stays dependency-light for
    services that only need bytes/str crypto.
    """
    import numpy as np
    raw = base64.b64decode(decrypt_bytes(envelope_str, master_key, system_key))
    arr = np.frombuffer(raw, dtype="<f4")
    if dim is not None:
        if arr.size < dim:
            raise ValueError(f"vector envelope too short: {arr.size} floats < dim={dim}")
        arr = arr[:dim]
    return np.ascontiguousarray(arr, dtype=np.float32)


# ── Encrypt (write path) ───────────────────────────────────────────
#
# Byte-compatible with ``src/crypto/crypto-local.js``::encrypt /
# encryptWithSystemKey. Three key-family routings, selected by arguments:
#   user_id=None, system_key=None  → v1 (scope key ← master_key)            [DEFAULT]
#   user_id set                    → v2 (scope key ← per-user key ← master) [customer data]
#   system_key set                 → v3 kf='system' (scope key ← system key)[infra secrets]
# The pipeline writes vault data (v1, like enrich's encryptVector-without-userId),
# but the full surface is provided so any service can reuse this module.


def _b64(b: bytes) -> str:
    return base64.b64encode(b).decode("ascii")


def encrypt_bytes(plaintext, scope: str, master_key: bytes,
                  user_id: Optional[str] = None, *,
                  system_key: Optional[bytes] = None) -> str:
    """Encrypt bytes/str → base64(JSON) wrapped-DEK envelope (str).

    The output decrypts cleanly in Node via ``crypto-local.js::decrypt`` and here
    via :func:`decrypt_bytes`. AES-256-GCM with a random DEK + 12-byte IV; the
    DEK is AES-KW-wrapped under the HKDF-derived scope key.
    """
    if isinstance(plaintext, str):
        plaintext = plaintext.encode("utf-8")
    elif isinstance(plaintext, (bytearray, memoryview)):
        plaintext = bytes(plaintext)
    elif not isinstance(plaintext, bytes):
        raise TypeError("encrypt_bytes: plaintext must be bytes or str")
    if not scope:
        raise ValueError("encrypt_bytes: scope is required")
    if system_key is None and not master_key:
        raise ValueError("encrypt_bytes: master_key is required")

    if system_key is not None:
        scope_key = _derive_system_scope_key(system_key, scope)
        version, key_family, user = 3, "system", None
    elif user_id:
        scope_key = _derive_scope_key(_derive_user_key(master_key, user_id), scope)
        version, key_family, user = 2, "user", user_id
    else:
        scope_key = _derive_scope_key(master_key, scope)
        version, key_family, user = _ENVELOPE_VERSION, "user", None

    dek = os.urandom(_DEK_BYTES)
    iv = os.urandom(_IV_BYTES)
    # AESGCM.encrypt returns ciphertext || 16-byte tag — identical layout to
    # WebCrypto subtle.encrypt({name:'AES-GCM', tagLength:128}).
    ct = AESGCM(dek).encrypt(iv, plaintext, None)
    wrapped_dek = aes_key_wrap(scope_key, dek)

    env = {"v": version, "s": scope, "iv": _b64(iv), "ct": _b64(ct), "dk": _b64(wrapped_dek)}
    if version == 3:
        env["kf"] = key_family
    if user:
        env["u"] = user
    # Compact JSON (no spaces) like JSON.stringify; key order is irrelevant since
    # the reader JSON-parses it back to an object.
    return base64.b64encode(
        json.dumps(env, separators=(",", ":")).encode("utf-8")
    ).decode("ascii")


def encrypt_str(text: str, scope: str, master_key: bytes,
                user_id: Optional[str] = None, *,
                system_key: Optional[bytes] = None) -> str:
    """Encrypt a UTF-8 string → envelope (thin alias over :func:`encrypt_bytes`)."""
    return encrypt_bytes(text, scope, master_key, user_id, system_key=system_key)


def _vector_to_f32_bytes(vec) -> bytes:
    """Coerce a vector (numpy array, bytes-like float32 buffer, or float sequence)
    to a little-endian float32 byte buffer — matching the JS encodeVector layout
    (Buffer of Float32Array, LE)."""
    if isinstance(vec, (bytes, bytearray, memoryview)):
        return bytes(vec)
    astype = getattr(vec, "astype", None)
    if astype is not None:  # numpy array (or array-like with astype/tobytes)
        return astype("<f4").tobytes()
    import array
    return array.array("f", vec).tobytes()  # native endianness == LE on x86/arm


def encrypt_vector(vec, scope: str, master_key: bytes,
                   user_id: Optional[str] = None, *,
                   system_key: Optional[bytes] = None) -> str:
    """Encrypt a float32 vector → wrapped-DEK envelope, byte-compatible with the
    JS ``encryptVector`` (``src/search/ann/decode.js``).

    The float32 buffer is base64-encoded BEFORE encryption (so the envelope
    plaintext is base64-ASCII), exactly as the JS encodeVector does. Accepts a
    numpy array, a bytes-like float32 buffer, or any sequence of floats.
    """
    b64 = base64.b64encode(_vector_to_f32_bytes(vec)).decode("ascii")
    return encrypt_str(b64, scope, master_key, user_id, system_key=system_key)


# ── SQLCipher-collapse codec (Stage A) ─────────────────────────────
# Vectors live as RAW little-endian float32 BYTES inside the whole-file-encrypted
# vault — no inner AES-GCM envelope, no base64. Same layout as the JS
# encodeVectorRaw / decodeStoredVector, so either side decodes the other.
# @see docs/DESIGN-sqlcipher-stageA-vectors-2026-06-19.md


def encode_vector_raw(vec) -> bytes:
    """Float32 vector → RAW little-endian bytes (no base64, no envelope) for direct
    BLOB storage. Same LE-f32 layout as encrypt_vector's pre-base64 buffer."""
    return _vector_to_f32_bytes(vec)


def decode_stored_vector(value, master_key: Optional[bytes] = None,
                         dim: Optional[int] = None, *,
                         system_key: Optional[bytes] = None):
    """Shape-aware vector read for the migration window (mirrors JS
    decodeStoredVector):

      - bytes/bytearray/memoryview → RAW little-endian float32 (new, no crypto)
      - str envelope               → legacy wrapped-DEK (:func:`decrypt_vector`)

    Returns a contiguous numpy float32 array (truncated to ``dim`` if given), or
    None for a None input.
    """
    if value is None:
        return None
    if isinstance(value, (bytes, bytearray, memoryview)):
        import numpy as np
        arr = np.frombuffer(bytes(value), dtype="<f4")
        if dim is not None:
            if arr.size < dim:
                raise ValueError(f"raw vector too short: {arr.size} floats < dim={dim}")
            arr = arr[:dim]
        return np.ascontiguousarray(arr, dtype=np.float32)
    return decrypt_vector(value, master_key, dim, system_key=system_key)


# ── Self-test ──────────────────────────────────────────────────────
# `python3 crypto_local.py` exercises every encrypt/decrypt path round-trip so
# any reusing service can sanity-check the module standalone (no vault needed).
if __name__ == "__main__":
    import sys

    mk = os.urandom(32)
    sk = os.urandom(32)
    ok = True

    def _check(name, cond):
        global ok
        ok = ok and cond
        print(f"{'PASS' if cond else 'FAIL'}  {name}")

    # bytes / str round-trips across all three key families.
    blob = os.urandom(200)
    _check("v1 bytes round-trip", decrypt_bytes(encrypt_bytes(blob, "personal", mk), mk) == blob)
    _check("v1 str round-trip", decrypt_str(encrypt_str("héllo 🌱", "personal", mk), mk) == "héllo 🌱")
    _check("v2 (per-user) round-trip",
           decrypt_str(encrypt_str("user-scoped", "personal", mk, user_id="u-42"), mk) == "user-scoped")
    _check("v3 (system-key) round-trip",
           decrypt_str(encrypt_str("infra-secret", "secrets", mk, system_key=sk), mk, system_key=sk) == "infra-secret")
    _check("is_encrypted(envelope) is True", is_encrypted(encrypt_str("x", "personal", mk)))
    _check("is_encrypted(plaintext) is False", not is_encrypted("just a plain string"))
    _check("decrypt_safe(garbage) → None", decrypt_safe("not-an-envelope", mk) is None)

    # Vector round-trip (numpy + list + bytes inputs).
    try:
        import numpy as _np
        v = (_np.arange(256, dtype=_np.float32) * 0.013) - 1.5
        env = encrypt_vector(v, "personal", mk)
        out = decrypt_vector(env, mk, dim=256)
        _check("vector round-trip (numpy, ≤1e-6)", bool(_np.max(_np.abs(out - v)) <= 1e-6))
        _check("vector round-trip (list input)",
               bool(_np.max(_np.abs(decrypt_vector(encrypt_vector(v.tolist(), "personal", mk), mk, dim=256) - v)) <= 1e-6))
        raw = v.tobytes()
        _check("vector round-trip (bytes input)",
               bool(_np.max(_np.abs(decrypt_vector(encrypt_vector(raw, "personal", mk), mk, dim=256) - v)) <= 1e-6))
    except ImportError:
        print("SKIP  vector round-trips (numpy not installed)")

    print("=" * 56)
    print(f"VERDICT: {'GO — crypto_local read+write round-trips clean' if ok else 'NO-GO — see FAIL rows'}")
    sys.exit(0 if ok else 1)
