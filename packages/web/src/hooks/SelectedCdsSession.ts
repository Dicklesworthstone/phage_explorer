import { analysisJson, type GeneInfo, type PhageFull } from '@phage-explorer/core';
import { extractCdsReferenceDna, reconstructCdsReference, type CdsReference } from '../../../core/src/analysis/cds-consequences';
import { formatFasta } from '../utils/export';

/** The complete selection already accepted by PhageSelectionSession. */
export interface SelectedCdsSource {
  owner: object;
  phage: PhageFull;
  sequence: string;
}

export interface SelectedCdsResult {
  format: 'phage-explorer-selected-cds';
  version: 1;
  source: {
    kind: 'local' | 'catalog';
    phageId: number;
    name: string;
    accession: string;
    genomeLength: number;
    genomeSha256: string;
    localContentId: string | null;
  };
  gene: GeneInfo;
  /** Original genome coordinates, 0-based half-open, in transcript order after codon_start. */
  segments: CdsReference['segments'];
  codonStart: number;
  geneticCode: number;
  cds: string | null;
  protein: string | null;
  cdsSha256: string | null;
  proteinSha256: string | null;
  extractionReasons: string[];
  translationReasons: string[];
  resultId: string;
}

export type SelectedCdsExportKind = 'cds' | 'protein' | 'json';
export interface SelectedCdsExport { content: string; filename: string; mimeType: string }
export interface SelectedCdsSnapshot {
  source: SelectedCdsSource | null;
  gene: GeneInfo | null;
  loading: boolean;
  result: SelectedCdsResult | null;
  error: string | null;
}

async function sha256(value: string): Promise<string> {
  const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(value));
  return Array.from(new Uint8Array(digest), byte => byte.toString(16).padStart(2, '0')).join('');
}

/** Clone annotations before hashing so asynchronous work cannot acquire another gene's labels. */
export async function prepareSelectedCds(source: SelectedCdsSource, selected: GeneInfo): Promise<SelectedCdsResult> {
  if (!source.phage.genes.includes(selected)) throw new Error('This gene does not belong to the accepted genome selection.');
  const gene = structuredClone(selected);
  const genome = source.sequence.toUpperCase();
  const identity = {
    kind: source.phage.localGenome ? 'local' as const : 'catalog' as const,
    phageId: source.phage.id, name: source.phage.name, accession: source.phage.accession,
    genomeLength: genome.length, localContentId: source.phage.localGenome?.contentId ?? null,
  };
  const expectedHash = source.phage.localGenome?.sequenceSha256;
  if (!genome.length || source.phage.genomeLength !== genome.length || !/^[ACGTRYSWKMBDHVN]+$/.test(genome)) {
    throw new Error('A complete matching genome sequence is required to inspect this CDS.');
  }

  const extractionReasons: string[] = [];
  if (gene.type?.toUpperCase() !== 'CDS') extractionReasons.push('This feature is not annotated as a CDS.');
  const extracted = extractCdsReferenceDna(gene, genome);
  if (extracted.cds === null) extractionReasons.push(...extracted.reasons);
  const translated = reconstructCdsReference(gene, genome);
  const cds = extractionReasons.length ? null : extracted.cds;
  const translationReasons = [...new Set([...extractionReasons, ...extracted.reasons, ...translated.reasons])];
  const protein = translationReasons.length ? null : translated.protein;
  const [genomeSha256, cdsSha256, proteinSha256] = await Promise.all([
    sha256(genome), cds === null ? null : sha256(cds), protein === null ? null : sha256(protein),
  ]);
  if (identity.kind === 'local' && genomeSha256 !== expectedHash) throw new Error('The local genome fingerprint does not match its accepted sequence.');
  const content = {
    format: 'phage-explorer-selected-cds' as const, version: 1 as const,
    source: { ...identity, genomeSha256 }, gene,
    segments: cds === null ? [] : extracted.segments,
    codonStart: translated.codonStart, geneticCode: translated.geneticCode,
    cds, protein, cdsSha256, proteinSha256, extractionReasons, translationReasons,
  };
  const resultId = await sha256(JSON.stringify(analysisJson(content)));
  return { ...content, resultId };
}

