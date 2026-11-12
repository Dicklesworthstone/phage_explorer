#!/usr/bin/env python3
import argparse
from contextlib import closing
import gzip
import hashlib
import json
import math
import re
import shutil
import sqlite3
import time
import urllib.request
from pathlib import Path

from protein_inputs import (
    annotation_transaction, derive_pfam_annotations, load_protein_inputs,
    protein_identity, protein_input_metadata,
)

PFAM_BASE = "https://ftp.ebi.ac.uk/pub/databases/Pfam"
THRESHOLD_POLICY = "target-and-independent-domain-evalue-v1"
USER_AGENT = "phage_explorer-agent (+https://github.com/Dicklesworthstone/phage_explorer)"


def decode(value):
    return value.decode() if value else None


def _valid_release(value):
    return isinstance(value, str) and re.fullmatch(r"\d+(?:\.\d+)?", value) is not None


def _release_source(release):
    if not _valid_release(release):
        raise ValueError("Pfam release must be numeric, for example 38.2")
    return f"{PFAM_BASE}/releases/Pfam{release}"


def _release_info(base):
    url = f"{base}/Pfam.version.gz"
    request = urllib.request.Request(url, headers={"User-Agent": USER_AGENT})
    with urllib.request.urlopen(request, timeout=120) as response:
        data = response.read()
    return parse_release_info(data, url)


def parse_release_info(data, source_url):
    text = gzip.decompress(data).decode("utf-8")
    match = re.search(r"(?im)^Pfam release\s*:\s*(\d+(?:\.\d+)?)\s*$", text)
    if not match:
        raise ValueError(f"Could not establish the actual Pfam release from {source_url}")
    return match[1], hashlib.sha256(data).hexdigest()


def _sidecar(path):
    return path.with_name(path.name + ".source.json")


def read_pfam_source(path, *, requested_release=None, allow_unversioned=False):
    """A local file's release comes from its checksum-bound download record."""
    checksum = sha256_file(path)
    sidecar = _sidecar(path)
    if not sidecar.exists():
        if allow_unversioned and requested_release is None:
            return {"release": "unknown", "hmmSha256": checksum, "sourceStatus": "unversioned-explicit"}
        raise ValueError("Pfam file has no verified release metadata. Use a fresh --pfam path with "
            "--pfam-release VERSION to download a versioned source, or explicitly use --allow-unversioned "
            "for custom work that cannot pass the catalog release gate.")
    metadata = json.loads(sidecar.read_text(encoding="utf-8"))
    if (not isinstance(metadata, dict) or metadata.get("format") != "phage-explorer-pfam-source"
            or metadata.get("version") != 1 or not _valid_release(metadata.get("release"))
            or metadata.get("hmmSha256") != checksum
            or metadata.get("sourceUrl") != _release_source(metadata["release"]) + "/Pfam-A.hmm.gz"
            or not isinstance(metadata.get("releaseInfoSha256"), str)
            or not re.fullmatch(r"[0-9a-f]{64}", metadata["releaseInfoSha256"])):
        raise ValueError("Pfam release metadata does not match the actual HMM file; use a fresh path for a versioned download")
    if requested_release is not None and requested_release != metadata["release"]:
        raise ValueError("Cached Pfam release differs from --pfam-release; select a fresh --pfam path")
    return {"release": metadata["release"], "hmmSha256": checksum, "sourceUrl": metadata["sourceUrl"],
        "releaseInfoSha256": metadata["releaseInfoSha256"], "sourceStatus": "versioned-download"}


def ensure_pfam(path: Path, *, release=None, allow_unversioned=False):
    if release is not None and not _valid_release(release):
        raise ValueError("--pfam-release must be numeric")
    if path.exists():
        return read_pfam_source(path, requested_release=release, allow_unversioned=allow_unversioned)
    path.parent.mkdir(parents=True, exist_ok=True)
    archive = path.with_suffix(path.suffix + ".gz")
    if archive.exists() or _sidecar(path).exists():
        raise ValueError("An unverified Pfam archive or sidecar already exists; choose a fresh --pfam path")
    if release is None:
        release, _ = _release_info(PFAM_BASE + "/current_release")
    base = _release_source(release)
    actual_release, release_info_sha = _release_info(base)
    if actual_release != release:
        raise ValueError("The versioned Pfam source reports a different release; no annotation can be published")
    source_url = base + "/Pfam-A.hmm.gz"
    request = urllib.request.Request(source_url, headers={"User-Agent": USER_AGENT})
    with urllib.request.urlopen(request, timeout=120) as response, archive.open("xb") as target:
        shutil.copyfileobj(response, target)
    with gzip.open(archive, "rb") as compressed, path.open("xb") as target:
        shutil.copyfileobj(compressed, target)
    # Never assign today's moving current_release label to an older cache.
    metadata = {"format": "phage-explorer-pfam-source", "version": 1, "release": release,
        "sourceUrl": source_url, "hmmSha256": sha256_file(path), "releaseInfoSha256": release_info_sha}
    with _sidecar(path).open("x", encoding="utf-8") as output:
        json.dump(metadata, output, sort_keys=True)
        output.write("\n")
    return read_pfam_source(path, requested_release=release)


