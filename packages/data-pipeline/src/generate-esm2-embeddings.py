#!/usr/bin/env python3
import argparse
import json
import sqlite3
import struct
import time

import torch
from transformers import AutoModel, AutoTokenizer


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
    args = parser.parse_args()

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
