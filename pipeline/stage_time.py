"""stage_time.py — the SINGLE timestamp authority for pipeline stages.

The Python twin of src/ingest/timestamp.js's normalizeTimestamp. Historically
each stage hand-rolled its own `created_at` parse (strip " UTC", swap "Z", …) with
`datetime.fromisoformat`. That is fragile in two ways that hurt customers:

  1. It does NOT accept epoch seconds/milliseconds (numeric strings like
     "1756452240000"), which some import sources store — `fromisoformat` throws
     "month must be in 1..12", the row is silently dropped, and if a whole vault is
     in that format the stage writes NOTHING and the surface reads "no data".
  2. Ten stages each reimplement it, so a format the parser misses breaks them all
     identically, with no single place to fix.

`parse_utc` accepts everything normalizeTimestamp does — Date-ish, epoch s/ms
(numeric or numeric-string, magnitude split at 1e12), ISO-8601 with Z / offset /
milliseconds, naive "YYYY-MM-DD[ T]HH:MM[:SS[.fff]]" (read as UTC, never host-local),
date-only, and a trailing " UTC" suffix — and returns a timezone-aware UTC
datetime, or None for absent/unparseable input. Content-free: no values are logged.

`parse_rate_ok` is the fail-loud companion: a stage that has input rows but parses
almost none of them should surface that as a countable fact, not silently emit an
empty result.
"""

from datetime import datetime, timezone

_EPOCH_MS_CUTOFF = 1e12  # < this ⇒ seconds, ≥ ⇒ milliseconds (matches timestamp.js)


def _from_epoch(n: float) -> datetime:
    secs = n / 1000.0 if n >= _EPOCH_MS_CUTOFF else float(n)
    return datetime.fromtimestamp(secs, tz=timezone.utc)


def parse_utc(value):
    """Normalise a heterogeneous timestamp to an aware UTC datetime, or None.

    Accepts datetime | int/float epoch (s or ms) | numeric string | ISO-8601
    (Z / offset / millis) | naive datetime (read as UTC) | date-only | "… UTC".
    """
    if value is None:
        return None
    # datetime passthrough (normalise to UTC-aware)
    if isinstance(value, datetime):
        return value if value.tzinfo else value.replace(tzinfo=timezone.utc)
    # numeric epoch (int/float)
    if isinstance(value, (int, float)):
        try:
            return _from_epoch(float(value))
        except (ValueError, OSError, OverflowError):
            return None
    if not isinstance(value, str):
        return None
    s = value.strip()
    if not s:
        return None
    # numeric-string epoch (seconds or ms) — the case the hand-rolled parsers miss
    try:
        if s.lstrip('+-').replace('.', '', 1).isdigit():
            return _from_epoch(float(s))
    except (ValueError, OSError, OverflowError):
        return None
    # string date/datetime forms
    iso = s
    if iso.endswith(' UTC') or iso.endswith(' utc'):
        iso = iso[:-4].strip()
    elif iso.endswith('UTC') or iso.endswith('utc'):
        iso = iso[:-3].strip()
    # naive "YYYY-MM-DD HH:MM:SS" → ISO 'T'
    if 'T' not in iso and ' ' in iso:
        iso = iso.replace(' ', 'T', 1)
    if iso.endswith('Z') or iso.endswith('z'):
        iso = iso[:-1] + '+00:00'
    try:
        dt = datetime.fromisoformat(iso)
    except ValueError:
        return None
    return dt if dt.tzinfo else dt.replace(tzinfo=timezone.utc)


def parse_rate_ok(parsed: int, total: int, min_rate: float = 0.5) -> bool:
    """True when a healthy fraction of non-null timestamps parsed. A stage with
    input but a low parse rate should FAIL LOUD (surface a format problem) rather
    than silently write an empty result."""
    if total <= 0:
        return True
    return (parsed / total) >= min_rate


if __name__ == '__main__':  # runnable gate: asserts the format matrix (exit 1 on regress)
    ok = '2025-08-29T07:24:00+00:00'
    for c in ['2025-08-29T07:24:00.000Z', '2025-08-29T07:24:00Z', '2025-08-29 07:24:00',
              '2025-08-29T07:24:00+00:00', '1756452240000', '1756452240', 1756452240000, 1756452240]:
        got = parse_utc(c)
        assert got is not None and got.isoformat() == ok, f"{c!r} -> {got}"
    assert parse_utc('2018-06-26 21:33:13 UTC').isoformat() == '2018-06-26T21:33:13+00:00'
    assert parse_utc('2025-08-29').isoformat() == '2025-08-29T00:00:00+00:00'
    assert parse_utc(1756452240.5).microsecond == 500000
    for bad in [None, '', 'not-a-date', {}, []]:
        assert parse_utc(bad) is None, f"{bad!r} should be None"
    # parse_rate_ok gate
    assert parse_rate_ok(0, 0) and parse_rate_ok(60, 100) and not parse_rate_ok(10, 100)
    print('stage_time: all format + rate assertions passed')