def sha256_file(path):
    digest = hashlib.sha256()
    with Path(path).open("rb") as stream:
        for chunk in iter(lambda: stream.read(1024 * 1024), b""):
            digest.update(chunk)
    return digest.hexdigest()


def scan_domains(proteins, pfam_path, *, cpus, e_value):
    import pyhmmer

    alphabet = pyhmmer.easel.Alphabet.amino()
    digital = [pyhmmer.easel.TextSequence(name=str(item["geneId"]).encode(),
        sequence=item["sequence"]).digitize(alphabet) for item in proteins]
    metadata = {item["geneId"]: item for item in proteins}
    rows = []
    with pyhmmer.plan7.HMMFile(pfam_path) as hmm_file:
        for index, hits in enumerate(pyhmmer.hmmer.hmmscan(digital, hmm_file, cpus=cpus,
                E=e_value, incE=e_value, domE=e_value, incdomE=e_value), 1):
            gene_id = int(hits.query.name.decode())
            item = metadata[gene_id]
            for hit in hits.included:
                if not math.isfinite(hit.evalue) or hit.evalue > e_value:
                    continue
                accession = decode(hit.accession) or decode(hit.name) or "unknown"
                domain_id = accession.split(".")[0]
                for domain in hit.domains.included:
                    if not math.isfinite(domain.i_evalue) or domain.i_evalue > e_value:
                        continue
                    alignment = domain.alignment
                    rows.append((item["phageId"], gene_id, item["locusTag"], domain_id,
                        decode(hit.name), "Pfam", alignment.target_from, alignment.target_to,
                        domain.score, domain.i_evalue, decode(hit.description)))
            if index % 25 == 0 or index == len(proteins):
                print(f"Scanned {index}/{len(proteins)} proteins", flush=True)
    return rows


def _manifest(item, report, source):
    return {"inputMethod": report["method"], "input": protein_identity(item),
        "hmmSha256": source["hmmSha256"], "eValue": source["eValue"], "release": source["release"],
        "thresholdPolicy": source["thresholdPolicy"], "toolVersion": source["toolVersion"]}


def _check_partial_provenance(connection, expected, selected, report, source):
    manifests = {int(key.split(":", 1)[1]): json.loads(value) for key, value in connection.execute(
        "SELECT key, value FROM annotation_meta WHERE key GLOB 'pfam_input:*'")}
    # Include zero-hit runs and dependent calls, not just the current hit rows.
    existing = {row[0] for row in connection.execute(
        "SELECT DISTINCT gene_id FROM protein_domains WHERE domain_type = 'Pfam' "
        "UNION SELECT gene_id FROM defense_systems WHERE source = 'pfam-domain' "
        "UNION SELECT gene_id FROM amg_annotations WHERE "
        "CASE WHEN json_valid(evidence) THEN json_extract(evidence, '$.source') END = 'pfam-domain'")}
    for gene_id in (existing | set(manifests)) - selected:
        if gene_id not in expected or manifests.get(gene_id) != _manifest(expected[gene_id], report, source):
            raise ValueError("Partial Pfam update would mix stale inputs or HMM releases; run a full annotation")


def _refresh_derived_counts(connection, now):
    for key, table, predicate in [
        ("domain_defense", "defense_systems", "source = 'pfam-domain'"),
        ("domain_amg", "amg_annotations",
            "CASE WHEN json_valid(evidence) THEN json_extract(evidence, '$.source') END = 'pfam-domain'"),
    ]:
        count, phages = connection.execute(
            f"SELECT COUNT(*), COUNT(DISTINCT phage_id) FROM {table} WHERE {predicate}").fetchone()
        connection.execute("INSERT OR REPLACE INTO annotation_meta VALUES (?, ?, ?)",
            (key, json.dumps({"count": count, "phages": phages, "source": "pfam-domain"}), now))


