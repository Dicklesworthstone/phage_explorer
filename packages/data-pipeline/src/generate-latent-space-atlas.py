#!/usr/bin/env python3
"""
Precompute 2D UMAP projection and HDBSCAN clusters from ESM-2 embeddings.

Generates the Pan-Phage Latent Space Atlas coordinates, cluster IDs, and
outlier scores into `fold_embedding_coords` table in SQLite.
"""
import argparse
from contextlib import closing
import hashlib
from importlib.metadata import version
import json
import math
from pathlib import Path
import sqlite3
import struct
import time
from typing import NamedTuple

from protein_inputs import annotation_transaction, load_protein_inputs, protein_input_metadata


DEFAULT_MODEL = "facebook/esm2_t6_8M_UR50D"
POOLING = "attention-mean-including-special-tokens-l2"


class AtlasInputs(NamedTuple):
    model: str
    rows: tuple
    protein_report: str
    space: str
    sha256: str


def canonical(value):
    return json.dumps(value, sort_keys=True, separators=(",", ":"), ensure_ascii=False, allow_nan=False)


def read_atlas_inputs(connection, model, report=None):
    """Bind every vector to a currently reconstructible CDS and one embedding space."""
    if not isinstance(model, str) or not model.strip():
        raise ValueError("An explicit embedding model is required")
    report = load_protein_inputs(connection, log_exclusions=False) if report is None else report
    proteins = {item["geneId"]: item for item in report["proteins"]}
    rows = tuple(connection.execute(
        "SELECT gene_id, phage_id, dims, vector, meta FROM fold_embeddings WHERE model = ? ORDER BY gene_id",
        (model,),
    ))
    if not rows:
        raise ValueError(f"No embeddings found for model {model}; run the ESM2 annotation first")
    seen = set()
    space = None
    digest = hashlib.sha256()
    digest.update(canonical({"model": model, "input": protein_input_metadata(report)}).encode())
    for gene_id, phage_id, dims, blob, encoded_meta in rows:
        item = proteins.get(gene_id)
        if gene_id in seen or item is None or phage_id != item["phageId"]:
            raise ValueError("Atlas embeddings must have unique gene IDs owned by their current validated genome")
        seen.add(gene_id)
        if type(dims) is not int or dims < 1 or not isinstance(blob, bytes) or len(blob) != dims * 4:
            raise ValueError("Atlas embedding dimensions do not match their complete float32 vector")
        values = struct.unpack(f"<{dims}f", blob)
        if not all(math.isfinite(value) for value in values) or abs(math.sqrt(math.fsum(value * value for value in values)) - 1.0) > 1e-4:
            raise ValueError("Atlas embeddings require finite, nonzero L2-normalized vectors")
        meta = json.loads(encoded_meta) if isinstance(encoded_meta, str) else None
        if not isinstance(meta, dict) or meta.get("inputMethod") != report["method"] or any(
            meta.get(key) != item[key] for key in
            ["sourceGeneIds", "sequenceSha256", "cdsSha256", "geneticCode", "codonStart"]
        ):
            raise ValueError("Atlas embedding CDS provenance is missing or stale; rebuild ESM2 annotations")
        sequence = item["sequence"][:1022]
        revision = meta.get("revision")
        if (meta.get("checkpoint") != model or not isinstance(revision, str) or len(revision) != 40
                or any(char not in "0123456789abcdef" for char in revision)
                or meta.get("pooling") != POOLING or meta.get("normalized") is not True
                or meta.get("sequenceLength") != len(item["sequence"])
                or meta.get("truncated") is not (len(item["sequence"]) > 1022)
                or meta.get("encodedResidues") != len(sequence)
                or meta.get("encodedSequenceSha256") != hashlib.sha256(sequence.encode()).hexdigest()):
            raise ValueError("Atlas requires an immutable ESM2 revision and the actual pooling, normalization and encoded-residue provenance")
        current_space = {"model": model, "revision": revision, "dimensions": dims, "pooling": POOLING,
            "normalized": True, "encoding": "first-1022-residues-v1"}
        if space is not None and current_space != space:
            raise ValueError("Atlas cannot mix embedding dimensions or model revisions")
        space = current_space
        # Include exact vector bytes and complete metadata, not just row counts
        # or selected fields. The report binds source CDSs too.
        digest.update(canonical([gene_id, phage_id, dims, blob.hex(), encoded_meta]).encode())
        digest.update(b"\n")
    return AtlasInputs(model, rows, canonical(report), canonical(space), digest.hexdigest())


