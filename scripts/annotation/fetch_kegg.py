#!/usr/bin/env python3
"""
KEGG Pathway Mapping for AMG Detection

Identifies Auxiliary Metabolic Genes (AMGs) by mapping protein domains
to KEGG orthologs and pathways.

Usage:
    python fetch_kegg.py --db phage.db
"""

import argparse
import json
import re
import sqlite3
import time
from pathlib import Path

import requests
from tqdm import tqdm

# KEGG REST API base URL
KEGG_API = "https://rest.kegg.jp"

# Rate limiting for KEGG API
REQUEST_DELAY = 0.2  # 10 requests/second max

# Known AMG-associated KEGG pathways
AMG_PATHWAYS = {
    # Photosynthesis
    "ko00195": {"type": "photosynthesis", "name": "Photosynthesis"},
    "ko00196": {"type": "photosynthesis", "name": "Photosynthesis - antenna proteins"},

    # Carbon metabolism
    "ko00010": {"type": "carbon", "name": "Glycolysis / Gluconeogenesis"},
    "ko00020": {"type": "carbon", "name": "Citrate cycle (TCA cycle)"},
    "ko00030": {"type": "carbon", "name": "Pentose phosphate pathway"},

    # Nucleotide metabolism
    "ko00230": {"type": "nucleotide", "name": "Purine metabolism"},
    "ko00240": {"type": "nucleotide", "name": "Pyrimidine metabolism"},

    # Amino acid metabolism
    "ko00250": {"type": "amino_acid", "name": "Alanine, aspartate and glutamate metabolism"},
    "ko00260": {"type": "amino_acid", "name": "Glycine, serine and threonine metabolism"},

    # Sulfur/Nitrogen
    "ko00910": {"type": "sulfur", "name": "Nitrogen metabolism"},
    "ko00920": {"type": "sulfur", "name": "Sulfur metabolism"},

    # Lipid metabolism
    "ko00061": {"type": "lipid", "name": "Fatty acid biosynthesis"},
}

# Known AMG-associated KOs (KEGG Orthologs)
AMG_ORTHOLOGS = {
    # Photosynthesis
    "K02703": {"type": "photosynthesis", "name": "psbA", "desc": "photosystem II P680 reaction center D1 protein"},
    "K02706": {"type": "photosynthesis", "name": "psbD", "desc": "photosystem II P680 reaction center D2 protein"},
    "K02689": {"type": "photosynthesis", "name": "psaA", "desc": "photosystem I P700 chlorophyll a apoprotein A1"},

    # Nucleotide synthesis
    "K00525": {"type": "nucleotide", "name": "nrdA", "desc": "ribonucleoside-diphosphate reductase alpha chain"},
    "K00526": {"type": "nucleotide", "name": "nrdB", "desc": "ribonucleoside-diphosphate reductase beta chain"},
    "K03465": {"type": "nucleotide", "name": "thyX", "desc": "thymidylate synthase (FAD)"},

    # Stress response
    "K01519": {"type": "stress", "name": "mazG", "desc": "nucleoside triphosphate pyrophosphohydrolase"},
    "K06217": {"type": "stress", "name": "phoH", "desc": "phosphate starvation-inducible protein"},

    # Carbon
    "K00927": {"type": "carbon", "name": "pgk", "desc": "phosphoglycerate kinase"},
    "K01803": {"type": "carbon", "name": "tpiA", "desc": "triosephosphate isomerase"},
    "K00134": {"type": "carbon", "name": "gapA", "desc": "glyceraldehyde 3-phosphate dehydrogenase"},
    "K01689": {"type": "carbon", "name": "eno", "desc": "enolase"},

    # Phosphorus
    "K01077": {"type": "phosphorus", "name": "phoA", "desc": "alkaline phosphatase"},
    "K02040": {"type": "phosphorus", "name": "pstS", "desc": "phosphate transport system substrate-binding protein"},
}


def get_ko_from_domain(domain_id: str, domain_name: str) -> list[str]:
    """Map a Pfam/InterPro domain to KEGG orthologs."""
    # Query KEGG for Pfam mapping
    url = f"{KEGG_API}/link/ko/pfam:{domain_id}"

    try:
        resp = requests.get(url, timeout=30)
        if resp.status_code == 200 and resp.text.strip():
            kos = []
            for line in resp.text.strip().split('\n'):
                if '\t' in line:
                    _, ko = line.split('\t')
                    kos.append(ko.replace('ko:', ''))
            return kos
    except Exception:
        pass

    return []