def publish_domains(connection, report, rows, processed_gene_ids, source, now, *, partial=False):
    """Publish raw domains, dependent rule calls and their provenance together."""
    expected = {item["geneId"]: item for item in report["proteins"]}
    selected = set(processed_gene_ids)
    if len(selected) != len(processed_gene_ids) or not selected <= set(expected) or (
        not partial and selected != set(expected)
    ):
        raise ValueError("Domain run must account for every selected validated protein, including zero-hit proteins")
    if (not isinstance(source.get("hmmSha256"), str) or len(source["hmmSha256"]) != 64
            or any(char not in "0123456789abcdef" for char in source["hmmSha256"])
            or not math.isfinite(source["eValue"]) or source["eValue"] <= 0
            or source.get("thresholdPolicy") != THRESHOLD_POLICY or not source.get("toolVersion")):
        raise ValueError("Pfam publication requires the actual HMM checksum and a positive E-value threshold")
    for row in rows:
        if (len(row) != 11 or row[1] not in selected or row[0] != expected[row[1]]["phageId"]
                or row[2] != expected[row[1]]["locusTag"] or row[5] != "Pfam"
                or type(row[6]) is not int or type(row[7]) is not int
                or not 1 <= row[6] <= row[7] <= len(expected[row[1]]["sequence"])
                or not math.isfinite(row[8]) or not math.isfinite(row[9]) or not 0 <= row[9] <= source["eValue"]):
            raise ValueError("Pfam hits must match selected protein residue coordinates and the declared E-value threshold")
    derived = derive_pfam_annotations(rows)
    with annotation_transaction(connection, report):
        if partial:
            _check_partial_provenance(connection, expected, selected, report, source)
        predicates = [
            ("protein_domains", "domain_type = 'Pfam'"),
            ("defense_systems", "source = 'pfam-domain'"),
            ("amg_annotations", "CASE WHEN json_valid(evidence) THEN json_extract(evidence, '$.source') END = 'pfam-domain'"),
        ]
        for table, predicate in predicates:
            if partial:
                connection.executemany(f"DELETE FROM {table} WHERE {predicate} AND gene_id = ?",
                    [(gene_id,) for gene_id in sorted(selected)])
            else:
                connection.execute(f"DELETE FROM {table} WHERE {predicate}")
        connection.executemany(
            "INSERT INTO protein_domains (phage_id, gene_id, locus_tag, domain_id, domain_name, domain_type, start, end, score, e_value, description) "
            "VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)", rows)
        connection.executemany(
            "INSERT INTO defense_systems (phage_id, gene_id, locus_tag, system_type, system_family, target_system, mechanism, confidence, source) "
            "VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)",
            [(item["phageId"], item["geneId"], item["locusTag"], item["systemType"], item["systemFamily"],
              item["targetSystem"], item["mechanism"], item["confidence"], item["source"]) for item in derived["defenseHits"]])
        connection.executemany(
            "INSERT INTO amg_annotations (phage_id, gene_id, locus_tag, amg_type, kegg_ortholog, kegg_reaction, kegg_pathway, pathway_name, confidence, evidence) "
            "VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)",
            [(item["phageId"], item["geneId"], item["locusTag"], item["amgType"], item["keggOrtholog"], item["keggReaction"],
              item["keggPathway"], item["pathwayName"], item["confidence"], item["evidence"]) for item in derived["amgHits"]])
        if not partial:
            connection.execute("DELETE FROM annotation_meta WHERE key GLOB 'pfam_input:*'")
        connection.executemany("INSERT OR REPLACE INTO annotation_meta VALUES (?, ?, ?)",
            [(f"pfam_input:{gene_id}", json.dumps(_manifest(expected[gene_id], report, source)), now)
                for gene_id in sorted(selected)])
        count = connection.execute("SELECT COUNT(*) FROM protein_domains WHERE domain_type = 'Pfam'").fetchone()[0]
        scanned = connection.execute("SELECT COUNT(*) FROM annotation_meta WHERE key GLOB 'pfam_input:*'").fetchone()[0]
        _refresh_derived_counts(connection, now)
        connection.execute(
            "INSERT OR REPLACE INTO annotation_meta (key, value, updated_at) VALUES (?, ?, ?)",
            ("pfam_domains", json.dumps({**source, "hits": count, "updatedHits": len(rows), "partial": partial,
                "processedGeneIds": sorted(selected), "scannedProteins": scanned, "input": protein_input_metadata(report),
                "tool": "pyhmmer.hmmer.hmmscan", "database": "Pfam-A"}), now),
        )


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("--database", default="phage.db")
    parser.add_argument("--pfam", default="~/.cache/phage-explorer/pfam/Pfam-A.hmm")
    parser.add_argument("--pfam-release", help="Download this numeric release from a versioned EBI source")
    parser.add_argument("--allow-unversioned", action="store_true", help="Explicit custom input only; cannot pass the catalog release gate")
    parser.add_argument("--cpus", type=int, default=4)
    parser.add_argument("--e-value", type=float, default=1e-5)
    parser.add_argument("--limit", type=int)
    args = parser.parse_args()
    if args.limit is not None and args.limit < 1:
        parser.error("--limit must be positive")
    if args.cpus < 1 or not math.isfinite(args.e_value) or args.e_value <= 0:
        parser.error("--cpus and --e-value must be positive")

    pfam_path = Path(args.pfam).expanduser()
    source = ensure_pfam(pfam_path, release=args.pfam_release, allow_unversioned=args.allow_unversioned)
    import pyhmmer
    source.update({"eValue": args.e_value, "thresholdPolicy": THRESHOLD_POLICY, "toolVersion": pyhmmer.__version__})
    uri = Path(args.database).resolve().as_uri() + "?mode=rw"
    with closing(sqlite3.connect(uri, uri=True)) as connection:
        report = load_protein_inputs(connection)
        proteins = report["proteins"][:args.limit] if args.limit is not None else report["proteins"]
        rows = scan_domains(proteins, pfam_path, cpus=args.cpus, e_value=args.e_value)
        if sha256_file(pfam_path) != source["hmmSha256"]:
            raise RuntimeError("Pfam HMM file changed during scanning; no annotations were published")
        publish_domains(connection, report, rows, [item["geneId"] for item in proteins],
            source, int(time.time() * 1000), partial=args.limit is not None)


if __name__ == "__main__":
    main()
