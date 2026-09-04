#!/usr/bin/env python3
"""
Precompute 2D UMAP projection and HDBSCAN clusters from ESM-2 embeddings.

Generates the Pan-Phage Latent Space Atlas coordinates, cluster IDs, and
outlier scores into `fold_embedding_coords` table in SQLite.
"""
import argparse
import json
import sqlite3
import struct
import time

import hdbscan
import numpy as np
import umap


def process_database(db_path: str, model: str = "facebook/esm2_t6_8M_UR50D"):
    print(f"Connecting to {db_path}...")
    conn = sqlite3.connect(db_path)
    cursor = conn.cursor()

    cursor.execute(
        """
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
        """
    )
    cursor.execute("CREATE INDEX IF NOT EXISTS idx_fold_coords_phage ON fold_embedding_coords(phage_id);")
    cursor.execute("CREATE INDEX IF NOT EXISTS idx_fold_coords_gene ON fold_embedding_coords(gene_id);")
    cursor.execute("CREATE INDEX IF NOT EXISTS idx_fold_coords_cluster ON fold_embedding_coords(cluster_id);")
    cursor.execute("CREATE UNIQUE INDEX IF NOT EXISTS uniq_fold_coords_gene_model ON fold_embedding_coords(gene_id, model);")
    conn.commit()

    cursor.execute(
        "SELECT gene_id, phage_id, dims, vector FROM fold_embeddings WHERE model = ? ORDER BY gene_id",
        (model,)
    )
    rows = cursor.fetchall()
    if not rows:
        print(f"No embeddings found for model {model} in {db_path}")
        conn.close()
        return

    print(f"Loaded {len(rows)} embeddings for model '{model}'")

    gene_ids = []
    phage_ids = []
    vectors = []
    for gid, pid, dims, blob in rows:
        gene_ids.append(gid)
        phage_ids.append(pid)
        vec = struct.unpack(f"<{dims}f", blob)
        vectors.append(vec)

    X = np.array(vectors, dtype=np.float32)

    print("Computing 2D UMAP projection (cosine metric, n_neighbors=15, min_dist=0.1)...")
    reducer = umap.UMAP(
        n_neighbors=15,
        min_dist=0.1,
        metric="cosine",
        random_state=42,
    )
    coords = reducer.fit_transform(X)

    print("Computing HDBSCAN clusters and outlier scores (min_cluster_size=5, min_samples=3)...")
    clusterer = hdbscan.HDBSCAN(
        min_cluster_size=5,
        min_samples=3,
        metric="euclidean",
    )
    cluster_ids = clusterer.fit_predict(coords)
    outlier_scores = clusterer.outlier_scores_

    now = int(time.time() * 1000)
    insert_rows = []
    for i in range(len(gene_ids)):
        insert_rows.append((
            phage_ids[i],
            gene_ids[i],
            model,
            float(coords[i, 0]),
            float(coords[i, 1]),
            int(cluster_ids[i]),
            float(outlier_scores[i]),
            now,
        ))

    print(f"Inserting {len(insert_rows)} coordinates into fold_embedding_coords...")
    cursor.executemany(
        """
        INSERT INTO fold_embedding_coords (phage_id, gene_id, model, x, y, cluster_id, outlier_score, created_at)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?)
        ON CONFLICT(gene_id, model) DO UPDATE SET
            phage_id = excluded.phage_id,
            x = excluded.x,
            y = excluded.y,
            cluster_id = excluded.cluster_id,
            outlier_score = excluded.outlier_score,
            created_at = excluded.created_at
        """,
        insert_rows,
    )

    num_clusters = len({c for c in cluster_ids if c != -1})
    noise_count = int((cluster_ids == -1).sum())
    meta_val = json.dumps({
        "model": model,
        "count": len(insert_rows),
        "clusters": num_clusters,
        "outliers": noise_count,
        "mean_outlier_score": float(np.mean(outlier_scores)),
        "max_outlier_score": float(np.max(outlier_scores)),
        "min_outlier_score": float(np.min(outlier_scores)),
    }, separators=(",", ":"))

    cursor.execute(
        "INSERT OR REPLACE INTO annotation_meta (key, value, updated_at) VALUES (?, ?, ?)",
        ("latent_space_atlas", meta_val, now),
    )

    conn.commit()
    conn.close()
    print(f"Finished {db_path}: {len(insert_rows)} genes, {num_clusters} clusters, {noise_count} outliers.")


def main():
    parser = argparse.ArgumentParser(description="Precompute Pan-Phage Latent Space Atlas UMAP coords and HDBSCAN clusters.")
    parser.add_argument("--database", default="phage.db", help="Path to SQLite database")
    parser.add_argument("--web-database", default="packages/web/public/phage.db", help="Path to web SQLite database")
    parser.add_argument("--model", default="facebook/esm2_t6_8M_UR50D", help="ESM-2 model name")
    args = parser.parse_args()

    import os
    if os.path.exists(args.database):
        process_database(args.database, args.model)
    if os.path.exists(args.web_database) and os.path.abspath(args.database) != os.path.abspath(args.web_database):
        process_database(args.web_database, args.model)


if __name__ == "__main__":
    main()
