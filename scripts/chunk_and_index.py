"""
chunk_and_index.py
------------------
Takes any raw markdown file, cleans it, chunks it semantically,
and indexes it into Moss for real-time semantic search.

Install:
    pip install inferedge-moss

Usage:
    export MOSS_PROJECT_ID="your_project_id"
    export MOSS_PROJECT_KEY="your_project_key"

    python chunk_and_index.py --file your_doc.md --index my-index-name

Optional flags:
    --doc-id        Label in chunk metadata (default: filename stem)
    --model         moss-minilm (fast) or moss-mediumlm (accurate, default)
    --min-words     Merge chunks below this word count (default: 8)
    --max-words     Split chunks above this word count (default: 400)
    --overlap       Sentences to carry over when splitting (default: 2)
    --noise-strings Exact boilerplate lines to strip, e.g. "Footer text"
    --dry-run       Chunk only, save JSON, skip Moss indexing
"""

import re
import os
import sys
import json
import asyncio
import argparse
from pathlib import Path


# ── DEFAULTS ──────────────────────────────────────────────────────────────────
DEFAULT_MIN_WORDS = 8
DEFAULT_MAX_WORDS = 400
DEFAULT_OVERLAP   = 2
DEFAULT_MODEL     = "moss-mediumlm"

NOISE_REGEX = [
    r"^\d+$",              # bare page numbers
    r"^page \d+ of \d+$",  # "Page 3 of 42"
    r"^-{3,}$",            # horizontal rules
    r"^\s*$",              # blank / whitespace only
]


# ── STEP 1: PARSE MARKDOWN INTO SECTIONS ─────────────────────────────────────
def parse_markdown(content: str) -> list:
    content = content.replace("\r\n", "\n").replace("\r", "\n")
    pattern = re.compile(r"^(#{1,4})\s+(.+)$", re.MULTILINE)
    matches = list(pattern.finditer(content))

    sections = []

    if matches:
        preamble = content[: matches[0].start()].strip()
        if preamble:
            sections.append({"heading": "Preamble", "level": 0, "text": preamble})
    else:
        sections.append({"heading": "Document", "level": 0, "text": content.strip()})
        return sections

    for i, match in enumerate(matches):
        heading = match.group(2).strip()
        level   = len(match.group(1))
        start   = match.end()
        end     = matches[i + 1].start() if i + 1 < len(matches) else len(content)
        body    = content[start:end].strip()
        sections.append({"heading": heading, "level": level, "text": body})

    return sections


# ── STEP 2: CLEAN NOISE LINES ─────────────────────────────────────────────────
def make_noise_checker(extra_strings: list):
    exact_lower = {s.strip().lower() for s in (extra_strings or [])}

    def is_noise(line: str) -> bool:
        stripped = line.strip()
        if stripped.lower() in exact_lower:
            return True
        for pattern in NOISE_REGEX:
            if re.match(pattern, stripped, re.IGNORECASE):
                return True
        return False

    return is_noise


def clean_section(section: dict, is_noise) -> dict:
    lines     = section["text"].split("\n")
    cleaned   = [l for l in lines if not is_noise(l)]
    collapsed = re.sub(r"\n{3,}", "\n\n", "\n".join(cleaned)).strip()
    return {**section, "text": collapsed}


# ── STEP 3: MERGE THIN SECTIONS ───────────────────────────────────────────────
def merge_thin_sections(sections: list, min_words: int) -> list:
    merged = []
    for section in sections:
        word_count = len(section["text"].split())
        if merged and word_count < min_words:
            merged[-1]["text"] = merged[-1]["text"] + "\n\n" + section["text"]
        else:
            merged.append(dict(section))
    return merged


# ── STEP 4: SPLIT LONG SECTIONS ───────────────────────────────────────────────
def split_long_section(section: dict, max_words: int, overlap: int) -> list:
    if len(section["text"].split()) <= max_words:
        return [section]

    sentences = re.split(r"(?<=[.!?])\s+", section["text"])
    results, current, part = [], [], 1

    for sent in sentences:
        current.append(sent)
        if len(" ".join(current).split()) >= max_words:
            results.append({**section, "text": " ".join(current), "part": part})
            current = current[-overlap:]
            part   += 1

    if current:
        results.append({**section, "text": " ".join(current), "part": part})

    return results


# ── STEP 5: BUILD MOSS DOCUMENTS ─────────────────────────────────────────────
def build_moss_docs(sections: list, doc_id: str) -> list:
    docs = []
    for i, section in enumerate(sections):
        heading = section.get("heading", "")
        text    = section["text"].strip()
        part    = section.get("part", 1)

        # Prepend heading so each chunk is self-contained
        if heading and not text.lower().startswith(heading.lower()):
            full_text = f"{heading}\n{text}"
        else:
            full_text = text

        chunk_id = f"{doc_id}-chunk-{i+1:04d}"
        if part > 1:
            chunk_id += f"-p{part}"

        docs.append({
            "id":   chunk_id,
            "text": full_text,
            "metadata": {
                "doc_id":  doc_id,
                "section": heading or "General",
                "level":   str(section.get("level", 0)),
                "part":    str(part),
            }
        })

    return docs


