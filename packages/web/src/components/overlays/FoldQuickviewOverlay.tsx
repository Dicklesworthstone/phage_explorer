/**
 * FoldQuickviewOverlay
 *
 * Web port of the TUI FoldQuickview: shows per-gene embedding novelty and nearest neighbors.
 *
 * Embedding sources:
 * - Preferred: repository.getFoldEmbeddings() when the DB has fold_embeddings populated.
 * - Fallback: on-the-fly lightweight protein k-mer hash embeddings computed from sequences.
 */

import React, { useEffect, useMemo, useState } from 'react';
import type { PhageFull, FoldEmbedding, GeneInfo } from '@phage-explorer/core';
import {
  buildEmbeddingMap,
  computeNovelty,
  computeProteinSelfSimilarityMatrix,
} from '@phage-explorer/core';
import { reconstructCdsReference } from '../../../../core/src/analysis/cds-consequences';
import type { PhageRepository } from '../../db';
import { useTheme } from '../../hooks/useTheme';
import { useHotkey } from '../../hooks/useHotkey';
import { ActionIds, getKeyboardManager, type HotkeyDefinition } from '../../keyboard';
import { Overlay } from './Overlay';
import { useIsTopOverlay, useOverlay } from './OverlayProvider';

const EMBEDDING_MODEL = 'facebook/esm2_t6_8M_UR50D';
const FALLBACK_EMBEDDING_MODEL = 'protein-k3-hash-v1';

function heatmap(matrix: Float32Array, bins: number, gradient = ' .:-=+*#%@'): string {
  if (bins <= 0) return '';
  const lines: string[] = [];
  for (let y = 0; y < bins; y++) {
    let line = '';
    for (let x = 0; x < bins; x++) {
      const v = matrix[y * bins + x] ?? 0;
      const idx = Math.min(
        gradient.length - 1,
        Math.max(0, Math.round(v * (gradient.length - 1)))
      );
      line += gradient[idx];
    }
    lines.push(line);
  }
  return lines.join('\n');
}

function proteinKmerHashEmbedding(aa: string, options?: { k?: number; dims?: number }): number[] {
  const k = options?.k ?? 3;
  const dims = options?.dims ?? 256;
  const vec = new Array<number>(dims).fill(0);
  const seq = aa.toUpperCase();
  if (seq.length < k) return vec;

  for (let i = 0; i <= seq.length - k; i++) {
    let hash = 2166136261; // FNV-1a
    for (let j = 0; j < k; j++) {
      const code = seq.charCodeAt(i + j);
      // Skip kmers containing stop/unknowns.
      if (code < 65 || code > 90 || code === 42) {
        hash = 0;
        break;
      }
      hash ^= code;
      hash = Math.imul(hash, 16777619);
    }
    if (hash === 0) continue;
    vec[(hash >>> 0) % dims] += 1;
  }

  let norm = 0;
  for (const v of vec) norm += v * v;
  norm = Math.sqrt(norm) || 1;
  for (let i = 0; i < vec.length; i++) vec[i] /= norm;
  return vec;
}

export async function computeEmbeddingsForPhage(args: {
  repository: PhageRepository;
  phageId: number;
  model: string;
}): Promise<FoldEmbedding[]> {
  const { repository, phageId, model } = args;

  const length = await repository.getFullGenomeLength(phageId);
  const [genome, genes] = await Promise.all([
    repository.getSequenceWindow(phageId, 0, length),
    repository.getGenes(phageId),
  ]);

  const embeddings: FoldEmbedding[] = [];
  for (const gene of genes) {
    if (gene.type !== 'CDS') continue;
    const cds = reconstructCdsReference(gene, genome);
    if (cds.reasons.length > 0 || !cds.protein) continue;
    const aa = cds.protein.replace(/\*$/, '');
    // A terminal stop is not a residue; fewer than three residues have no 3-mers.
    if (aa.length < 3) continue;
    embeddings.push({
      geneId: gene.id,
      vector: proteinKmerHashEmbedding(aa, { k: 3, dims: 256 }),
      length: aa.length,
      name: gene.name ?? null,
      product: gene.product ?? null,
    });
  }

  // Tag by model via the caller's selection (kept separate for UI messaging).
  // The FoldEmbedding type itself doesn't include model metadata.
  void model;

  return embeddings;
}

