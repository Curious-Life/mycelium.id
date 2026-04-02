#!/usr/bin/env python3
"""
Link contacts to mindscape territories via Nomic 256D embedding similarity.

Only processes contacts that have real message data (LinkedIn messages
where the user replied, or Mycelium message mentions).

Usage:
  python scripts/link-contacts.py <linkedin-zip> [--dry-run] [--threshold 0.35]

Requires: ONNX Nomic model (same as cluster.py), D1 access via MYA_WORKER_URL.
"""

import argparse
import csv
import io
import json
import os
import sys
import zipfile
from collections import defaultdict
from pathlib import Path

import httpx
import numpy as np

# ── Config ──────────────────────────────────────────────────────────────

WORKER_URL = os.environ.get("MYA_WORKER_URL", "")
# Use ADMIN_SECRET for full-scope access (people data is personal-scope encrypted)
WORKER_SECRET = os.environ.get("ADMIN_SECRET", os.environ.get("MYA_WORKER_SECRET", ""))
USER_ID = os.environ.get("DEFAULT_USER_ID", os.environ.get("MYA_USER_ID", "owner"))
OWNER_NAME = os.environ.get("OWNER_NAME", "Owner")

NOMIC_MODEL = "nomic-ai/nomic-embed-text-v1.5"
NOMIC_DIM = 256
CACHE_DIR = Path(__file__).parent / "cache"

DEFAULT_THRESHOLD = 0.35
MAX_TERRITORIES_PER_CONTACT = 10
MAX_CONTEXT_CHARS = 2000  # truncate contact text to this


# ── D1 helpers ──────────────────────────────────────────────────────────

def d1_query(sql: str, params: list = None) -> list[dict]:
    r = httpx.post(
        f"{WORKER_URL}/api/db/query",
        json={"sql": sql, "params": params or []},
        headers={"Authorization": f"Bearer {WORKER_SECRET}"},
        timeout=60,
    )
    if not r.is_success:
        print(f"  D1 error {r.status_code}: {r.text[:200]}")
        r.raise_for_status()
    data = r.json()
    return data.get("results", [])


def d1_batch(statements: list[dict]) -> None:
    r = httpx.post(
        f"{WORKER_URL}/api/db/batch",
        json={"statements": statements},
        headers={"Authorization": f"Bearer {WORKER_SECRET}"},
        timeout=60,
    )
    r.raise_for_status()


# ── LinkedIn ZIP parsing ────────────────────────────────────────────────

def parse_linkedin_messages(zip_path: str) -> dict[str, dict]:
    """
    Parse messages.csv from LinkedIn ZIP.
    Returns: { linkedin_url: { name, messages: [str], last_date } }
    Only includes contacts where the owner sent at least one message.
    """
    with zipfile.ZipFile(zip_path) as zf:
        with zf.open("messages.csv") as f:
            reader = csv.DictReader(io.TextIOWrapper(f, encoding="utf-8"))
            rows = list(reader)

    # Group by conversation
    convos = defaultdict(lambda: {"owner_sent": False, "participants": {}, "messages": [], "last_date": ""})
    for row in rows:
        conv_id = row.get("CONVERSATION ID", "")
        if not conv_id:
            continue
        conv = convos[conv_id]
        sender = row.get("FROM", "")
        content = row.get("CONTENT", "")
        date = row.get("DATE", "")

        if date > conv["last_date"]:
            conv["last_date"] = date

        if sender == OWNER_NAME:
            conv["owner_sent"] = True
            if content:
                conv["messages"].append(content)
        else:
            url = row.get("SENDER PROFILE URL", "")
            if sender and url:
                conv["participants"][url] = sender
            if content:
                conv["messages"].append(content)

    # Aggregate per contact (only convos where owner replied)
    contacts = {}  # linkedin_url → { name, messages, last_date }
    for conv in convos.values():
        if not conv["owner_sent"]:
            continue
        for url, name in conv["participants"].items():
            if url not in contacts:
                contacts[url] = {"name": name, "messages": [], "last_date": ""}
            contacts[url]["messages"].extend(conv["messages"])
            if conv["last_date"] > contacts[url]["last_date"]:
                contacts[url]["last_date"] = conv["last_date"]

    return contacts


# ── Nomic ONNX embedding ───────────────────────────────────────────────