def compute_projection(inputs):
    """Run the declared numerical method; no database writes occur during fitting."""
    if len(inputs.rows) < 4:
        raise ValueError("The UMAP/HDBSCAN atlas requires at least four validated protein embeddings")
    import hdbscan
    import numpy as np
    import umap

    parameters = {
        "umap": {"n_components": 2, "n_neighbors": min(15, len(inputs.rows) - 1), "min_dist": 0.1,
            "metric": "cosine", "random_state": 42, "init": "random", "n_jobs": 1},
        "hdbscan": {"min_cluster_size": min(5, len(inputs.rows)), "min_samples": min(3, len(inputs.rows) - 1),
            "metric": "euclidean"},
    }
    vectors = np.array([struct.unpack(f"<{row[2]}f", row[3]) for row in inputs.rows], dtype=np.float32)
    coords = umap.UMAP(**parameters["umap"]).fit_transform(vectors)
    clusterer = hdbscan.HDBSCAN(**parameters["hdbscan"])
    cluster_ids = clusterer.fit_predict(coords)
    method = {"id": "esm2-umap-hdbscan-v1", "parameters": parameters,
        "versions": {name: version(name) for name in ["umap-learn", "hdbscan", "numpy", "scikit-learn"]}}
    return coords.tolist(), cluster_ids.tolist(), clusterer.outlier_scores_.tolist(), method


