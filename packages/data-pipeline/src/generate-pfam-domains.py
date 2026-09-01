#!/usr/bin/env python3
import argparse
import gzip
import json
import shutil
import sqlite3
import time
import urllib.request
from pathlib import Path

import pyhmmer


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
    metadata = {}
    for gene_id, phage_id, start, end, strand, locus_tag in connection.execute(
        "SELECT id, phage_id, start_pos, end_pos, strand, locus_tag FROM genes WHERE type = 'CDS' ORDER BY id"
    ):
        dna = genomes[phage_id][start:end]
        if strand == "-":
            dna = reverse_complement(dna)
        amino_acids = translate(dna).replace("*", "X")
        if not amino_acids:
            continue
        name = str(gene_id).encode()
        proteins.append(pyhmmer.easel.TextSequence(name=name, sequence=amino_acids).digitize(pyhmmer.easel.Alphabet.amino()))
        metadata[gene_id] = (phage_id, locus_tag)
    return proteins, metadata


def decode(value):
    return value.decode() if value else None


def ensure_pfam(path: Path):
    if path.exists():
        return
    path.parent.mkdir(parents=True, exist_ok=True)
    archive = path.with_suffix(path.suffix + ".gz")
    if not archive.exists():
        urllib.request.urlretrieve(
            "https://ftp.ebi.ac.uk/pub/databases/Pfam/current_release/Pfam-A.hmm.gz",
            archive,
        )
    with gzip.open(archive, "rb") as source, path.open("wb") as target:
        shutil.copyfileobj(source, target)


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("--database", default="phage.db")
    parser.add_argument("--pfam", default="~/.cache/phage-explorer/pfam/Pfam-A.hmm")
    parser.add_argument("--cpus", type=int, default=4)
    parser.add_argument("--e-value", type=float, default=1e-5)
    parser.add_argument("--limit", type=int)
    args = parser.parse_args()

    pfam_path = Path(args.pfam).expanduser()
    ensure_pfam(pfam_path)
    connection = sqlite3.connect(args.database)
    proteins, metadata = load_proteins(connection)
    if args.limit:
        proteins = proteins[:args.limit]
    connection.execute("DELETE FROM protein_domains WHERE domain_type = 'Pfam'")
    connection.commit()

    rows = []
    now = int(time.time() * 1000)
    with pyhmmer.plan7.HMMFile(pfam_path) as hmm_file:
        for index, hits in enumerate(pyhmmer.hmmer.hmmscan(proteins, hmm_file, cpus=args.cpus, E=args.e_value), 1):
            gene_id = int(hits.query.name.decode())
            phage_id, locus_tag = metadata[gene_id]
            for hit in hits.included:
                accession = decode(hit.accession) or decode(hit.name) or "unknown"
                domain_id = accession.split(".")[0]
                for domain in hit.domains.included:
                    alignment = domain.alignment
                    rows.append((
                        phage_id,
                        gene_id,
                        locus_tag,
                        domain_id,
                        decode(hit.name),
                        "Pfam",
                        alignment.target_from,
                        alignment.target_to,
                        domain.score,
                        domain.i_evalue,
                        decode(hit.description),
                    ))
            if index % 25 == 0 or index == len(proteins):
                if rows:
                    connection.executemany(
                        "INSERT INTO protein_domains (phage_id, gene_id, locus_tag, domain_id, domain_name, domain_type, start, end, score, e_value, description) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)",
                        rows,
                    )
                    connection.commit()
                    rows.clear()
                print(f"Scanned {index}/{len(proteins)} proteins", flush=True)

    count = connection.execute("SELECT COUNT(*) FROM protein_domains WHERE domain_type = 'Pfam'").fetchone()[0]
    connection.execute(
        "INSERT OR REPLACE INTO annotation_meta (key, value, updated_at) VALUES (?, ?, ?)",
        ("pfam_domains", json.dumps({"release": "current", "hits": count, "eValue": args.e_value}), now),
    )
    connection.commit()
    connection.close()


if __name__ == "__main__":
    main()
