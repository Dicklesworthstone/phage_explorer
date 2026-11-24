/** Portable explorer positions. Files carry identities and coordinates, never genome bases. */
import type { PhageFull } from './types';
import type { LocalGenomeView } from './genome-import';
import { GENOME_IMPORT_LIMITS } from './genome-import';
import { analysisJson } from './analysis-result';

export const SAVED_VIEW_LIMITS = { history: 64, saved: 64, bytes: 1024 * 1024, timeoutMs: 15000, scrollBurstMs: 300 } as const;
export interface SavedViewPosition extends LocalGenomeView { geneId: number | null }
export interface SavedViewSource {
  kind: 'catalog' | 'local'; contentId: string; name: string; accession: string; slug: string | null;
  bases: number; sequenceSha256: string; fingerprint: string;
}
export interface SavedView { source: SavedViewSource; view: SavedViewPosition }
export interface NamedSavedView extends SavedView { name: string }
export interface SavedViewCollection { format: 'phage-explorer-saved-views'; version: 1; views: NamedSavedView[] }
const digest = (value: unknown): value is string => typeof value === 'string' && /^[a-f0-9]{64}$/.test(value);
function object(value: unknown): value is Record<string, unknown> { return !!value && typeof value === 'object' && !Array.isArray(value); }
function keys(value: Record<string, unknown>, expected: string[]): void {
  if (Object.keys(value).sort().join('|') !== expected.sort().join('|')) throw new Error('Unsupported saved-view fields.');
}
export function validateSavedViewName(value: unknown): asserts value is string {
  if (typeof value !== 'string' || !value.trim() || value.length > 120 || /[\u0000-\u001f\u007f-\u009f]/.test(value)) {
    throw new Error('Name a view with 1–120 printable characters.');
  }
}

/** Keep this canonical identity identical across browser Web Crypto and terminal hashing. */
export function savedViewIdentity(phage: PhageFull, bases: number, sequenceSha256: string): string {
  if (!Number.isSafeInteger(bases) || bases < 1 || bases > GENOME_IMPORT_LIMITS.bases || bases !== phage.genomeLength
    || !Array.isArray(phage.genes) || phage.genes.length > GENOME_IMPORT_LIMITS.features || !digest(sequenceSha256)) {
    throw new Error('Navigation requires a complete genome of at most 5,000,000 bases and 50,000 features.');
  }
  if (phage.localGenome && (!digest(phage.localGenome.contentId) || sequenceSha256 !== phage.localGenome.sequenceSha256)) {
    throw new Error('The local genome bases no longer match the accepted input. Reimport the original file or bundle.');
  }
  const content = JSON.stringify(analysisJson({ kind: phage.localGenome ? 'local' : 'catalog', localContentId: phage.localGenome?.contentId ?? null,
    name: phage.name, accession: phage.accession, slug: phage.slug, bases, sequenceSha256, genes: phage.genes }));
  if (new TextEncoder().encode(content).length > GENOME_IMPORT_LIMITS.bytes) throw new Error('Genome annotations exceed the saved-view identity limit.');
  return content;
}
export function savedViewSource(phage: PhageFull, bases: number, sequenceSha256: string, fingerprint: string): SavedViewSource {
  return { kind: phage.localGenome ? 'local' : 'catalog', contentId: phage.localGenome?.contentId ?? fingerprint,
    name: phage.name, accession: phage.accession, slug: phage.slug, bases, sequenceSha256, fingerprint };
}

export function validateNamedSavedView(value: unknown): asserts value is NamedSavedView {
  if (!object(value)) throw new Error('Invalid saved view.');
  keys(value, ['name', 'source', 'view']); validateSavedViewName(value.name);
  const source = value.source;
  if (!object(source)) throw new Error('Saved view has no source identity.');
  keys(source, ['kind', 'contentId', 'name', 'accession', 'slug', 'bases', 'sequenceSha256', 'fingerprint']);
  if (!['catalog', 'local'].includes(source.kind as string) || !digest(source.contentId) || !digest(source.sequenceSha256)
    || !digest(source.fingerprint) || source.kind === 'catalog' && source.contentId !== source.fingerprint
    || ['name', 'accession'].some(key => typeof source[key] !== 'string' || !(source[key] as string).length || (source[key] as string).length > 2000)
    || !(source.slug === null || typeof source.slug === 'string' && source.slug.length <= 2000)
    || !Number.isSafeInteger(source.bases) || Number(source.bases) < 1 || Number(source.bases) > GENOME_IMPORT_LIMITS.bases) {
    throw new Error('Invalid saved-view source identity.');
  }
  const view = value.view;
  if (!object(view)) throw new Error('Invalid saved-view position.');
  keys(view, ['contentId', 'geneId', 'viewMode', 'readingFrame', 'scrollPosition']);
  if (view.contentId !== source.contentId || !['dna', 'aa', 'dual'].includes(view.viewMode as string)
    || ![0, 1, 2, -1, -2, -3].includes(view.readingFrame as number)
    || !(view.geneId === null || Number.isSafeInteger(view.geneId) && Number(view.geneId) > 0 && Number(view.geneId) <= 50000)
    || !Number.isSafeInteger(view.scrollPosition) || Number(view.scrollPosition) < 0
    || Number(view.scrollPosition) >= (view.viewMode === 'aa' ? Math.ceil(Number(source.bases) / 3) : Number(source.bases))) {
    throw new Error('Saved view lies outside its exact genome or residue coordinates.');
  }
}
export function parseSavedViews(content: string): SavedViewCollection {
  if (typeof content !== 'string' || content.length > SAVED_VIEW_LIMITS.bytes
    || new TextEncoder().encode(content).length > SAVED_VIEW_LIMITS.bytes) throw new Error('Saved views exceed the 1 MiB limit.');
  const value: unknown = JSON.parse(content);
  if (!object(value)) throw new Error('Invalid saved-view collection.');
  keys(value, ['format', 'version', 'views']);
  if (value.format !== 'phage-explorer-saved-views' || value.version !== 1 || !Array.isArray(value.views)
    || value.views.length > SAVED_VIEW_LIMITS.saved) throw new Error('Expected a version 1 collection of at most 64 saved views.');
  value.views.forEach(validateNamedSavedView);
  if (new Set(value.views.map(view => view.name)).size !== value.views.length) throw new Error('Saved-view names must be distinct.');
  return value as unknown as SavedViewCollection;
}
export function serializeSavedViews(views: readonly NamedSavedView[]): string {
  const content = JSON.stringify({ format: 'phage-explorer-saved-views', version: 1, views });
  parseSavedViews(content); return content;
}
