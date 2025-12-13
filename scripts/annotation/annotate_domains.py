#!/usr/bin/env python3
"""
Protein Domain Annotation via InterProScan REST API

Submits phage protein sequences to EBI's InterProScan service
and stores domain annotations in SQLite.

Usage:
    python annotate_domains.py --db phage.db [--force]
"""

import argparse
import json
import sqlite3
import time
from pathlib import Path
from typing import Iterator

import requests
from tqdm import tqdm

# InterProScan REST API endpoints
INTERPRO_SUBMIT = "https://www.ebi.ac.uk/Tools/services/rest/iprscan5/run"
INTERPRO_STATUS = "https://www.ebi.ac.uk/Tools/services/rest/iprscan5/status/{job_id}"
INTERPRO_RESULT = "https://www.ebi.ac.uk/Tools/services/rest/iprscan5/result/{job_id}/json"

# Rate limiting
REQUEST_DELAY = 1.0  # seconds between API calls
MAX_RETRIES = 3
POLL_INTERVAL = 30  # seconds between status checks


def translate_sequence(seq: str, frame: int = 0) -> str:
    """Translate DNA to protein sequence."""
    codon_table = {
        'TTT': 'F', 'TTC': 'F', 'TTA': 'L', 'TTG': 'L',
        'TCT': 'S', 'TCC': 'S', 'TCA': 'S', 'TCG': 'S',
        'TAT': 'Y', 'TAC': 'Y', 'TAA': '*', 'TAG': '*',
        'TGT': 'C', 'TGC': 'C', 'TGA': '*', 'TGG': 'W',
        'CTT': 'L', 'CTC': 'L', 'CTA': 'L', 'CTG': 'L',
        'CCT': 'P', 'CCC': 'P', 'CCA': 'P', 'CCG': 'P',
        'CAT': 'H', 'CAC': 'H', 'CAA': 'Q', 'CAG': 'Q',
        'CGT': 'R', 'CGC': 'R', 'CGA': 'R', 'CGG': 'R',
        'ATT': 'I', 'ATC': 'I', 'ATA': 'I', 'ATG': 'M',
        'ACT': 'T', 'ACC': 'T', 'ACA': 'T', 'ACG': 'T',
        'AAT': 'N', 'AAC': 'N', 'AAA': 'K', 'AAG': 'K',
        'AGT': 'S', 'AGC': 'S', 'AGA': 'R', 'AGG': 'R',
        'GTT': 'V', 'GTC': 'V', 'GTA': 'V', 'GTG': 'V',
        'GCT': 'A', 'GCC': 'A', 'GCA': 'A', 'GCG': 'A',
        'GAT': 'D', 'GAC': 'D', 'GAA': 'E', 'GAG': 'E',
        'GGT': 'G', 'GGC': 'G', 'GGA': 'G', 'GGG': 'G',
    }

    protein = []
    seq = seq.upper()[frame:]
    for i in range(0, len(seq) - 2, 3):
        codon = seq[i:i+3]
        aa = codon_table.get(codon, 'X')
        if aa == '*':
            break
        protein.append(aa)
    return ''.join(protein)


def get_gene_proteins(db_path: str) -> Iterator[dict]:
    """Extract CDS genes and their protein sequences from the database."""
    conn = sqlite3.connect(db_path)
    conn.row_factory = sqlite3.Row

    # Get all CDS genes with their sequences
    query = """
        SELECT
            g.id as gene_id,
            g.phage_id,
            g.locus_tag,
            g.name,
            g.start_pos,
            g.end_pos,
            g.strand,
            g.product,
            p.accession as phage_accession,
            p.name as phage_name
        FROM genes g
        JOIN phages p ON g.phage_id = p.id
        WHERE g.type = 'CDS'
        ORDER BY g.phage_id, g.start_pos
    """

    cursor = conn.execute(query)

    # We need to reconstruct sequences from chunks
    seq_cache = {}

    for row in cursor:
        phage_id = row['phage_id']

        # Get full sequence if not cached
        if phage_id not in seq_cache:
            seq_query = "SELECT sequence FROM sequences WHERE phage_id = ? ORDER BY chunk_index"
            chunks = conn.execute(seq_query, (phage_id,)).fetchall()
            seq_cache[phage_id] = ''.join(c['sequence'] for c in chunks)

        full_seq = seq_cache[phage_id]

        # Extract gene DNA sequence
        start = row['start_pos'] - 1  # 1-based to 0-based
        end = row['end_pos']
        gene_seq = full_seq[start:end]

        # Handle reverse strand
        if row['strand'] == '-':
            complement = {'A': 'T', 'T': 'A', 'C': 'G', 'G': 'C'}
            gene_seq = ''.join(complement.get(c, 'N') for c in reversed(gene_seq))

        # Translate to protein
        protein_seq = translate_sequence(gene_seq)

        if len(protein_seq) >= 30:  # Minimum length for InterProScan
            yield {
                'gene_id': row['gene_id'],
                'phage_id': phage_id,
                'locus_tag': row['locus_tag'] or f"gene_{row['gene_id']}",
                'product': row['product'],
                'protein_seq': protein_seq,
                'phage_name': row['phage_name'],
            }

    conn.close()


