#!/usr/bin/env python3
"""
Phage Annotation Pipeline Orchestrator

Runs all annotation steps in sequence:
1. Protein domain annotation (InterProScan)
2. AMG detection (KEGG mapping)
3. Host tRNA data loading
4. Codon adaptation calculation

Usage:
    python run_pipeline.py --db phage.db [--skip-domains] [--skip-kegg]
"""

import argparse
import sqlite3
import subprocess
import sys
import time
from pathlib import Path


def run_step(name: str, cmd: list[str], skip: bool = False):
    """Run a pipeline step."""
    if skip:
        print(f"⏭️  Skipping: {name}")
        return True

    print(f"\n{'='*60}")
    print(f"🚀 Running: {name}")
    print(f"{'='*60}\n")

    try:
        result = subprocess.run(cmd, check=True)
        print(f"\n✅ {name} completed successfully")
        return True
    except subprocess.CalledProcessError as e:
        print(f"\n❌ {name} failed with exit code {e.returncode}")
        return False
    except FileNotFoundError:
        print(f"\n❌ Command not found: {cmd[0]}")
        return False


def ensure_base_tables(db_path: str):
    """Ensure all annotation tables exist in the database."""
    conn = sqlite3.connect(db_path)

    # Annotation metadata table
    conn.execute("""
        CREATE TABLE IF NOT EXISTS annotation_meta (
            key TEXT PRIMARY KEY,
            value TEXT NOT NULL,
            updated_at INTEGER
        )
    """)

    # Protein domains
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

    # AMG annotations
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

    # Defense systems
    conn.execute("""
        CREATE TABLE IF NOT EXISTS defense_systems (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            phage_id INTEGER NOT NULL,
            gene_id INTEGER,
            locus_tag TEXT,
            system_type TEXT NOT NULL,
            system_family TEXT,
            target_system TEXT,
            mechanism TEXT,
            confidence REAL,
            source TEXT
        )
    """)

    # Host tRNA pools
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

    # Codon adaptation scores
    conn.execute("""
        CREATE TABLE IF NOT EXISTS codon_adaptation (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            phage_id INTEGER NOT NULL,
            host_name TEXT NOT NULL,
            gene_id INTEGER,
            locus_tag TEXT,
            cai REAL,
            tai REAL,
            cpb REAL,
            enc_prime REAL
        )
    """)

    # Create indices
    conn.execute("CREATE INDEX IF NOT EXISTS idx_domains_phage ON protein_domains(phage_id)")
    conn.execute("CREATE INDEX IF NOT EXISTS idx_domains_gene ON protein_domains(gene_id)")
    conn.execute("CREATE INDEX IF NOT EXISTS idx_domains_domain ON protein_domains(domain_id)")
    conn.execute("CREATE INDEX IF NOT EXISTS idx_amg_phage ON amg_annotations(phage_id)")
    conn.execute("CREATE INDEX IF NOT EXISTS idx_amg_type ON amg_annotations(amg_type)")
    conn.execute("CREATE INDEX IF NOT EXISTS idx_defense_phage ON defense_systems(phage_id)")
    conn.execute("CREATE INDEX IF NOT EXISTS idx_defense_type ON defense_systems(system_type)")
    conn.execute("CREATE INDEX IF NOT EXISTS idx_trna_host ON host_trna_pools(host_name)")
    conn.execute("CREATE INDEX IF NOT EXISTS idx_trna_anticodon ON host_trna_pools(anticodon)")
    conn.execute("CREATE INDEX IF NOT EXISTS idx_adaptation_phage ON codon_adaptation(phage_id)")
    conn.execute("CREATE INDEX IF NOT EXISTS idx_adaptation_host ON codon_adaptation(host_name)")

    conn.commit()
    conn.close()


