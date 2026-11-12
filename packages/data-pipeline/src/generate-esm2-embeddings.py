#!/usr/bin/env python3
import argparse
import hashlib
import json
import math
from pathlib import Path
import sqlite3
import struct
import time
from datetime import datetime, timezone

from contextlib import closing

from protein_inputs import annotation_transaction, load_protein_inputs, protein_input_metadata


def reference_embeddings(input_path: str, output_path: str, checkpoint: str, revision: str):
    """Explicit offline-file input mode; never opens or writes a catalog database."""
    from huggingface_hub import hf_hub_download
    import torch
    import transformers
    from transformers import AutoModel, AutoTokenizer

    if len(revision) != 40 or any(char not in "0123456789abcdef" for char in revision):
        raise ValueError("Reference mode requires an immutable checkpoint revision")
    destination = Path(output_path)
    if destination.exists():
        raise ValueError("Reference output must not already exist")
    rows = json.loads(Path(input_path).read_text(encoding="utf-8"))
    if not isinstance(rows, list) or not 2 <= len(rows) <= 8:
        raise ValueError("Reference input requires two through eight explicit proteins")
    seen = set()
    for row in rows:
        if not isinstance(row, dict):
            raise ValueError("Each reference protein must be an object")
        sequence = row.get("sequence", "")
        if not isinstance(sequence, str) or not 1 <= len(sequence) <= 1022 or any(
            amino_acid not in "ACDEFGHIKLMNPQRSTVWY" for amino_acid in sequence
        ):
            raise ValueError("Reference sequence must be complete, bounded and unambiguous")
        if not isinstance(row.get("proteinId"), str) or not row["proteinId"] or row["proteinId"] in seen:
            raise ValueError("Reference protein identities must be unique")
        if type(row.get("start")) is not int or type(row.get("end")) is not int or not (
            1 <= row["start"] <= row["end"] <= 10000
        ) or row["end"] - row["start"] + 1 != len(sequence):
            raise ValueError("Reference interval must exactly cover the consumed sequence")
        seen.add(row["proteinId"])

    def sha256(path):
        return hashlib.sha256(Path(path).read_bytes()).hexdigest()

    def canonical_hash(value):
        return hashlib.sha256(json.dumps(value, sort_keys=True, ensure_ascii=False,
            separators=(",", ":")).encode()).hexdigest()

    # Reference generation has a declared CPU/fp32 implementation and no truncation.
    torch.set_num_threads(1)
    paths = {name: hf_hub_download(checkpoint, name, revision=revision,
        cache_dir=str(destination.parent / "esm2-cache"),
        user_agent={"phage_explorer": "protein-reference-builder"}) for name in
        ["model.safetensors", "config.json", "tokenizer_config.json", "vocab.txt"]}
    # Loading is local-only after the explicit, honestly identified source fetches.
    snapshot = str(Path(paths["config.json"]).parent)
    tokenizer = AutoTokenizer.from_pretrained(snapshot, local_files_only=True)
    model = AutoModel.from_pretrained(snapshot, local_files_only=True, add_pooling_layer=False).float().cpu().eval()
    files = {name: sha256(path) for name, path in paths.items()}
    space = {
        "model": checkpoint, "revision": revision,
        "weightsSha256": files["model.safetensors"],
        "configSha256": files["config.json"],
        "tokenizerSha256": canonical_hash({name: files[name] for name in ["tokenizer_config.json", "vocab.txt"]}),
        "dimensions": model.config.hidden_size,
        "implementation": f"transformers-{transformers.__version__}/torch-{torch.__version__}/cpu",
        "precision": "fp32", "pooling": "attention-mean-including-special-tokens-l2",
    }
    if space["dimensions"] != 320:
        raise ValueError("Reference checkpoint must expose the expected 320 hidden features")
    vectors = []
    with torch.inference_mode():
        for row in rows:
            sequence = row["sequence"]
            inputs = tokenizer(sequence, return_tensors="pt", padding=False, truncation=False)
            if inputs["input_ids"].shape != (1, len(sequence) + 2):
                raise ValueError("Tokenizer must retain every residue plus BOS/EOS")
            hidden = model(**inputs).last_hidden_state
            if hidden.shape != (1, len(sequence) + 2, 320):
                raise ValueError("Expected complete hidden features, not masked-token logits")
            masks = inputs["attention_mask"].unsqueeze(-1)
            pooled = (hidden * masks).sum(dim=1) / masks.sum(dim=1)
            pooled = torch.nn.functional.normalize(pooled, dim=1).cpu().float()
            if not torch.isfinite(pooled).all() or abs(float(pooled.norm()) - 1.0) > 0.0001:
                raise ValueError("Invalid normalized model output")
            vectors.append({"proteinId": row["proteinId"], "start": row["start"], "end": row["end"],
                "sequenceSha256": hashlib.sha256(sequence.encode()).hexdigest(),
                "spaceSha256": canonical_hash(space), "vector": pooled[0].tolist()})
            print(f"Embedded reference {row['proteinId']}: {len(sequence)} residues / 320 features", flush=True)
    with destination.open("x", encoding="utf-8") as output:
        json.dump({"space": space, "files": files, "embeddings": vectors,
            "retrievedAt": datetime.now(timezone.utc).isoformat()}, output, indent=2)
        output.write("\n")