def publish_atlas(connection, inputs, coords, cluster_ids, outlier_scores, method, now):
    """Replace one model's complete atlas only while its exact source remains current."""
    count = len(inputs.rows)
    if not count or any(len(values) != count for values in [coords, cluster_ids, outlier_scores]):
        raise ValueError("Atlas outputs must cover every input embedding exactly once")
    for point, cluster, score in zip(coords, cluster_ids, outlier_scores):
        if (not isinstance(point, (list, tuple)) or len(point) != 2
                or any(type(value) not in (int, float) or not math.isfinite(value) for value in point)
                or type(cluster) is not int or cluster < -1
                or type(score) not in (int, float) or not math.isfinite(score) or not 0 <= score <= 1):
            raise ValueError("Atlas outputs require finite 2D coordinates, valid cluster IDs and outlier scores in [0,1]")
    if not isinstance(method, dict) or not isinstance(method.get("id"), str) or not method["id"]:
        raise ValueError("Atlas method provenance is required")
    report = json.loads(inputs.protein_report)
    metadata = {
        "model": inputs.model, "count": count, "clusters": len(set(cluster_ids) - {-1}),
        "outliers": cluster_ids.count(-1), "mean_outlier_score": math.fsum(outlier_scores) / count,
        "max_outlier_score": max(outlier_scores), "min_outlier_score": min(outlier_scores),
        "inputSha256": inputs.sha256, "embeddingSpace": json.loads(inputs.space),
        "method": method, "inputDigestMethod": "validated-cds-and-embedding-rows-sha256-v1",
        "input": {"method": report["method"],
            "representedCdsRows": sum(len(item["sourceGeneIds"]) for item in report["proteins"]),
            "excludedCdsRows": len(report["excluded"]), "warnings": report["warnings"]},
        "coverage": {"eligibleProteins": len(report["proteins"]), "embeddedProteins": count},
        "limitations": ["2D proximity and density clusters do not establish protein function or structural similarity.",
            "HDBSCAN clusters and outlier scores describe the UMAP projection, not the original embedding space."],
    }
    encoded_metadata = canonical(metadata)
    with annotation_transaction(connection, report):
        if read_atlas_inputs(connection, inputs.model, report) != inputs:
            raise RuntimeError("Embedding inputs changed during atlas computation; no atlas was published")
        connection.execute("""
        CREATE TABLE IF NOT EXISTS fold_embedding_coords (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            phage_id INTEGER NOT NULL,
            gene_id INTEGER NOT NULL,
            model TEXT NOT NULL,
            x REAL NOT NULL,
            y REAL NOT NULL,
            cluster_id INTEGER NOT NULL,
            outlier_score REAL NOT NULL,
            created_at INTEGER,
            FOREIGN KEY (phage_id) REFERENCES phages(id),
            FOREIGN KEY (gene_id) REFERENCES genes(id)
        );
        """)
        for name, columns in [("phage", "phage_id"), ("gene", "gene_id"), ("cluster", "cluster_id")]:
            connection.execute(f"CREATE INDEX IF NOT EXISTS idx_fold_coords_{name} ON fold_embedding_coords({columns})")
        connection.execute("CREATE UNIQUE INDEX IF NOT EXISTS uniq_fold_coords_gene_model ON fold_embedding_coords(gene_id, model)")
        connection.execute("DELETE FROM fold_embedding_coords WHERE model = ?", (inputs.model,))
        connection.executemany(
            "INSERT INTO fold_embedding_coords (phage_id, gene_id, model, x, y, cluster_id, outlier_score, created_at) "
            "VALUES (?, ?, ?, ?, ?, ?, ?, ?)",
            [(row[1], row[0], inputs.model, point[0], point[1], cluster, score, now)
                for row, point, cluster, score in zip(inputs.rows, coords, cluster_ids, outlier_scores)],
        )
        # Model-specific provenance survives when a second model is projected.
        # The existing unqualified key remains the default Atlas UI's source.
        keys = ["latent_space_atlas:" + inputs.model]
        if inputs.model == DEFAULT_MODEL:
            keys.append("latent_space_atlas")
        connection.executemany("INSERT OR REPLACE INTO annotation_meta (key, value, updated_at) VALUES (?, ?, ?)",
            [(key, encoded_metadata, now) for key in keys])
        embedding_metadata = connection.execute("SELECT value FROM annotation_meta WHERE key = 'esm2_embeddings'").fetchone()
        if embedding_metadata:
            previous = json.loads(embedding_metadata[0])
            if isinstance(previous, dict) and previous.get("model") == inputs.model:
                previous.update({"atlasNeedsRebuild": False, "atlasInputSha256": inputs.sha256})
                connection.execute("UPDATE annotation_meta SET value = ?, updated_at = ? WHERE key = 'esm2_embeddings'",
                    (canonical(previous), now))
    return metadata


def process_database(db_path: str, model: str = DEFAULT_MODEL):
    # An absent input is an error, never a silently created empty catalog.
    uri = Path(db_path).resolve().as_uri() + "?mode=rw"
    with closing(sqlite3.connect(uri, uri=True)) as connection:
        inputs = read_atlas_inputs(connection, model)
        print(f"Computing atlas for {len(inputs.rows)} validated protein embeddings ({inputs.sha256[:16]})...", flush=True)
        coords, clusters, scores, method = compute_projection(inputs)
        metadata = publish_atlas(connection, inputs, coords, clusters, scores, method, int(time.time() * 1000))
        print(f"Finished {db_path}: {metadata['count']} genes, {metadata['clusters']} clusters, {metadata['outliers']} outliers.")
        return metadata


def main():
    parser = argparse.ArgumentParser(description="Precompute Pan-Phage Latent Space Atlas UMAP coords and HDBSCAN clusters.")
    parser.add_argument("--database", default="phage.db", help="Path to SQLite database")
    parser.add_argument("--model", default="facebook/esm2_t6_8M_UR50D", help="ESM-2 model name")
    args = parser.parse_args()
    process_database(args.database, args.model)


if __name__ == "__main__":
    main()