/** Each segment is displayed in biological order; no span between joined parts is implied. */
export function selectedCdsLocation(result: Pick<SelectedCdsResult, 'segments'>): string {
  return result.segments.map(part => `${part.start + 1}..${part.end}(${part.strand})`).join(', ');
}

export function selectedCdsExport(result: SelectedCdsResult, kind: SelectedCdsExportKind): SelectedCdsExport | null {
  const label = result.gene.locusTag || result.gene.name || `gene-${result.gene.id}`;
  const stem = `${result.source.accession}-${label}`.replace(/[^a-zA-Z0-9._-]+/g, '-').slice(0, 120);
  const filename = `${stem}-${result.resultId.slice(0, 12)}`;
  if (kind === 'json') return { content: JSON.stringify(result, null, 2) + '\n', filename: `${filename}.cds.json`, mimeType: 'application/json' };
  const sequence = kind === 'cds' ? result.cds : result.protein;
  if (sequence === null || kind === 'protein' && result.translationReasons.length > 0) return null;
  // Values are escaped tokens, so imported labels cannot inject another FASTA record.
  const token = (value: string | number) => encodeURIComponent(String(value));
  const header = `${token(result.source.accession)}|${token(label)}|${kind}`
    + ` gene_id=${result.gene.id} source=${result.source.kind} genome_sha256=${result.source.genomeSha256}`
    + ` sequence_sha256=${kind === 'cds' ? result.cdsSha256 : result.proteinSha256}`
    + ` location_1based=${token(selectedCdsLocation(result))} codon_start=${result.codonStart} transl_table=${result.geneticCode}`
    + ` translation=${result.protein === null ? 'unavailable' : 'available'} result_id=${result.resultId}`;
  return { content: formatFasta(header, sequence) + '\n', filename: `${filename}.${kind === 'cds' ? 'fna' : 'faa'}`, mimeType: 'text/plain' };
}

function wait<T>(work: Promise<T>, signal: AbortSignal): Promise<T> {
  return new Promise((resolve, reject) => {
    const abort = () => reject(new DOMException('Selected CDS changed.', 'AbortError'));
    signal.addEventListener('abort', abort, { once: true });
    void work.then(resolve, reject).finally(() => signal.removeEventListener('abort', abort));
    if (signal.aborted) abort();
  });
}

/** A source and gene replacement retires every old preview/export before hashing completes. */
export class SelectedCdsSession {
  private snapshot: SelectedCdsSnapshot = { source: null, gene: null, loading: false, result: null, error: null };
  private controller: AbortController | null = null;
  private readonly listeners = new Set<() => void>();
  constructor(private readonly prepare = prepareSelectedCds) {}
  getSnapshot = (): SelectedCdsSnapshot => this.snapshot;
  subscribe = (listener: () => void): (() => void) => {
    this.listeners.add(listener);
    return () => { this.listeners.delete(listener); };
  };
  private publish(next: SelectedCdsSnapshot): void {
    this.snapshot = next;
    for (const listener of [...this.listeners]) if (this.listeners.has(listener)) listener();
  }
  clear = (): void => {
    this.controller?.abort();
    this.controller = null;
    this.publish({ source: null, gene: null, loading: false, result: null, error: null });
  };
  select = async (source: SelectedCdsSource, gene: GeneInfo): Promise<boolean> => {
    this.controller?.abort();
    const controller = new AbortController();
    this.controller = controller;
    this.publish({ source, gene, loading: true, result: null, error: null });
    try {
      if (this.controller !== controller || controller.signal.aborted) return false;
      const result = await wait(this.prepare(source, gene), controller.signal);
      if (this.controller !== controller || controller.signal.aborted) return false;
      this.controller = null;
      this.publish({ source, gene, loading: false, result, error: null });
      return true;
    } catch (cause) {
      if (this.controller !== controller || controller.signal.aborted) return false;
      this.controller = null;
      this.publish({ source, gene, loading: false, result: null,
        error: cause instanceof Error ? cause.message : 'This CDS could not be prepared. Retry the inspection.' });
      return false;
    }
  };
  export(kind: SelectedCdsExportKind, source: SelectedCdsSource, gene: GeneInfo): SelectedCdsExport | null {
    return this.snapshot.source === source && this.snapshot.gene === gene && this.snapshot.result
      ? selectedCdsExport(this.snapshot.result, kind) : null;
  }
}