def _input_matches(metadata, item, method):
    return isinstance(metadata, dict) and metadata.get("inputMethod") == method and all(
        metadata.get(key) == item[key] for key in
        ["sourceGeneIds", "sequenceSha256", "cdsSha256", "geneticCode", "codonStart"])


def _check_partial_embeddings(connection, expected, rows, metadata, model, method):
    if not rows:
        raise ValueError("A partial embedding update requires at least one selected protein")
    revision = metadata[0].get("revision")
    if not isinstance(revision, str) or len(revision) != 40 or any(c not in "0123456789abcdef" for c in revision):
        raise ValueError("Partial embedding updates require an immutable checkpoint revision; run a full annotation")
    signature = (revision, metadata[0].get("pooling"), metadata[0].get("normalized"), rows[0][3])
    for row, meta in zip(rows, metadata):
        if (meta.get("revision"), meta.get("pooling"), meta.get("normalized"), row[3]) != signature:
            raise ValueError("An embedding run cannot mix model revisions or pooling methods")
    selected = {row[1] for row in rows}
    for gene_id, phage_id, dimensions, value in connection.execute(
        "SELECT gene_id, phage_id, dims, meta FROM fold_embeddings WHERE model = ?", (model,)
    ):
        if gene_id in selected:
            continue
        prior = json.loads(value) if value else {}
        if (gene_id not in expected or phage_id != expected[gene_id]["phageId"]
                or not _input_matches(prior, expected[gene_id], method)
                or (prior.get("revision"), prior.get("pooling"), prior.get("normalized"), dimensions) != signature):
            raise ValueError("Partial embedding update would mix stale inputs or model revisions; run a full annotation")


def publish_embeddings(connection, report, rows, model, now, *, partial=False):
    """Replace vectors only after all inference and source validation succeeds."""
    expected = {item["geneId"]: item for item in report["proteins"]}
    produced = [row[1] for row in rows]
    if len(set(produced)) != len(produced) or any(
        row[1] not in expected or row[0] != expected[row[1]]["phageId"] or row[2] != model
        or type(row[3]) is not int or row[3] < 1 or len(row[4]) != row[3] * 4 for row in rows
    ) or (not partial and set(produced) != set(expected)):
        raise ValueError("Embedding rows must exactly describe the selected validated proteins")
    metadata = [json.loads(row[5]) for row in rows]
    for row, meta in zip(rows, metadata):
        if not _input_matches(meta, expected[row[1]], report["method"]) or not all(
            math.isfinite(value) for value in struct.unpack(f"<{row[3]}f", row[4])
        ):
            raise ValueError("Embedding provenance and finite vector values must match their validated input")
    with annotation_transaction(connection, report):
        if partial:
            _check_partial_embeddings(connection, expected, rows, metadata, model, report["method"])
        else:
            connection.execute("DELETE FROM fold_embeddings WHERE model = ?", (model,))
        connection.executemany(
            "INSERT INTO fold_embeddings (phage_id, gene_id, model, dims, vector, meta, created_at) "
            "VALUES (?, ?, ?, ?, ?, ?, ?) ON CONFLICT(gene_id, model) DO UPDATE SET "
            "phage_id=excluded.phage_id, dims=excluded.dims, vector=excluded.vector, meta=excluded.meta, created_at=excluded.created_at",
            rows,
        )
        # Coordinates of prior vectors cannot represent the newly published set.
        if connection.execute("SELECT 1 FROM sqlite_master WHERE type='table' AND name='fold_embedding_coords'").fetchone():
            connection.execute("DELETE FROM fold_embedding_coords WHERE model = ?", (model,))
        connection.execute(
            "DELETE FROM annotation_meta WHERE key = 'latent_space_atlas' AND "
            "CASE WHEN json_valid(value) THEN json_extract(value, '$.model') END = ?", (model,))

        # This screening metadata is derived specifically from the default model.
        if model == "facebook/esm2_t6_8M_UR50D":
            connection.execute("DELETE FROM annotation_meta WHERE key = 'anti_crispr_esm2'")
            if connection.execute("SELECT 1 FROM sqlite_master WHERE type='table' AND name='defense_systems'").fetchone():
                if partial:
                    connection.executemany("DELETE FROM defense_systems WHERE source = 'esm2-nn' AND gene_id = ?",
                        [(gene_id,) for gene_id in produced])
                else:
                    connection.execute("DELETE FROM defense_systems WHERE source = 'esm2-nn'")
        count = connection.execute("SELECT COUNT(*) FROM fold_embeddings WHERE model = ?", (model,)).fetchone()[0]
        connection.execute(
            "INSERT OR REPLACE INTO annotation_meta (key, value, updated_at) VALUES (?, ?, ?)",
            ("esm2_embeddings", json.dumps({"model": model, "count": count, "updated": len(rows),
                "partial": partial, "updatedGeneIds": produced, "inputScope": "eligible-CDS-set",
                "input": protein_input_metadata(report), "atlasNeedsRebuild": True,
                "screeningNeedsRebuild": model == "facebook/esm2_t6_8M_UR50D"}), now),
        )