def get_annotation_stats(db_path: str) -> dict:
    """Get statistics about current annotations."""
    conn = sqlite3.connect(db_path)

    stats = {}

    # Count records in each table
    tables = [
        ('protein_domains', 'domains'),
        ('amg_annotations', 'amgs'),
        ('defense_systems', 'defense_systems'),
        ('host_trna_pools', 'host_trnas'),
        ('codon_adaptation', 'adaptations'),
    ]

    for table, key in tables:
        try:
            count = conn.execute(f"SELECT COUNT(*) FROM {table}").fetchone()[0]
            stats[key] = count
        except sqlite3.OperationalError:
            stats[key] = 0

    # Get phage count
    try:
        stats['phages'] = conn.execute("SELECT COUNT(*) FROM phages").fetchone()[0]
    except sqlite3.OperationalError:
        stats['phages'] = 0

    conn.close()
    return stats


def main():
    parser = argparse.ArgumentParser(description="Run phage annotation pipeline")
    parser.add_argument("--db", required=True, help="Path to phage.db")
    parser.add_argument("--skip-domains", action="store_true",
                       help="Skip InterProScan domain annotation (slow)")
    parser.add_argument("--skip-kegg", action="store_true",
                       help="Skip KEGG pathway mapping")
    parser.add_argument("--limit", type=int,
                       help="Limit number of genes to annotate (for testing)")
    args = parser.parse_args()

    db_path = Path(args.db).resolve()
    script_dir = Path(__file__).parent

    if not db_path.exists():
        print(f"Error: Database not found: {db_path}")
        return 1

    print(f"🧬 Phage Annotation Pipeline")
    print(f"   Database: {db_path}")
    print(f"   Script dir: {script_dir}")

    # Ensure tables exist
    print("\n📋 Ensuring annotation tables exist...")
    ensure_base_tables(str(db_path))

    # Get initial stats
    initial_stats = get_annotation_stats(str(db_path))
    print(f"   Phages in database: {initial_stats['phages']}")
    print(f"   Existing domains: {initial_stats['domains']}")
    print(f"   Existing AMGs: {initial_stats['amgs']}")

    success = True
    start_time = time.time()

    # Step 1: Load host tRNA data (fast, always run)
    cmd = [sys.executable, str(script_dir / "host_trna_data.py"), "--db", str(db_path)]
    success = run_step("Host tRNA Data", cmd) and success

    # Step 2: Domain annotation (slow - uses InterProScan REST API)
    cmd = [sys.executable, str(script_dir / "annotate_domains.py"), "--db", str(db_path)]
    if args.limit:
        cmd.extend(["--limit", str(args.limit)])
    success = run_step("Domain Annotation (InterProScan)", cmd, skip=args.skip_domains) and success

    # Step 3: KEGG AMG mapping (depends on domains)
    if not args.skip_domains or initial_stats['domains'] > 0:
        cmd = [sys.executable, str(script_dir / "fetch_kegg.py"), "--db", str(db_path)]
        success = run_step("AMG Detection (KEGG)", cmd, skip=args.skip_kegg) and success
    else:
        print("⏭️  Skipping AMG detection (no domains available)")

    # Final stats
    elapsed = time.time() - start_time
    final_stats = get_annotation_stats(str(db_path))

    print(f"\n{'='*60}")
    print("📊 Pipeline Complete")
    print(f"{'='*60}")
    print(f"   Time elapsed: {elapsed:.1f}s")
    print(f"   Domains: {initial_stats['domains']} → {final_stats['domains']} (+{final_stats['domains'] - initial_stats['domains']})")
    print(f"   AMGs: {initial_stats['amgs']} → {final_stats['amgs']} (+{final_stats['amgs'] - initial_stats['amgs']})")
    print(f"   Host tRNAs: {final_stats['host_trnas']}")

    if success:
        print("\n✅ All steps completed successfully!")
    else:
        print("\n⚠️  Some steps failed - check output above")

    return 0 if success else 1


if __name__ == "__main__":
    exit(main())