def get_pathways_for_ko(ko_id: str) -> list[dict]:
    """Get KEGG pathways for a given KO."""
    url = f"{KEGG_API}/link/pathway/ko:{ko_id}"

    try:
        resp = requests.get(url, timeout=30)
        if resp.status_code == 200 and resp.text.strip():
            pathways = []
            for line in resp.text.strip().split('\n'):
                if '\t' in line:
                    _, pathway = line.split('\t')
                    pathway_id = pathway.replace('path:', '')
                    if pathway_id in AMG_PATHWAYS:
                        pathways.append({
                            'pathway_id': pathway_id,
                            **AMG_PATHWAYS[pathway_id]
                        })
            return pathways
    except Exception:
        pass

    return []


def ensure_tables(db_path: str):
    """Ensure AMG annotation tables exist."""
    conn = sqlite3.connect(db_path)

    conn.execute("""
        CREATE TABLE IF NOT EXISTS amg_annotations (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            phage_id INTEGER NOT NULL,
            gene_id INTEGER,
            locus_tag TEXT,
            amg_type TEXT NOT NULL,
            kegg_ortholog TEXT,
            kegg_reaction TEXT,
            kegg_pathway TEXT,
            pathway_name TEXT,
            confidence REAL,
            evidence TEXT
        )
    """)

    conn.execute("CREATE INDEX IF NOT EXISTS idx_amg_phage ON amg_annotations(phage_id)")
    conn.execute("CREATE INDEX IF NOT EXISTS idx_amg_type ON amg_annotations(amg_type)")

    conn.commit()
    conn.close()


def detect_amgs_from_domains(db_path: str):
    """Detect AMGs by mapping protein domains to KEGG."""
    conn = sqlite3.connect(db_path)
    conn.row_factory = sqlite3.Row

    # Get all protein domains
    domains = conn.execute("""
        SELECT DISTINCT
            pd.phage_id,
            pd.gene_id,
            pd.locus_tag,
            pd.domain_id,
            pd.domain_name,
            pd.description
        FROM protein_domains pd
        WHERE pd.domain_id IS NOT NULL
    """).fetchall()

    print(f"Checking {len(domains)} domain annotations for AMGs...")

    amg_count = 0

    for domain in tqdm(domains, desc="Mapping to KEGG"):
        domain_id = domain['domain_id']

        # Try to get KEGG orthologs for this domain
        kos = get_ko_from_domain(domain_id, domain['domain_name'])
        time.sleep(REQUEST_DELAY)

        for ko in kos:
            # Check if this is a known AMG ortholog
            if ko in AMG_ORTHOLOGS:
                amg_info = AMG_ORTHOLOGS[ko]

                # Get pathway information
                pathways = get_pathways_for_ko(ko)
                time.sleep(REQUEST_DELAY)

                pathway_id = pathways[0]['pathway_id'] if pathways else None
                pathway_name = pathways[0]['name'] if pathways else amg_info.get('desc', '')

                conn.execute("""
                    INSERT INTO amg_annotations
                    (phage_id, gene_id, locus_tag, amg_type, kegg_ortholog,
                     kegg_pathway, pathway_name, confidence, evidence)
                    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
                """, (
                    domain['phage_id'],
                    domain['gene_id'],
                    domain['locus_tag'],
                    amg_info['type'],
                    ko,
                    pathway_id,
                    pathway_name,
                    0.8,  # High confidence for known AMG KOs
                    json.dumps([f"Domain: {domain_id}", f"KO: {ko}"]),
                ))

                amg_count += 1

    conn.commit()

    # Update metadata
    conn.execute("""
        INSERT OR REPLACE INTO annotation_meta (key, value, updated_at)
        VALUES ('amg_last_updated', ?, ?)
    """, (f"KEGG mapping, {amg_count} AMGs detected", int(time.time())))

    conn.commit()
    conn.close()

    print(f"Detected {amg_count} AMG annotations")
    return amg_count


def main():
    parser = argparse.ArgumentParser(description="Detect AMGs via KEGG mapping")
    parser.add_argument("--db", required=True, help="Path to phage.db")
    args = parser.parse_args()

    db_path = Path(args.db)
    if not db_path.exists():
        print(f"Error: Database not found: {db_path}")
        return 1

    ensure_tables(str(db_path))
    detect_amgs_from_domains(str(db_path))

    return 0


if __name__ == "__main__":
    exit(main())
