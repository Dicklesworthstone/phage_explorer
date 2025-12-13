#!/usr/bin/env python3
"""
Host tRNA Pool Data

Contains pre-curated tRNA copy numbers for common bacterial hosts.
Data sourced from GtRNAdb (http://gtrnadb.ucsc.edu/) and literature.

Usage:
    python host_trna_data.py --db phage.db
"""

import argparse
import json
import sqlite3
import time
from pathlib import Path

# tRNA copy numbers for common hosts
# Format: anticodon -> (amino_acid, codon, copy_number)
# Wobble pairing is handled by the codon adaptation calculator

HOST_TRNA_DATA = {
    "Escherichia coli K-12": {
        "tax_id": 83333,
        "trnas": {
            # Alanine (4 codons: GCT, GCC, GCA, GCG)
            "CGC": ("A", "GCG", 5),  # Major
            "GGC": ("A", "GCC", 3),
            "TGC": ("A", "GCA", 4),
            # Arginine (6 codons)
            "ACG": ("R", "CGT", 4),
            "CCG": ("R", "CGG", 1),
            "GCG": ("R", "CGC", 1),
            "TCG": ("R", "CGA", 1),
            "CCT": ("R", "AGG", 1),
            "TCT": ("R", "AGA", 2),
            # Asparagine (2 codons: AAT, AAC)
            "GTT": ("N", "AAC", 4),
            # Aspartate (2 codons: GAT, GAC)
            "GTC": ("D", "GAC", 4),
            # Cysteine (2 codons: TGT, TGC)
            "GCA": ("C", "TGC", 1),
            # Glutamate (2 codons: GAA, GAG)
            "CTC": ("E", "GAG", 4),
            "TTC": ("E", "GAA", 4),
            # Glutamine (2 codons: CAA, CAG)
            "CTG": ("Q", "CAG", 2),
            "TTG": ("Q", "CAA", 2),
            # Glycine (4 codons: GGT, GGC, GGA, GGG)
            "CCC": ("G", "GGG", 1),
            "GCC": ("G", "GGC", 5),
            "TCC": ("G", "GGA", 3),
            # Histidine (2 codons: CAT, CAC)
            "GTG": ("H", "CAC", 2),
            # Isoleucine (3 codons: ATT, ATC, ATA)
            "GAT": ("I", "ATC", 5),
            "TAT": ("I", "ATA", 1),
            # Leucine (6 codons)
            "CAA": ("L", "TTG", 1),
            "CAG": ("L", "CTG", 5),
            "GAG": ("L", "CTC", 1),
            "TAA": ("L", "TTA", 2),
            "TAG": ("L", "CTA", 1),
            # Lysine (2 codons: AAA, AAG)
            "CTT": ("K", "AAG", 3),
            "TTT": ("K", "AAA", 7),
            # Methionine (1 codon: ATG)
            "CAT": ("M", "ATG", 7),  # Includes initiator
            # Phenylalanine (2 codons: TTT, TTC)
            "GAA": ("F", "TTC", 3),
            # Proline (4 codons: CCT, CCC, CCA, CCG)
            "CGG": ("P", "CCG", 1),
            "GGG": ("P", "CCC", 1),
            "TGG": ("P", "CCA", 2),
            # Serine (6 codons)
            "CGA": ("S", "TCG", 1),
            "GCT": ("S", "AGC", 3),
            "GGA": ("S", "TCC", 2),
            "TGA": ("S", "TCA", 2),
            # Threonine (4 codons: ACT, ACC, ACA, ACG)
            "CGT": ("T", "ACG", 1),
            "GGT": ("T", "ACC", 3),
            "TGT": ("T", "ACA", 2),
            # Tryptophan (1 codon: TGG)
            "CCA": ("W", "TGG", 1),
            # Tyrosine (2 codons: TAT, TAC)
            "GTA": ("Y", "TAC", 2),
            # Valine (4 codons: GTT, GTC, GTA, GTG)
            "CAC": ("V", "GTG", 3),
            "GAC": ("V", "GTC", 1),
            "TAC": ("V", "GTA", 3),
        }
    },

    "Pseudomonas aeruginosa PAO1": {
        "tax_id": 208964,
        "trnas": {
            # Simplified - GC-rich host favors different codons
            "CGC": ("A", "GCG", 6),
            "GGC": ("A", "GCC", 4),
            "ACG": ("R", "CGT", 3),
            "CCG": ("R", "CGG", 3),
            "GTT": ("N", "AAC", 3),
            "GTC": ("D", "GAC", 3),
            "CTC": ("E", "GAG", 4),
            "CTG": ("Q", "CAG", 3),
            "GCC": ("G", "GGC", 5),
            "GAT": ("I", "ATC", 4),
            "CAG": ("L", "CTG", 6),
            "CTT": ("K", "AAG", 4),
            "CAT": ("M", "ATG", 5),
            "GAA": ("F", "TTC", 3),
            "CGG": ("P", "CCG", 3),
            "GCT": ("S", "AGC", 3),
            "CGT": ("T", "ACG", 2),
            "GGT": ("T", "ACC", 4),
            "CCA": ("W", "TGG", 1),
            "GTA": ("Y", "TAC", 2),
            "CAC": ("V", "GTG", 4),
        }
    },

    "Bacillus subtilis 168": {
        "tax_id": 224308,
        "trnas": {
            # AT-rich host - different codon preferences
            "TGC": ("A", "GCA", 4),
            "GGC": ("A", "GCC", 2),
            "TCT": ("R", "AGA", 3),
            "ACG": ("R", "CGT", 2),
            "GTT": ("N", "AAC", 3),
            "GTC": ("D", "GAC", 2),
            "TTC": ("E", "GAA", 4),
            "TTG": ("Q", "CAA", 3),
            "TCC": ("G", "GGA", 4),
            "GAT": ("I", "ATC", 3),
            "TAT": ("I", "ATA", 2),
            "TAA": ("L", "TTA", 3),
            "CAA": ("L", "TTG", 3),
            "TTT": ("K", "AAA", 5),
            "CAT": ("M", "ATG", 5),
            "GAA": ("F", "TTC", 2),
            "TGG": ("P", "CCA", 3),
            "TGA": ("S", "TCA", 3),
            "GGA": ("S", "TCC", 2),
            "TGT": ("T", "ACA", 3),
            "CCA": ("W", "TGG", 1),
            "GTA": ("Y", "TAC", 2),
            "TAC": ("V", "GTA", 3),
        }
    },

    "Synechococcus elongatus PCC 7942": {
        "tax_id": 1140,
        "trnas": {
            # Cyanobacterium - for marine phage AMG context
            "CGC": ("A", "GCG", 4),
            "GGC": ("A", "GCC", 3),
            "ACG": ("R", "CGT", 3),
            "GTT": ("N", "AAC", 3),
            "GTC": ("D", "GAC", 3),
            "CTC": ("E", "GAG", 3),
            "TTC": ("E", "GAA", 3),
            "CTG": ("Q", "CAG", 2),
            "GCC": ("G", "GGC", 4),
            "GAT": ("I", "ATC", 4),
            "CAG": ("L", "CTG", 4),
            "TTT": ("K", "AAA", 4),
            "CTT": ("K", "AAG", 3),
            "CAT": ("M", "ATG", 4),
            "GAA": ("F", "TTC", 3),
            "TGG": ("P", "CCA", 2),
            "GCT": ("S", "AGC", 3),
            "GGT": ("T", "ACC", 3),
            "CCA": ("W", "TGG", 1),
            "GTA": ("Y", "TAC", 2),
            "CAC": ("V", "GTG", 3),
        }
    },
}