def load_nomic_model():
    """Load Nomic v1.5 ONNX model (same setup as cluster.py)."""
    import onnxruntime as ort
    from transformers import AutoTokenizer

    ONNX_FILE = "onnx/model_quantized.onnx"
    cache = os.environ.get("HF_HOME", str(Path.home() / ".cache" / "huggingface"))
    model_dir = Path(cache) / "hub" / f"models--{NOMIC_MODEL.replace('/', '--')}" / "snapshots"

    if not model_dir.exists():
        print(f"  Downloading {NOMIC_MODEL}...")
        from huggingface_hub import snapshot_download
        snapshot_download(NOMIC_MODEL)

    # Find latest snapshot
    snapshots = sorted(model_dir.iterdir(), key=lambda p: p.stat().st_mtime, reverse=True)
    onnx_path = snapshots[0] / ONNX_FILE

    tokenizer = AutoTokenizer.from_pretrained(NOMIC_MODEL)
    session = ort.InferenceSession(str(onnx_path), providers=["CPUExecutionProvider"])

    return tokenizer, session


def embed_texts(texts: list[str], tokenizer, session, batch_size: int = 32) -> np.ndarray:
    """Embed texts via Nomic ONNX → 256D vectors."""
    all_embeddings = []

    for i in range(0, len(texts), batch_size):
        batch = texts[i:i + batch_size]
        # Nomic requires "search_document: " prefix
        prefixed = [f"search_document: {t}" for t in batch]

        encoded = tokenizer(
            prefixed, padding=True, truncation=True,
            max_length=512, return_tensors="np",
        )

        outputs = session.run(
            None,
            {
                "input_ids": encoded["input_ids"].astype(np.int64),
                "attention_mask": encoded["attention_mask"].astype(np.int64),
                "token_type_ids": np.zeros_like(encoded["input_ids"]),
            },
        )

        # Mean pooling over token embeddings
        token_embeds = outputs[0]  # (batch, seq_len, 768)
        mask = encoded["attention_mask"][..., np.newaxis]
        pooled = (token_embeds * mask).sum(axis=1) / mask.sum(axis=1)

        # Truncate 768 → 256D (Matryoshka)
        truncated = pooled[:, :NOMIC_DIM]

        # L2 normalize
        norms = np.linalg.norm(truncated, axis=1, keepdims=True)
        norms[norms == 0] = 1
        normalized = truncated / norms

        all_embeddings.append(normalized)

    return np.vstack(all_embeddings).astype(np.float32)


# ── Main ────────────────────────────────────────────────────────────────