def submit_interpro_job(sequence: str, email: str = "phage-explorer@example.com") -> str:
    """Submit a sequence to InterProScan and return job ID."""
    data = {
        'email': email,
        'sequence': sequence,
        'goterms': 'false',
        'pathways': 'false',
    }

    for attempt in range(MAX_RETRIES):
        try:
            resp = requests.post(INTERPRO_SUBMIT, data=data, timeout=60)
            resp.raise_for_status()
            return resp.text.strip()
        except requests.RequestException as e:
            if attempt < MAX_RETRIES - 1:
                time.sleep(REQUEST_DELAY * (attempt + 1))
            else:
                raise RuntimeError(f"Failed to submit job: {e}")

    return ""


def check_job_status(job_id: str) -> str:
    """Check InterProScan job status."""
    url = INTERPRO_STATUS.format(job_id=job_id)
    resp = requests.get(url, timeout=30)
    resp.raise_for_status()
    return resp.text.strip()


def get_job_result(job_id: str) -> dict:
    """Get InterProScan results as JSON."""
    url = INTERPRO_RESULT.format(job_id=job_id)
    resp = requests.get(url, timeout=60)
    resp.raise_for_status()
    return resp.json()


def parse_interpro_result(result: dict) -> list[dict]:
    """Parse InterProScan JSON result into domain records."""
    domains = []

    for seq_result in result.get('results', []):
        for match in seq_result.get('matches', []):
            signature = match.get('signature', {})
            entry = signature.get('entry', {})

            for location in match.get('locations', []):
                domain = {
                    'domain_id': signature.get('accession', ''),
                    'domain_name': signature.get('name', ''),
                    'domain_type': signature.get('signatureLibraryRelease', {}).get('library', ''),
                    'start': location.get('start', 0),
                    'end': location.get('end', 0),
                    'score': location.get('score', 0.0),
                    'e_value': location.get('evalue', 1.0),
                    'description': entry.get('description', signature.get('description', '')),
                }

                # Add InterPro entry if available
                if entry:
                    domain['interpro_id'] = entry.get('accession', '')
                    domain['interpro_name'] = entry.get('name', '')

                domains.append(domain)

    return domains


def ensure_tables(db_path: str):
    """Ensure annotation tables exist in the database."""
    conn = sqlite3.connect(db_path)

    conn.execute("""
        CREATE TABLE IF NOT EXISTS protein_domains (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            phage_id INTEGER NOT NULL,
            gene_id INTEGER,
            locus_tag TEXT,
            domain_id TEXT NOT NULL,
            domain_name TEXT,
            domain_type TEXT,
            start INTEGER,
            end INTEGER,
            score REAL,
            e_value REAL,
            description TEXT
        )
    """)

    conn.execute("CREATE INDEX IF NOT EXISTS idx_domains_phage ON protein_domains(phage_id)")
    conn.execute("CREATE INDEX IF NOT EXISTS idx_domains_gene ON protein_domains(gene_id)")
    conn.execute("CREATE INDEX IF NOT EXISTS idx_domains_domain ON protein_domains(domain_id)")

    conn.execute("""
        CREATE TABLE IF NOT EXISTS annotation_meta (
            key TEXT PRIMARY KEY,
            value TEXT NOT NULL,
            updated_at INTEGER
        )
    """)

    conn.commit()
    conn.close()