# ── STEP 6: INDEX TO MOSS ─────────────────────────────────────────────────────
async def index_to_moss(docs: list, index_name: str, model: str):
    try:
        from moss import MossClient, DocumentInfo  # package: inferedge-moss
    except ImportError:
        print("ERROR: moss not installed. Run: pip install inferedge-moss")
        sys.exit(1)

    project_id  = os.getenv("MOSS_PROJECT_ID")
    project_key = os.getenv("MOSS_PROJECT_KEY")

    if not project_id or not project_key:
        print("ERROR: Set MOSS_PROJECT_ID and MOSS_PROJECT_KEY env vars.")
        sys.exit(1)

    client = MossClient(project_id, project_key)

    moss_docs = [
        DocumentInfo(id=d["id"], text=d["text"], metadata=d["metadata"])
        for d in docs
    ]

    print(f"Creating index '{index_name}' with {len(moss_docs)} chunks ({model})...")
    await client.create_index(index_name, moss_docs, model)

    print("Loading index into memory...")
    await client.load_index(index_name)

    print(f"\nDone. '{index_name}' is live and queryable.")
    print(f"\nQuery example:")
    print(f"  from moss import MossClient, QueryOptions")
    print(f"  client = MossClient(MOSS_PROJECT_ID, MOSS_PROJECT_KEY)")
    print(f"  await client.load_index('{index_name}')")
    print(f"  results = await client.query('{index_name}', 'your question', QueryOptions(top_k=5))")
    print(f"  for doc in results.docs:")
    print(f"      print(doc.score, doc.text, doc.metadata)")


# ── MAIN ─────────────────────────────────────────────────────────────────────
async def main():
    parser = argparse.ArgumentParser(
        description="Chunk a markdown file and index it to Moss."
    )
    parser.add_argument("--file",           required=True,                       help="Path to your markdown file")
    parser.add_argument("--index",          required=True,                       help="Moss index name, e.g. 'my-knowledge-base'")
    parser.add_argument("--doc-id",         default=None,                        help="Doc label in metadata (default: filename stem)")
    parser.add_argument("--model",          default=DEFAULT_MODEL,               help="moss-minilm (fast) or moss-mediumlm (accurate, default)")
    parser.add_argument("--min-words",      type=int, default=DEFAULT_MIN_WORDS, help="Merge chunks below this word count (default: 8)")
    parser.add_argument("--max-words",      type=int, default=DEFAULT_MAX_WORDS, help="Split chunks above this word count (default: 400)")
    parser.add_argument("--overlap",        type=int, default=DEFAULT_OVERLAP,   help="Sentences to carry over on split (default: 2)")
    parser.add_argument("--noise-strings",  nargs="*", default=[],               help="Exact boilerplate lines to strip")
    parser.add_argument("--dry-run",        action="store_true",                 help="Skip Moss indexing, just save chunks to JSON")
    args = parser.parse_args()

    filepath = Path(args.file)
    if not filepath.exists():
        print(f"ERROR: File not found: {filepath}")
        sys.exit(1)

    doc_id   = args.doc_id or filepath.stem
    is_noise = make_noise_checker(args.noise_strings)

    print(f"\n{'='*52}")
    print(f"  File         : {filepath.name}")
    print(f"  Index        : {args.index}")
    print(f"  Doc ID       : {doc_id}")
    print(f"  Model        : {args.model}")
    print(f"  Chunk size   : {args.min_words}–{args.max_words} words")
    if args.noise_strings:
        print(f"  Noise strings: {args.noise_strings}")
    print(f"{'='*52}\n")

    content = filepath.read_text(encoding="utf-8")

    sections = parse_markdown(content)
    print(f"Step 1 — Parsed:          {len(sections)} sections")

    sections = [clean_section(s, is_noise) for s in sections]
    sections = [s for s in sections if s["text"].strip()]
    print(f"Step 2 — After cleaning:  {len(sections)} sections")

    sections = merge_thin_sections(sections, args.min_words)
    print(f"Step 3 — After merging:   {len(sections)} sections")

    final = []
    for s in sections:
        final.extend(split_long_section(s, args.max_words, args.overlap))
    print(f"Step 4 — After splitting: {len(final)} chunks")

    docs = build_moss_docs(final, doc_id)
    print(f"Step 5 — Moss docs built: {len(docs)}\n")

    # Save JSON preview
    try:
        out_path = filepath.with_suffix(".chunks.json")
        out_path.write_text("")
    except OSError:
        out_path = Path("/tmp") / (filepath.stem + ".chunks.json")

    with open(out_path, "w", encoding="utf-8") as f:
        json.dump(docs, f, indent=2, ensure_ascii=False)
    print(f"Chunks saved to : {out_path}")

    sample = docs[min(3, len(docs) - 1)]
    print(f"\nSample chunk:")
    print(json.dumps(sample, indent=2, ensure_ascii=False))

    if args.dry_run:
        print("\n--dry-run: skipping Moss indexing.")
    else:
        print(f"\nStep 6 — Indexing to Moss...")
        await index_to_moss(docs, args.index, args.model)


if __name__ == "__main__":
    asyncio.run(main())