async function loadEmbeddingCorpus(args: {
  repository: PhageRepository;
  model: string;
}): Promise<{ embeddings: FoldEmbedding[]; source: 'db' | 'computed' }> {
  const { repository, model } = args;

  // 1) Prefer DB-backed embeddings when present.
  if (repository.getFoldEmbeddings) {
    const phages = (await repository.listPhages()).filter((phage) => !phage.localGenome);
    const byDb = await Promise.all(phages.map((p) => repository.getFoldEmbeddings?.(p.id, model) ?? Promise.resolve([])));
    const flattened = byDb.flat();
    if (flattened.length > 0) {
      return { embeddings: flattened, source: 'db' };
    }
  }

  // 2) Fallback: compute lightweight embeddings on demand from sequences.
  const phages = (await repository.listPhages()).filter((phage) => !phage.localGenome);
  const computed = await Promise.all(phages.map((p) => computeEmbeddingsForPhage({ repository, phageId: p.id, model })));
  return { embeddings: computed.flat(), source: 'computed' };
}

function getLabelForGene(gene: GeneInfo): string {
  return gene.name || gene.product || gene.locusTag || `Gene ${gene.id}`;
}

function clampIndex(index: number, length: number): number {
  if (length <= 0) return 0;
  return Math.max(0, Math.min(length - 1, index));
}

interface FoldQuickviewOverlayProps {
  repository: PhageRepository | null;
  currentPhage: PhageFull | null;
}

