import type { GeneInfo, PhageSummary, ReadingFrame, ViewMode } from '@phage-explorer/core';
import type { OverlayId } from '../components/overlays/OverlayProvider';

export const SHAREABLE_OVERLAY_IDS = [
  'complexity',
  'gcSkew',
  'bendability',
  'promoter',
  'repeats',
  'transcriptionFlow',
  'pressure',
  'selectionPressure',
  'modules',
  'hgt',
  'kmerAnomaly',
  'anomaly',
  'structureConstraint',
  'gel',
  'nonBDNA',
  'foldQuickview',
  'hilbert',
  'phasePortrait',
  'biasDecomposition',
  'crispr',
  'synteny',
  'dotPlot',
  'tropism',
  'cgr',
  'stability',
  'genomicSignaturePCA',
  'codonBias',
  'proteinDomains',
  'amgPathway',
  'codonAdaptation',
  'defenseArmsRace',
  'illustration',
  'prophageExcision',
  'mosaicRadar',
  'logo',
  'periodicity',
  'gpuWasmBenchmark',
  'cocktailCompatibility',
  'rnaStructure',
  'resistanceEvolution',
  'nicheNetwork',
  'phylodynamics',
  'epistasis',
  'environmentalProvenance',
] as const satisfies readonly OverlayId[];

export type ShareableOverlayId = (typeof SHAREABLE_OVERLAY_IDS)[number];

export interface ParsedShareState {
  phageKey: string | null;
  geneKey: string | null;
  viewMode: ViewMode | null;
  position: number | null;
  readingFrame: ReadingFrame | null;
  show3DModel: boolean | null;
  tool: ShareableOverlayId | null;
}

export interface ShareUrlState {
  phageKey: string;
  geneKey?: string | null;
  viewMode: ViewMode;
  position: number;
  readingFrame: ReadingFrame;
  show3DModel: boolean;
  tool?: ShareableOverlayId | null;
}

const VALID_VIEW_MODES = new Set<ViewMode>(['dna', 'aa', 'dual']);
const VALID_READING_FRAMES = new Set<ReadingFrame>([0, 1, 2, -1, -2, -3]);
const SHAREABLE_OVERLAY_BY_NORMALIZED = new Map<string, ShareableOverlayId>(
  SHAREABLE_OVERLAY_IDS.map((id) => [id.toLowerCase(), id])
);
const EMPTY_SHARE_STATE: ParsedShareState = Object.freeze({
  phageKey: null,
  geneKey: null,
  viewMode: null,
  position: null,
  readingFrame: null,
  show3DModel: null,
  tool: null,
});

let cachedInitialShareState: ParsedShareState | undefined;

function toUrl(input: string | URL): URL {
  if (input instanceof URL) return new URL(input.toString());
  return new URL(input, 'https://phage-explorer.org/');
}

function normalizeKey(value: string | null | undefined): string {
  return value?.trim().toLowerCase() ?? '';
}

function parseBoundedKey(value: string | null, maxLength: number): string | null {
  const trimmed = value?.trim() ?? '';
  return trimmed ? trimmed.slice(0, maxLength) : null;
}

function parsePosition(value: string | null): number | null {
  if (!value || !/^\d+$/.test(value)) return null;
  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed) || parsed < 0) return null;
  return parsed;
}

function parseReadingFrame(value: string | null): ReadingFrame | null {
  if (value === null || !/^-?\d+$/.test(value)) return null;
  const parsed = Number(value) as ReadingFrame;
  return VALID_READING_FRAMES.has(parsed) ? parsed : null;
}

function parseModelVisibility(value: string | null): boolean | null {
  if (value === null) return null;
  const normalized = value.trim().toLowerCase();
  if (normalized === '1' || normalized === 'true' || normalized === 'on') return true;
  if (normalized === '0' || normalized === 'false' || normalized === 'off') return false;
  return null;
}

export function isShareableOverlayId(value: unknown): value is ShareableOverlayId {
  if (typeof value !== 'string') return false;
  return SHAREABLE_OVERLAY_BY_NORMALIZED.has(value.trim().toLowerCase());
}

export function normalizeShareableOverlayId(value: string | null | undefined): ShareableOverlayId | null {
  if (!value) return null;
  return SHAREABLE_OVERLAY_BY_NORMALIZED.get(value.trim().toLowerCase()) ?? null;
}

export function parseShareState(input: string | URL): ParsedShareState {
  let url: URL;
  try {
    url = toUrl(input);
  } catch {
    return EMPTY_SHARE_STATE;
  }

  const rawViewMode = url.searchParams.get('view')?.trim().toLowerCase() ?? '';
  const viewMode = VALID_VIEW_MODES.has(rawViewMode as ViewMode)
    ? (rawViewMode as ViewMode)
    : null;

  return {
    phageKey: parseBoundedKey(url.searchParams.get('phage'), 128),
    geneKey: parseBoundedKey(url.searchParams.get('gene'), 128),
    viewMode,
    position: parsePosition(url.searchParams.get('pos')),
    readingFrame: parseReadingFrame(url.searchParams.get('frame')),
    show3DModel: parseModelVisibility(url.searchParams.get('model')),
    tool: normalizeShareableOverlayId(url.searchParams.get('tool')),
  };
}

export function getInitialShareState(): ParsedShareState {
  if (cachedInitialShareState) return cachedInitialShareState;
  if (typeof window === 'undefined') return EMPTY_SHARE_STATE;
  cachedInitialShareState = Object.freeze(parseShareState(window.location.href));
  return cachedInitialShareState;
}

export function findPhageIndex(phages: readonly PhageSummary[], phageKey: string | null | undefined): number {
  const normalized = normalizeKey(phageKey);
  if (!normalized) return -1;

  return phages.findIndex((phage) =>
    [phage.slug, phage.accession, String(phage.id), phage.name]
      .some((candidate) => normalizeKey(candidate) === normalized)
  );
}

export function getGeneShareKey(gene: GeneInfo | null | undefined): string | null {
  if (!gene) return null;
  const locusTag = gene.locusTag?.trim();
  if (locusTag) return locusTag;
  return String(gene.id);
}

export function findGeneId(
  genes: readonly GeneInfo[],
  geneKey: string | null | undefined
): number | null {
  const normalized = normalizeKey(geneKey);
  if (!normalized) return null;

  const match = genes.find((gene) =>
    [gene.locusTag, String(gene.id), gene.name]
      .some((candidate) => normalizeKey(candidate) === normalized)
  );
  return match?.id ?? null;
}

export function buildShareUrl(baseUrl: string | URL, state: ShareUrlState): string {
  const url = toUrl(baseUrl);
  url.search = '';
  url.hash = '';

  const phageKey = state.phageKey.trim();
  const geneKey = state.geneKey?.trim() ?? '';
  if (phageKey) url.searchParams.set('phage', phageKey);
  if (geneKey) url.searchParams.set('gene', geneKey);
  url.searchParams.set('view', state.viewMode);
  url.searchParams.set('pos', String(Math.max(0, Math.floor(state.position))));
  url.searchParams.set('frame', String(state.readingFrame));
  url.searchParams.set('model', state.show3DModel ? '1' : '0');
  if (state.tool) url.searchParams.set('tool', state.tool);

  return url.toString();
}