def ensure_tables(db_path: str):
    """Ensure host tRNA tables exist."""
    conn = sqlite3.connect(db_path)

    conn.execute("""
        CREATE TABLE IF NOT EXISTS host_trna_pools (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            host_name TEXT NOT NULL,
            host_tax_id INTEGER,
            anticodon TEXT NOT NULL,
            amino_acid TEXT NOT NULL,
            codon TEXT,
            copy_number INTEGER,
            relative_abundance REAL
        )
    """)

    conn.execute("CREATE INDEX IF NOT EXISTS idx_trna_host ON host_trna_pools(host_name)")
    conn.execute("CREATE INDEX IF NOT EXISTS idx_trna_anticodon ON host_trna_pools(anticodon)")

    conn.commit()
    conn.close()


def load_trna_data(db_path: str):
    """Load host tRNA data into the database."""
    conn = sqlite3.connect(db_path)

    # Clear existing data
    conn.execute("DELETE FROM host_trna_pools")

    for host_name, host_data in HOST_TRNA_DATA.items():
        tax_id = host_data["tax_id"]
        trnas = host_data["trnas"]

        # Calculate total copy numbers for relative abundance
        total_copies = sum(t[2] for t in trnas.values())

        for anticodon, (amino_acid, codon, copy_number) in trnas.items():
            relative_abundance = copy_number / total_copies if total_copies > 0 else 0

            conn.execute("""
                INSERT INTO host_trna_pools
                (host_name, host_tax_id, anticodon, amino_acid, codon, copy_number, relative_abundance)
                VALUES (?, ?, ?, ?, ?, ?, ?)
            """, (host_name, tax_id, anticodon, amino_acid, codon, copy_number, relative_abundance))

    conn.commit()

    # Update metadata
    conn.execute("""
        INSERT OR REPLACE INTO annotation_meta (key, value, updated_at)
        VALUES ('trna_data_loaded', ?, ?)
    """, (f"{len(HOST_TRNA_DATA)} hosts loaded", int(time.time())))

    conn.commit()
    conn.close()

    print(f"Loaded tRNA data for {len(HOST_TRNA_DATA)} hosts")


def main():
    parser = argparse.ArgumentParser(description="Load host tRNA pool data")
    parser.add_argument("--db", required=True, help="Path to phage.db")
    args = parser.parse_args()

    db_path = Path(args.db)
    if not db_path.exists():
        print(f"Error: Database not found: {db_path}")
        return 1

    ensure_tables(str(db_path))
    load_trna_data(str(db_path))

    return 0


if __name__ == "__main__":
    exit(main())
