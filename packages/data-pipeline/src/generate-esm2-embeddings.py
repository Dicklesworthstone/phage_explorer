#!/usr/bin/env python3
import argparse
import hashlib
import json
from pathlib import Path
import sqlite3
import struct
import time
from datetime import datetime, timezone

import torch
from transformers import AutoModel, AutoTokenizer


def reference_embeddings(input_path: str, output_path: str, checkpoint: str, revision: str):
    """Explicit offline-file input mode; never opens or writes a catalog database."""
    from huggingface_hub import hf_hub_download
    import transformers

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


def reverse_complement(sequence: str) -> str:
    return sequence.translate(str.maketrans("ACGTNacgtn", "TGCANtgcan"))[::-1]


def translate(sequence: str) -> str:
    table = {
        "TTT":"F","TTC":"F","TTA":"L","TTG":"L","CTT":"L","CTC":"L","CTA":"L","CTG":"L",
        "ATT":"I","ATC":"I","ATA":"I","ATG":"M","GTT":"V","GTC":"V","GTA":"V","GTG":"V",
        "TCT":"S","TCC":"S","TCA":"S","TCG":"S","CCT":"P","CCC":"P","CCA":"P","CCG":"P",
        "ACT":"T","ACC":"T","ACA":"T","ACG":"T","GCT":"A","GCC":"A","GCA":"A","GCG":"A",
        "TAT":"Y","TAC":"Y","TAA":"*","TAG":"*","CAT":"H","CAC":"H","CAA":"Q","CAG":"Q",
        "AAT":"N","AAC":"N","AAA":"K","AAG":"K","GAT":"D","GAC":"D","GAA":"E","GAG":"E",
        "TGT":"C","TGC":"C","TGA":"*","TGG":"W","CGT":"R","CGC":"R","CGA":"R","CGG":"R",
        "AGT":"S","AGC":"S","AGA":"R","AGG":"R","GGT":"G","GGC":"G","GGA":"G","GGG":"G",
    }
    sequence = sequence.upper()
    return "".join(table.get(sequence[i:i + 3], "X") for i in range(0, len(sequence) - 2, 3)).rstrip("*")


def load_proteins(connection: sqlite3.Connection):
    genomes = {
        row[0]: "".join(chunk[0] for chunk in connection.execute(
            "SELECT sequence FROM sequences WHERE phage_id = ? ORDER BY chunk_index", (row[0],)
        ))
        for row in connection.execute("SELECT id FROM phages")
    }
    proteins = []
    for gene_id, phage_id, start, end, strand, locus_tag in connection.execute(
        "SELECT id, phage_id, start_pos, end_pos, strand, locus_tag FROM genes WHERE type = 'CDS' ORDER BY id"
    ):
        dna = genomes[phage_id][start:end]
        if strand == "-":
            dna = reverse_complement(dna)
        amino_acids = translate(dna).replace("*", "X")
        if amino_acids:
            proteins.append((gene_id, phage_id, locus_tag, amino_acids))
    return proteins


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

    connection = sqlite3.connect(args.database)
    proteins = load_proteins(connection)
    if args.limit:
        proteins = proteins[:args.limit]

    tokenizer = AutoTokenizer.from_pretrained(args.model)
    model = AutoModel.from_pretrained(args.model)
    model.eval()
    device = torch.device("cuda" if torch.cuda.is_available() else "cpu")
    model.to(device)
    now = int(time.time() * 1000)
    inserted = 0

    with torch.inference_mode():
        for offset in range(0, len(proteins), args.batch_size):
            batch = proteins[offset:offset + args.batch_size]
            sequences = [item[3][:1022] for item in batch]
            inputs = tokenizer(sequences, return_tensors="pt", padding=True, truncation=True, max_length=1024)
            inputs = {key: value.to(device) for key, value in inputs.items()}
            hidden = model(**inputs).last_hidden_state
            masks = inputs["attention_mask"].unsqueeze(-1)
            pooled = (hidden * masks).sum(dim=1) / masks.sum(dim=1).clamp(min=1)
            pooled = torch.nn.functional.normalize(pooled, dim=1).cpu().float()

            rows = []
            for (gene_id, phage_id, locus_tag, sequence), vector in zip(batch, pooled):
                metadata = json.dumps({
                    "source": "esm2",
                    "checkpoint": args.model,
                    "pooling": "mean",
                    "normalized": True,
                    "sequenceLength": len(sequence),
                    "truncated": len(sequence) > 1022,
                }, separators=(",", ":"))
                blob = struct.pack(f"<{vector.numel()}f", *vector.tolist())
                rows.append((phage_id, gene_id, args.model, vector.numel(), blob, metadata, now))

            connection.executemany(
                "INSERT INTO fold_embeddings (phage_id, gene_id, model, dims, vector, meta, created_at) "
                "VALUES (?, ?, ?, ?, ?, ?, ?) ON CONFLICT(gene_id, model) DO UPDATE SET "
                "dims=excluded.dims, vector=excluded.vector, meta=excluded.meta, created_at=excluded.created_at",
                rows,
            )
            connection.commit()
            inserted += len(rows)
            print(f"Embedded {inserted}/{len(proteins)} proteins", flush=True)

    connection.execute(
        "INSERT OR REPLACE INTO annotation_meta (key, value, updated_at) VALUES (?, ?, ?)",
        ("esm2_embeddings", json.dumps({"model": args.model, "count": inserted}), now),
    )
    connection.commit()
    connection.close()


if __name__ == "__main__":
    main()