def main():
    parser = argparse.ArgumentParser(description="Link contacts to territories via Nomic embeddings")
    parser.add_argument("zip_path", help="Path to LinkedIn export ZIP")
    parser.add_argument("--dry-run", action="store_true")
    parser.add_argument("--threshold", type=float, default=DEFAULT_THRESHOLD)
    args = parser.parse_args()

    if not WORKER_URL or not WORKER_SECRET:
        print("Set MYA_WORKER_URL and MYA_WORKER_SECRET")
        sys.exit(1)

    # ── Step 1: Get territory 256D centroids (batched — each row is ~2KB) ──
    print("Loading territory centroids...")
    # Use the primary user_id for territory_profiles (the one with most rows)
    TERR_USER_ID = os.environ.get("MINDSCAPE_OWNER_ID", "")

    count = d1_query(
        "SELECT COUNT(*) as c FROM territory_profiles WHERE centroid_256 IS NOT NULL AND user_id = ?",
        [TERR_USER_ID],
    )[0]["c"]

    if not count:
        print("No 256D centroids found. Run compute-centroids-256d.py first.")
        sys.exit(1)

    terr_ids = []
    terr_centroids = []
    terr_names = {}
    BATCH = 20
    for offset in range(0, count, BATCH):
        rows = d1_query(
            "SELECT territory_id, centroid_256 FROM territory_profiles "
            "WHERE centroid_256 IS NOT NULL AND user_id = ? LIMIT ? OFFSET ?",
            [TERR_USER_ID, BATCH, offset],
        )
        for row in rows:
            tid = row["territory_id"]
            vec = json.loads(row["centroid_256"])
            terr_ids.append(tid)
            terr_centroids.append(vec)
            terr_names[tid] = f"Territory {tid}"

    # Descriptions are nice-to-have for dry-run output — skip if query fails
    try:
        for offset in range(0, count, 50):
            desc_rows = d1_query(
                "SELECT territory_id, substr(description, 1, 60) as desc_short FROM territory_profiles "
                "WHERE centroid_256 IS NOT NULL AND user_id = ? LIMIT 50 OFFSET ?",
                [TERR_USER_ID, offset],
            )
            for row in desc_rows:
                tid = row["territory_id"]
                if tid in terr_names and row.get("desc_short"):
                    terr_names[tid] = row["desc_short"]
    except Exception:
        print("  (descriptions unavailable, using territory IDs)")

    centroids = np.array(terr_centroids, dtype=np.float32)  # (n_terr, 256)
    print(f"  {len(terr_ids)} territories with 256D centroids")

    # ── Step 2: Parse LinkedIn messages ──
    print(f"\nParsing LinkedIn messages from {args.zip_path}...")
    li_contacts = parse_linkedin_messages(args.zip_path)
    print(f"  {len(li_contacts)} contacts with message exchanges")

    # ── Step 3: Match LinkedIn contacts to people table ──
    print("\nMatching to people table...")
    people_rows = d1_query(
        "SELECT id, name, linkedin_url FROM people WHERE user_id = ? AND status != 'noise'",
        [USER_ID],
    )

    # Build lookup by linkedin_url
    url_to_person = {r["linkedin_url"]: r for r in people_rows if r.get("linkedin_url")}
    name_to_person = {r["name"].lower(): r for r in people_rows}

    # Build contact texts: only for people in our DB with messages
    contact_texts = []  # (person_id, text)
    matched = 0
    for url, data in li_contacts.items():
        person = url_to_person.get(url) or name_to_person.get(data["name"].lower())
        if not person:
            continue

        # Build context from messages
        msg_text = " ".join(data["messages"])[:MAX_CONTEXT_CHARS]
        if not msg_text.strip():
            continue

        text = f"{data['name']}. {msg_text}"
        contact_texts.append((person["id"], person["name"], text))
        matched += 1

    print(f"  {matched} contacts matched with message data")

    if not contact_texts:
        print("No contacts with messages found. Nothing to link.")
        return

    # ── Step 4: Embed contact contexts ──
    print(f"\nLoading Nomic model...")
    tokenizer, session = load_nomic_model()

    print(f"Embedding {len(contact_texts)} contacts...")
    texts = [t[2] for t in contact_texts]
    embeddings = embed_texts(texts, tokenizer, session)
    print(f"  Embedded: {embeddings.shape}")

    # ── Step 5: Cosine similarity → link ──
    print(f"\nComputing similarities (threshold={args.threshold})...")
    # embeddings: (n_contacts, 256), centroids: (n_terr, 256)
    # Both are L2-normalized, so dot product = cosine similarity
    similarities = embeddings @ centroids.T  # (n_contacts, n_terr)

    total_links = 0
    statements = []

    for i, (person_id, person_name, _) in enumerate(contact_texts):
        sims = similarities[i]
        # Get top territories above threshold
        above = [(terr_ids[j], float(sims[j])) for j in range(len(terr_ids)) if sims[j] >= args.threshold]
        above.sort(key=lambda x: -x[1])
        above = above[:MAX_TERRITORIES_PER_CONTACT]

        if above:
            if args.dry_run:
                terr_str = ", ".join(f"{terr_names[tid]}({s:.2f})" for tid, s in above[:3])
                print(f"  {person_name}: {len(above)} territories — {terr_str}")
            else:
                for tid, strength in above:
                    statements.append({
                        "sql": """INSERT INTO contact_territories (id, user_id, contact_id, territory_id, strength, mention_count, first_seen, last_seen)
                                  VALUES (lower(hex(randomblob(16))), ?, ?, ?, ?, 1, datetime('now'), datetime('now'))
                                  ON CONFLICT(contact_id, territory_id) DO UPDATE SET
                                    strength = excluded.strength,
                                    last_seen = datetime('now')""",
                        "params": [USER_ID, person_id, tid, round(strength, 4)],
                    })
            total_links += len(above)

    if not args.dry_run and statements:
        print(f"  Writing {len(statements)} links...")
        for i in range(0, len(statements), 50):
            d1_batch(statements[i:i + 50])

    # ── Summary ──
    print(f"\n── Summary ──")
    print(f"Contacts processed: {len(contact_texts)}")
    print(f"Territory links created: {total_links}")
    print(f"Threshold: {args.threshold}")

    if not args.dry_run:
        bridge = d1_query(
            """SELECT p.name, COUNT(DISTINCT ct.territory_id) as territories
               FROM people p JOIN contact_territories ct ON ct.contact_id = p.id
               WHERE ct.user_id = ? GROUP BY p.id HAVING territories >= 3
               ORDER BY territories DESC LIMIT 10""",
            [USER_ID],
        )
        if bridge:
            print(f"\nTop bridge contacts (3+ territories):")
            for b in bridge:
                print(f"  {b['name']}: {b['territories']} territories")


if __name__ == "__main__":
    main()