def insert_domains(db_path: str, gene_id: int, phage_id: int, locus_tag: str, domains: list[dict]):
    """Insert domain annotations into the database."""
    conn = sqlite3.connect(db_path)

    for domain in domains:
        conn.execute("""
            INSERT INTO protein_domains
            (phage_id, gene_id, locus_tag, domain_id, domain_name, domain_type,
             start, end, score, e_value, description)
            VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
        """, (
            phage_id,
            gene_id,
            locus_tag,
            domain['domain_id'],
            domain['domain_name'],
            domain['domain_type'],
            domain['start'],
            domain['end'],
            domain['score'],
            domain['e_value'],
            domain['description'],
        ))

    conn.commit()
    conn.close()


def main():
    parser = argparse.ArgumentParser(description="Annotate protein domains via InterProScan")
    parser.add_argument("--db", required=True, help="Path to phage.db")
    parser.add_argument("--force", action="store_true", help="Re-annotate existing genes")
    parser.add_argument("--limit", type=int, help="Limit number of genes to process")
    parser.add_argument("--email", default="phage-explorer@example.com", help="Email for InterProScan")
    args = parser.parse_args()

    db_path = Path(args.db)
    if not db_path.exists():
        print(f"Error: Database not found: {db_path}")
        return 1

    ensure_tables(str(db_path))

    # Get genes to annotate
    genes = list(get_gene_proteins(str(db_path)))

    if args.limit:
        genes = genes[:args.limit]

    print(f"Found {len(genes)} CDS genes to annotate")

    # Check which genes already have annotations
    if not args.force:
        conn = sqlite3.connect(str(db_path))
        annotated = set(
            row[0] for row in
            conn.execute("SELECT DISTINCT gene_id FROM protein_domains WHERE gene_id IS NOT NULL")
        )
        conn.close()

        genes = [g for g in genes if g['gene_id'] not in annotated]
        print(f"Skipping already annotated genes, {len(genes)} remaining")

    if not genes:
        print("No genes to annotate")
        return 0

    # Process genes
    jobs = {}  # job_id -> gene info

    for gene in tqdm(genes, desc="Submitting jobs"):
        try:
            job_id = submit_interpro_job(gene['protein_seq'], args.email)
            jobs[job_id] = gene
            time.sleep(REQUEST_DELAY)
        except Exception as e:
            print(f"Error submitting {gene['locus_tag']}: {e}")

    print(f"Submitted {len(jobs)} jobs, waiting for results...")

    # Poll for results
    completed = 0
    failed = 0

    while jobs:
        time.sleep(POLL_INTERVAL)

        finished_jobs = []

        for job_id, gene in jobs.items():
            try:
                status = check_job_status(job_id)

                if status == 'FINISHED':
                    result = get_job_result(job_id)
                    domains = parse_interpro_result(result)

                    insert_domains(
                        str(db_path),
                        gene['gene_id'],
                        gene['phage_id'],
                        gene['locus_tag'],
                        domains
                    )

                    completed += 1
                    finished_jobs.append(job_id)
                    print(f"✓ {gene['locus_tag']}: {len(domains)} domains")

                elif status in ('FAILURE', 'ERROR', 'NOT_FOUND'):
                    failed += 1
                    finished_jobs.append(job_id)
                    print(f"✗ {gene['locus_tag']}: {status}")

            except Exception as e:
                print(f"Error checking {job_id}: {e}")

        for job_id in finished_jobs:
            del jobs[job_id]

        if jobs:
            print(f"Waiting for {len(jobs)} jobs... (completed: {completed}, failed: {failed})")

    # Update metadata
    conn = sqlite3.connect(str(db_path))
    conn.execute("""
        INSERT OR REPLACE INTO annotation_meta (key, value, updated_at)
        VALUES ('domains_last_updated', ?, ?)
    """, (f"InterProScan, {completed} genes", int(time.time())))
    conn.commit()
    conn.close()

    print(f"\nDone! Annotated {completed} genes, {failed} failed")
    return 0


if __name__ == "__main__":
    exit(main())
