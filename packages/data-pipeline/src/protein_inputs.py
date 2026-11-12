"""One validated genomic CDS producer for catalog builds and Python annotations."""
from contextlib import contextmanager
import json
from pathlib import Path
import shutil
import sqlite3
import subprocess
import sys


def _bun_json(filename, arguments, *, input_text=None):
    bun = shutil.which("bun")
    if not bun:
        raise RuntimeError("Bun is required for shared annotation producers; install Bun before annotating")
    producer = Path(__file__).resolve().with_name(filename)
    completed = subprocess.run(
        [bun, str(producer), *arguments], cwd=producer.parents[3],
        input=input_text, capture_output=True, text=True, timeout=120,
    )
    if completed.returncode:
        raise RuntimeError(f"Validated annotation producer failed: {completed.stderr.strip()}")
    return json.loads(completed.stdout)


def load_protein_inputs(connection: sqlite3.Connection, *, log_exclusions=True):
    databases = connection.execute("PRAGMA database_list").fetchall()
    source = next((row[2] for row in databases if row[1] == "main"), None)
    if not source:
        raise ValueError("Protein annotation requires a file-backed SQLite source")
    report = _bun_json("protein-inputs.ts", ["--database", str(Path(source).resolve())])
    if (not isinstance(report, dict) or report.get("format") != "phage-explorer-protein-inputs"
            or report.get("version") != 1 or report.get("method") != "validated-genomic-cds-v1"
            or not isinstance(report.get("proteins"), list) or not isinstance(report.get("excluded"), list)):
        raise ValueError("Unsupported validated protein input format")
    if log_exclusions and report["excluded"]:
        print(f"Excluded {len(report['excluded'])} unsupported CDS rows; reasons are retained in annotation metadata", file=sys.stderr)
    return report


def derive_pfam_annotations(rows):
    """Use the existing TypeScript Pfam rules; never duplicate their biology."""
    domains = [{"phageId": row[0], "geneId": row[1], "locusTag": row[2], "domainId": row[3],
        "domainName": row[4], "eValue": row[9], "score": row[8], "description": row[10]} for row in rows]
    report = _bun_json("domain-annotations.ts", ["--derive-pfam-input"],
        input_text=json.dumps(domains, allow_nan=False))
    if (not isinstance(report, dict) or report.get("format") != "phage-explorer-pfam-derived"
            or report.get("version") != 1 or not isinstance(report.get("defenseHits"), list)
            or not isinstance(report.get("amgHits"), list)):
        raise ValueError("Unsupported derived Pfam annotation format")
    return report


def require_unchanged_inputs(connection: sqlite3.Connection, expected):
    """Call after BEGIN IMMEDIATE, before replacing derived annotation rows."""
    if load_protein_inputs(connection, log_exclusions=False) != expected:
        raise RuntimeError("Genomic CDS inputs changed during annotation; no new annotations were published")


@contextmanager
def annotation_transaction(connection: sqlite3.Connection, expected):
    """Publish one complete result while preventing a concurrent source change."""
    if connection.in_transaction:
        raise ValueError("Finish any open transaction before publishing annotations")
    connection.execute("BEGIN IMMEDIATE")
    try:
        require_unchanged_inputs(connection, expected)
        yield
        connection.commit()
    except BaseException:
        connection.rollback()
        raise


def protein_identity(item):
    return {key: item[key] for key in (
        "geneId", "phageId", "sourceGeneIds", "geneticCode", "codonStart", "cdsSha256", "sequenceSha256"
    )}


def protein_input_metadata(report):
    return {
        "method": report["method"],
        "acceptedProteins": len(report["proteins"]),
        "representedCdsRows": sum(len(item["sourceGeneIds"]) for item in report["proteins"]),
        "excluded": report["excluded"],
        "warnings": report["warnings"],
        "proteins": [protein_identity(item) for item in report["proteins"]],
    }
