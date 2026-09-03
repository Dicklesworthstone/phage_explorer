/**
 * packages/core/src/embedding-index.ts
 *
 * Reusable in-memory vector index for cosine nearest-neighbor search.
 * Designed for protein fold embeddings (ESM2 320d, k-mer hash, etc.).
 */

export interface IndexedEmbedding<T = Record<string, unknown>> {
  id: string | number;
  vector: Float32Array | number[];
  metadata?: T;
}

export interface NearestNeighborHit<T = Record<string, unknown>> {
  id: string | number;
  distance: number; // Cosine distance: 1 - cosine_similarity in [0, 2]
  similarity: number; // Cosine similarity in [-1, 1]
  metadata?: T;
}

export class EmbeddingIndex<T = Record<string, unknown>> {
  private items: Array<{
    id: string | number;
    vector: Float32Array;
    norm: number;
    metadata?: T;
  }> = [];

  private idMap = new Map<string | number, number>();

  /**
   * Add a single embedding vector to the index.
   */
  public add(id: string | number, vector: Float32Array | number[], metadata?: T): void {
    const floatVec = vector instanceof Float32Array ? vector : new Float32Array(vector);
    let normSq = 0;
    for (let i = 0; i < floatVec.length; i++) {
      normSq += floatVec[i] * floatVec[i];
    }
    const norm = Math.sqrt(normSq) || 1e-12;

    const entry = {
      id,
      vector: floatVec,
      norm,
      metadata,
    };

    const existingIdx = this.idMap.get(id);
    if (existingIdx !== undefined) {
      this.items[existingIdx] = entry;
    } else {
      this.idMap.set(id, this.items.length);
      this.items.push(entry);
    }
  }

  /**
   * Add multiple embeddings to the index in batch.
   */
  public addMany(items: Array<IndexedEmbedding<T>>): void {
    for (const item of items) {
      this.add(item.id, item.vector, item.metadata);
    }
  }

  /**
   * Search for the k nearest neighbors to a query vector.
   *
   * @param query Vector to search against.
   * @param k Maximum number of neighbors to return (default: 5).
   * @param maxDistance Maximum cosine distance threshold to include.
   */
  public search(
    query: Float32Array | number[],
    k = 5,
    maxDistance = Infinity
  ): Array<NearestNeighborHit<T>> {
    if (this.items.length === 0 || k <= 0) {
      return [];
    }

    const qVec = query instanceof Float32Array ? query : new Float32Array(query);
    let qNormSq = 0;
    for (let i = 0; i < qVec.length; i++) {
      qNormSq += qVec[i] * qVec[i];
    }
    const qNorm = Math.sqrt(qNormSq) || 1e-12;

    const hits: Array<NearestNeighborHit<T>> = [];

    for (let i = 0; i < this.items.length; i++) {
      const item = this.items[i];
      const len = Math.min(qVec.length, item.vector.length);

      let dot = 0;
      for (let j = 0; j < len; j++) {
        dot += qVec[j] * item.vector[j];
      }

      const similarity = dot / (qNorm * item.norm);
      const distance = Math.max(0, 1 - similarity);

      if (distance <= maxDistance) {
        hits.push({
          id: item.id,
          distance,
          similarity,
          metadata: item.metadata,
        });
      }
    }

    hits.sort((a, b) => a.distance - b.distance);
    return hits.slice(0, k);
  }

  /**
   * Number of items in the index.
   */
  public size(): number {
    return this.items.length;
  }

  /**
   * Clear all items from the index.
   */
  public clear(): void {
    this.items = [];
    this.idMap.clear();
  }

  /**
   * Check if index contains an item by ID.
   */
  public has(id: string | number): boolean {
    return this.idMap.has(id);
  }

  /**
   * Static helper to compute cosine distance between two vectors.
   */
  public static cosineDistance(a: Float32Array | number[], b: Float32Array | number[]): number {
    const len = Math.min(a.length, b.length);
    let dot = 0;
    let na = 0;
    let nb = 0;
    for (let i = 0; i < len; i++) {
      dot += a[i] * b[i];
      na += a[i] * a[i];
      nb += b[i] * b[i];
    }
    const denom = Math.sqrt(na) * Math.sqrt(nb) || 1e-12;
    return Math.max(0, 1 - dot / denom);
  }
}
