"""stage_crypto.py — caller-encrypt helpers shared by the compute-only families.

The four compute-only measurement families (H1 §4.24, criticality, coherence,
behavioral-temporal) all write SENSITIVE metric values to wide tables that are
NOT in the JS adapter's ENCRYPTED_FIELDS (which only drives the JS write path).
They write via d1_client (raw SQLite), so they MUST caller-encrypt the sensitive
columns themselves — exactly the pattern compute-fisher.py uses (_enc/_dec).

The JS read path (autoDecryptResults) auto-decrypts ANY encrypted-looking string
column not in NEVER_AUTO_DECRYPT, so these envelopes round-trip back to numbers
through db.rawQuery without ENCRYPTED_FIELDS entries.

Security:
  - scope is always 'personal' (single-user vault).
  - numpy gotcha: ``repr(np.float64(x))`` is the string ``'np.float64(x)'``, NOT
    ``'x'`` — so we serialize ``repr(float(value))`` which both JS Number() and
    Python float() round-trip cleanly. (Same fix as compute-fisher.py:_enc.)
  - NEVER pass plaintext content/vectors here — only derived numeric scalars and
    server-rendered headlines / structural JSON.
"""

from __future__ import annotations

from typing import Optional

_SCOPE = 'personal'
_MASTER_KEY: Optional[bytes] = None


def _master_key() -> bytes:
    """Lazy-load + cache the user master key (fail-closed: raises if absent)."""
    global _MASTER_KEY
    if _MASTER_KEY is None:
        from crypto_local import load_master_key
        _MASTER_KEY = load_master_key()
    return _MASTER_KEY


def enc(value):
    """SERIALIZE-ONLY (SQLCipher collapse, Stage B/C cut 5). Was field-encrypt; now
    returns the COERCED PLAINTEXT STRING — at-rest confidentiality is whole-file
    SQLCipher (verify:at-rest), not a per-field envelope. The coercion is LOAD-BEARING:
    numbers → repr(float(x)) because numpy 2.x repr(np.float64(x)) is 'np.float64(x)'
    and would poison the stored value; booleans → '1.0'/'0.0' (read path Number()s);
    strings pass through verbatim; None → None. dec() still dual-reads any legacy
    envelopes until the live backfill converts them.
    """
    if value is None:
        return None
    if isinstance(value, bool):
        return repr(1.0 if value else 0.0)
    if isinstance(value, str):
        return value
    try:
        return repr(float(value))
    except (TypeError, ValueError):
        return str(value)


def dec(value):
    """Decrypt an envelope → plaintext str; pass through non-envelopes. None → None."""
    if value is None or not isinstance(value, str):
        return value
    from crypto_local import is_encrypted, decrypt_safe
    if is_encrypted(value):
        return decrypt_safe(value, _master_key())
    return value


def dec_float(value):
    """Decrypt + coerce to float; None / unparseable → None."""
    d = dec(value)
    if d is None:
        return None
    try:
        return float(d)
    except (TypeError, ValueError):
        return None