export function FoldQuickviewOverlay({
  repository,
  currentPhage,
}: FoldQuickviewOverlayProps): React.ReactElement | null {
  const { theme } = useTheme();
  const colors = theme.colors;
  const { isOpen, toggle } = useOverlay();
  const isTopmost = useIsTopOverlay('foldQuickview');
  const overlayOpen = isOpen('foldQuickview');
  const shouldCaptureHotkeys = overlayOpen && isTopmost;
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [loadedCorpus, setLoadedCorpus] = useState<{
    repository: PhageRepository;
    embeddings: FoldEmbedding[];
    source: 'db' | 'computed';
  } | null>(null);
  const corpus = loadedCorpus && loadedCorpus.repository === repository ? loadedCorpus.embeddings : [];
  const corpusSource = loadedCorpus && loadedCorpus.repository === repository ? loadedCorpus.source : 'computed';
  const [selectedGeneIdx, setSelectedGeneIdx] = useState(0);

  // Numeric gene/phage IDs are meaningful only within their repository snapshot.
  const corpusCache = useMemo(
    () => new Map<string, { embeddings: FoldEmbedding[]; source: 'db' | 'computed' }>(),
    [repository]
  );
  const genomeCache = useMemo(() => new WeakMap<PhageFull, string>(), [repository]);
  const [loadedGenome, setLoadedGenome] = useState<{
    repository: PhageRepository;
    phage: PhageFull;
    sequence: string;
  } | null>(null);
  const genome = loadedGenome && loadedGenome.repository === repository && loadedGenome.phage === currentPhage
    ? loadedGenome.sequence : '';
  const [genomeLoading, setGenomeLoading] = useState(false);
  const [genomeError, setGenomeError] = useState<string | null>(null);

  useHotkey(
    ActionIds.OverlayFoldQuickview,
    () => toggle('foldQuickview'),
    { modes: ['NORMAL'] }
  );

  // Load embeddings when opened.
  useEffect(() => {
    if (!overlayOpen) return;
    if (!repository || !currentPhage || currentPhage.localGenome) {
      setLoadedCorpus(null);
      setError(null);
      setLoading(false);
      return;
    }

    const cacheKey = `model:${EMBEDDING_MODEL}`;
    const cached = corpusCache.get(cacheKey);
    if (cached) {
      setLoadedCorpus({ repository, ...cached });
      setError(null);
      setLoading(false);
      return;
    }

    let cancelled = false;
    setLoading(true);
    setError(null);

    void (async () => {
      try {
        const loaded = await loadEmbeddingCorpus({ repository, model: EMBEDDING_MODEL });
        if (cancelled) return;
        corpusCache.set(cacheKey, loaded);
        setLoadedCorpus({ repository, ...loaded });
      } catch (err) {
        if (cancelled) return;
        setError(err instanceof Error ? err.message : 'Failed to load embeddings');
        setLoadedCorpus(null);
      } finally {
        if (cancelled) return;
        setLoading(false);
      }
    })();

    return () => { cancelled = true; };
  }, [currentPhage, overlayOpen, repository, corpusCache]);

  // Load the exact current snapshot for the protein thumbnail.
  useEffect(() => {
    if (!overlayOpen) return;
    if (!repository || !currentPhage || currentPhage.localGenome) {
      setLoadedGenome(null);
      setGenomeError(null);
      setGenomeLoading(false);
      return;
    }

    const cached = genomeCache.get(currentPhage);
    if (cached !== undefined) {
      setLoadedGenome({ repository, phage: currentPhage, sequence: cached });
      setGenomeError(null);
      setGenomeLoading(false);
      return;
    }

    let cancelled = false;
    setGenomeLoading(true);
    setGenomeError(null);

    void (async () => {
      try {
        const length = await repository.getFullGenomeLength(currentPhage.id);
        if (cancelled) return;
        const seq = await repository.getSequenceWindow(currentPhage.id, 0, length);
        if (cancelled) return;
        genomeCache.set(currentPhage, seq);
        setLoadedGenome({ repository, phage: currentPhage, sequence: seq });
      } catch (err) {
        if (cancelled) return;
        setLoadedGenome(null);
        setGenomeError(err instanceof Error ? err.message : 'Failed to load genome');
      } finally {
        if (cancelled) return;
        setGenomeLoading(false);
      }
    })();

    return () => { cancelled = true; };
  }, [currentPhage, overlayOpen, repository, genomeCache]);

  // Reset selection when the source snapshot changes or the overlay opens.
  useEffect(() => {
    if (!overlayOpen) return;
    setSelectedGeneIdx(0);
  }, [currentPhage, repository, overlayOpen]);

  const genesWithEmbeddings = useMemo(() => {
    const phageGenes = currentPhage?.genes ?? [];
    if (currentPhage?.localGenome || phageGenes.length === 0 || corpus.length === 0) return [];
    const map = buildEmbeddingMap(corpus);
    return phageGenes
      .filter((g) => g.type === 'CDS' && map.has(g.id))
      .map((g) => ({ gene: g, embedding: map.get(g.id)! }));
  }, [currentPhage?.genes, currentPhage?.localGenome, corpus]);

  const selected = genesWithEmbeddings[clampIndex(selectedGeneIdx, genesWithEmbeddings.length)];
  const novelty = useMemo(() => {
    if (!selected) return null;
    return computeNovelty(selected.embedding, corpus, 8);
  }, [selected, corpus]);

  const selectedCds = useMemo(() => {
    if (!selected || !genome) return null;
    return reconstructCdsReference(selected.gene, genome);
  }, [genome, selected]);
  const selectedAa = selectedCds && selectedCds.reasons.length === 0
    ? selectedCds.protein?.replace(/\*$/, '') ?? null : null;
  const thumbnailUnavailable = selectedCds?.reasons.length
    ? selectedCds.reasons.join(' ')
    : selectedAa !== null && selectedAa.length < 3
      ? 'At least three amino-acid residues are required for a 3-mer thumbnail.' : null;

  const selfSimilarity = useMemo(() => {
    if (!selectedAa || selectedAa.length < 3) return null;
    const sim = computeProteinSelfSimilarityMatrix(selectedAa, { k: 3 });
    if (sim.bins <= 0) return null;
    return heatmap(sim.matrix, sim.bins);
  }, [selectedAa]);

  // Arrow navigation (when open).
  useEffect(() => {
    if (!shouldCaptureHotkeys) return;
    if (genesWithEmbeddings.length === 0) return;
    if (typeof window === 'undefined') return;

    const manager = getKeyboardManager();
    const total = genesWithEmbeddings.length;

    const definitions: HotkeyDefinition[] = [
      {
        combo: { key: 'ArrowUp' },
        description: 'Fold quickview: previous gene',
        action: () => setSelectedGeneIdx((idx) => clampIndex(idx - 1, total)),
        modes: ['NORMAL'],
        priority: 10,
      },
      {
        combo: { key: 'ArrowDown' },
        description: 'Fold quickview: next gene',
        action: () => setSelectedGeneIdx((idx) => clampIndex(idx + 1, total)),
        modes: ['NORMAL'],
        priority: 10,
      },
    ];

    const unregister = manager.registerMany(definitions);
    return unregister;
  }, [genesWithEmbeddings.length, shouldCaptureHotkeys]);

  const title = currentPhage ? `Fold Quickview — ${currentPhage.name}` : 'Fold Quickview';

  const noveltyPct = novelty ? Math.round(novelty.novelty * 1000) / 10 : 0;
  const noveltyWidth = novelty ? `${Math.round(novelty.novelty * 100)}%` : '0%';

  return (
    <Overlay id="foldQuickview" title={title} hotkey="Alt+Shift+F" size="lg">
      <div style={{ display: 'flex', flexDirection: 'column', gap: '0.75rem' }}>
        <div style={{ color: colors.textMuted, fontFamily: 'monospace', fontSize: '0.85rem' }}>
          ↑/↓ selects a gene. Novelty is mean cosine distance to the nearest neighbors (higher = more novel).
        </div>

        {!currentPhage?.localGenome && corpusSource === 'computed' && (
          <div style={{ color: colors.textMuted, fontSize: '0.85rem' }}>
            Using lightweight on-the-fly embeddings ({FALLBACK_EMBEDDING_MODEL}) from supported, unambiguous annotated CDS translations with at least three residues. Run `bun run build:esm2` to add ESM2 embeddings to the database.
          </div>
        )}

        {error && (
          <div style={{ color: colors.error, fontFamily: 'monospace' }}>
            {error}
          </div>
        )}

        {currentPhage?.localGenome ? (
          <div style={{ color: colors.textMuted, fontFamily: 'monospace' }}>
            Reference embeddings unavailable for this local genome. Imported gene IDs are local to the record and cannot identify catalog embeddings.
          </div>
        ) : loading ? (
          <div style={{ color: colors.textMuted, fontFamily: 'monospace' }}>Loading embeddings…</div>
        ) : genesWithEmbeddings.length === 0 ? (
          <div style={{ color: colors.textMuted, fontFamily: 'monospace' }}>
            No embeddings available for this phage.
          </div>
        ) : (
          <div style={{ display: 'grid', gridTemplateColumns: '1fr 1.2fr', gap: '1rem', alignItems: 'start' }}>
            {/* Gene list */}
            <div style={{ border: `1px solid ${colors.border}`, borderRadius: 8, overflow: 'hidden' }}>
              <div style={{ padding: '0.5rem 0.75rem', background: colors.backgroundAlt, fontWeight: 700 }}>
                Genes
              </div>
              <div style={{ maxHeight: 320, overflow: 'auto' }}>
                {genesWithEmbeddings.map(({ gene }, idx) => {
                  const active = idx === clampIndex(selectedGeneIdx, genesWithEmbeddings.length);
                  return (
                    <button
                      key={gene.id}
                      type="button"
                      onClick={() => setSelectedGeneIdx(idx)}
                      style={{
                        width: '100%',
                        textAlign: 'left',
                        padding: '0.5rem 0.75rem',
                        border: 'none',
                        background: active ? `${colors.accent}22` : 'transparent',
                        color: active ? colors.text : colors.textMuted,
                        cursor: 'pointer',
                        fontFamily: 'monospace',
                        fontSize: '0.85rem',
                      }}
                    >
                      {active ? '▶ ' : '  '}
                      {getLabelForGene(gene)}
                    </button>
                  );
                })}
              </div>
            </div>

            {/* Result */}
            <div style={{ border: `1px solid ${colors.border}`, borderRadius: 8, padding: '0.75rem' }}>
              <div style={{ display: 'flex', justifyContent: 'space-between', gap: '0.75rem', alignItems: 'baseline' }}>
                <div style={{ fontWeight: 800 }}>{selected ? getLabelForGene(selected.gene) : '—'}</div>
                <div style={{ color: colors.textMuted, fontFamily: 'monospace' }}>
                  Novelty: {novelty ? `${noveltyPct}%` : '—'}
                </div>
              </div>

              <div style={{ height: 10, background: colors.borderLight, borderRadius: 999, overflow: 'hidden', marginTop: 8 }}>
                <div style={{ height: '100%', width: noveltyWidth, background: colors.accent }} />
              </div>

              {novelty && (
                <>
                  <div style={{ marginTop: 12, fontWeight: 700, color: colors.text }}>
                    Nearest neighbors
                  </div>
                  <div style={{ marginTop: 6, display: 'flex', flexDirection: 'column', gap: 6, fontFamily: 'monospace', fontSize: '0.85rem' }}>
                    {novelty.neighbors.map((n) => (
                      <div key={n.geneId} style={{ color: colors.textMuted }}>
                        • {(1 - n.distance).toFixed(2)} sim — {n.name || n.product || `Gene ${n.geneId}`}
                      </div>
                    ))}
                  </div>
                </>
              )}

              {selfSimilarity && (
                <div style={{ marginTop: 12 }}>
                  <div style={{ fontWeight: 700, color: colors.text }}>Self-similarity thumbnail</div>
                  <div style={{ color: colors.textMuted, fontFamily: 'monospace', fontSize: '0.85rem' }}>
                    k-mer similarity across the protein (not a physical contact map)
                  </div>
                  <pre
                    style={{
                      marginTop: 8,
                      marginBottom: 0,
                      padding: 8,
                      borderRadius: 8,
                      background: colors.backgroundAlt,
                      border: `1px solid ${colors.border}`,
                      color: colors.textMuted,
                      fontFamily: 'monospace',
                      fontSize: '0.75rem',
                      lineHeight: 1.1,
                      overflowX: 'auto',
                    }}
                  >
                    {selfSimilarity}
                  </pre>
                </div>
              )}

              {thumbnailUnavailable && (
                <div role="status" style={{ marginTop: 10, color: colors.textMuted, fontFamily: 'monospace', fontSize: '0.85rem' }}>
                  Protein thumbnail unavailable: {thumbnailUnavailable}
                </div>
              )}
              {!selfSimilarity && genomeLoading && (
                <div style={{ marginTop: 10, color: colors.textMuted, fontFamily: 'monospace', fontSize: '0.85rem' }}>
                  Loading genome for thumbnail…
                </div>
              )}
              {!selfSimilarity && genomeError && (
                <div style={{ marginTop: 10, color: colors.error, fontFamily: 'monospace', fontSize: '0.85rem' }}>
                  {genomeError}
                </div>
              )}
            </div>
          </div>
        )}
      </div>
    </Overlay>
  );
}

export default FoldQuickviewOverlay;