def catalog_embeddings(connection, args):
    import torch
    from transformers import AutoModel, AutoTokenizer

    report = load_protein_inputs(connection)
    proteins = report["proteins"][:args.limit] if args.limit is not None else report["proteins"]
    revision = {"revision": args.revision} if args.revision else {}
    tokenizer = AutoTokenizer.from_pretrained(args.model, **revision)
    model = AutoModel.from_pretrained(args.model, **revision)
    model.eval()
    device = torch.device("cuda" if torch.cuda.is_available() else "cpu")
    model.to(device)
    now = int(time.time() * 1000)
    rows = []

    with torch.inference_mode():
        for offset in range(0, len(proteins), args.batch_size):
            batch = proteins[offset:offset + args.batch_size]
            sequences = [item["sequence"][:1022] for item in batch]
            inputs = tokenizer(sequences, return_tensors="pt", padding=True, truncation=True, max_length=1024)
            inputs = {key: value.to(device) for key, value in inputs.items()}
            hidden = model(**inputs).last_hidden_state
            masks = inputs["attention_mask"].unsqueeze(-1)
            pooled = (hidden * masks).sum(dim=1) / masks.sum(dim=1).clamp(min=1)
            pooled = torch.nn.functional.normalize(pooled, dim=1).cpu().float()
            if len(pooled) != len(batch) or not torch.isfinite(pooled).all():
                raise ValueError("The model produced incomplete or non-finite embeddings")
            for item, sequence, vector in zip(batch, sequences, pooled):
                metadata = json.dumps({
                    "source": "esm2", "checkpoint": args.model,
                    "revision": getattr(model.config, "_commit_hash", None),
                    "pooling": "attention-mean-including-special-tokens-l2", "normalized": True,
                    "sequenceLength": len(item["sequence"]), "truncated": len(item["sequence"]) > 1022,
                    "encodedResidues": len(sequence), "encodedSequenceSha256": hashlib.sha256(sequence.encode()).hexdigest(),
                    "inputMethod": report["method"], "sourceGeneIds": item["sourceGeneIds"],
                    "sequenceSha256": item["sequenceSha256"], "cdsSha256": item["cdsSha256"],
                    "geneticCode": item["geneticCode"], "codonStart": item["codonStart"],
                }, separators=(",", ":"))
                blob = struct.pack(f"<{vector.numel()}f", *vector.tolist())
                rows.append((item["phageId"], item["geneId"], args.model, vector.numel(), blob, metadata, now))
            print(f"Embedded {len(rows)}/{len(proteins)} proteins", flush=True)

    publish_embeddings(connection, report, rows, args.model, now, partial=args.limit is not None)


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("--database", default="phage.db")
    parser.add_argument("--model", default="facebook/esm2_t6_8M_UR50D")
    parser.add_argument("--batch-size", type=int, default=8)
    parser.add_argument("--limit", type=int)
    parser.add_argument("--reference-input")
    parser.add_argument("--reference-output")
    parser.add_argument("--revision")
    args = parser.parse_args()

    if args.reference_input or args.reference_output:
        if not (args.reference_input and args.reference_output and args.revision):
            parser.error("Reference mode requires --reference-input, --reference-output and --revision")
        reference_embeddings(args.reference_input, args.reference_output, args.model, args.revision)
        return
    if args.limit is not None and args.limit < 1:
        parser.error("--limit must be positive")
    if args.batch_size < 1:
        parser.error("--batch-size must be positive")
    # Refuse an absent catalog instead of silently creating an empty database.
    uri = Path(args.database).resolve().as_uri() + "?mode=rw"
    with closing(sqlite3.connect(uri, uri=True)) as connection:
        catalog_embeddings(connection, args)


if __name__ == "__main__":
    main()
