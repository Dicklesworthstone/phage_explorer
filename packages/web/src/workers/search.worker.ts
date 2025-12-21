/**
 * Search Worker - Genomic search and feature lookup for SearchOverlay
 *
 * Runs in a Web Worker (Comlink) to keep the UI responsive while scanning
 * sequences for patterns, motifs, and feature metadata.
 */

import * as Comlink from 'comlink';
import type {
  SearchWorkerAPI,
  SearchRequest,
  SearchResponse,
  SearchHit,
  SearchFeature,
  StrandOption,
  SearchMode,
  FuzzyIndexRequest,
  FuzzySearchRequest,
  FuzzySearchResult,
  FuzzySearchEntry,
} from './types';

const IUPAC_MAP: Record<string, string> = {
  A: 'A',
  C: 'C',
  G: 'G',
  T: 'T',
  R: '[AG]',
  Y: '[CT]',
  M: '[AC]',
  K: '[GT]',
  S: '[CG]',
  W: '[AT]',
  H: '[ACT]',
  B: '[CGT]',
  V: '[ACG]',
  D: '[AGT]',
  N: '[ACGT]',
};

const DEFAULT_MAX_RESULTS = 500;

type FuzzyIndexEntry<TMeta = unknown> = FuzzySearchEntry<TMeta> & {
  textLower: string;
};

type FuzzyIndex<TMeta = unknown> = {
  entries: Array<FuzzyIndexEntry<TMeta>>;
  trigramIndex: Map<string, number[]>;
};

const fuzzyIndices = new Map<string, FuzzyIndex>();

function reverseComplement(seq: string): string {
  const map: Record<string, string> = { A: 'T', T: 'A', C: 'G', G: 'C', a: 't', t: 'a', c: 'g', g: 'c' };
  return seq
    .split('')
    .reverse()
    .map((c) => map[c] ?? c)
    .join('');
}

function toRegexFromIupac(pattern: string): RegExp {
  const normalized = pattern
    .toUpperCase()
    .split('')
    .map((c) => IUPAC_MAP[c] ?? c)
    .join('');
  return new RegExp(normalized, 'g');
}

function clampMaxResults<T>(items: T[], max: number): T[] {
  if (items.length <= max) return items;
  return items.slice(0, max);
}

function normalizeForSearch(text: string): string {
  return text.trim().toLowerCase();
}

function buildTrigramIndex(entries: Array<FuzzyIndexEntry>): Map<string, number[]> {
  const index = new Map<string, number[]>();

  for (let entryIdx = 0; entryIdx < entries.length; entryIdx++) {
    const s = entries[entryIdx].textLower;
    if (s.length < 3) continue;

    const seen = new Set<string>();
    for (let i = 0; i <= s.length - 3; i++) {
      const tri = s.slice(i, i + 3);
      if (seen.has(tri)) continue;
      seen.add(tri);
      const posting = index.get(tri);
      if (posting) {
        posting.push(entryIdx);
      } else {
        index.set(tri, [entryIdx]);
      }
    }
  }

  return index;
}

function fuzzyMatch(patternLower: string, textLower: string): { match: boolean; score: number; indices: number[] } {
  if (!patternLower) return { match: true, score: 0, indices: [] };
  if (!textLower) return { match: false, score: 0, indices: [] };

  const indices: number[] = [];
  let score = 0;
  let patternIdx = 0;
  let prevMatchIdx = -1;

  for (let i = 0; i < textLower.length && patternIdx < patternLower.length; i++) {
    if (textLower[i] !== patternLower[patternIdx]) continue;

    indices.push(i);

    // Bonus for consecutive matches
    if (prevMatchIdx === i - 1) score += 2;

    // Bonus for matching at start or after a separator
    const prev = i === 0 ? '' : textLower[i - 1];
    if (
      i === 0 ||
      prev === ' ' ||
      prev === ':' ||
      prev === '/' ||
      prev === '-' ||
      prev === '_' ||
      prev === '.'
    ) {
      score += 3;
    }

    score += 1;
    prevMatchIdx = i;
    patternIdx++;
  }

  const matched = patternIdx === patternLower.length;
  if (!matched) return { match: false, score: 0, indices: [] };

  if (textLower.startsWith(patternLower)) score += 10;
  else if (textLower.includes(patternLower)) score += 5;

  // Small preference for shorter strings when scores tie.
  score += Math.max(0, 20 - textLower.length) * 0.02;

  return { match: true, score, indices };
}

function getFuzzyCandidates(index: FuzzyIndex, queryLower: string): number[] {
  if (queryLower.length < 3 || index.trigramIndex.size === 0) {
    return index.entries.map((_, i) => i);
  }

  const trigrams = new Set<string>();
  for (let i = 0; i <= queryLower.length - 3; i++) {
    trigrams.add(queryLower.slice(i, i + 3));
  }

  const voteCounts = new Map<number, number>();
  for (const tri of trigrams) {
    const posting = index.trigramIndex.get(tri);
    if (!posting) continue;
    for (const entryIdx of posting) {
      voteCounts.set(entryIdx, (voteCounts.get(entryIdx) ?? 0) + 1);
    }
  }

  if (voteCounts.size === 0) return [];

  const MAX_CANDIDATES = 2000;
  return [...voteCounts.entries()]
    .sort((a, b) => b[1] - a[1])
    .slice(0, MAX_CANDIDATES)
    .map(([entryIdx]) => entryIdx);
}

function fuzzySearchIndex<TMeta = unknown>(
  indexName: string,
  query: string,
  limit: number
): Array<FuzzySearchResult<TMeta>> {
  const index = fuzzyIndices.get(indexName) as FuzzyIndex<TMeta> | undefined;
  if (!index) return [];

  const queryLower = normalizeForSearch(query);
  if (!queryLower) return [];

  const candidates = getFuzzyCandidates(index, queryLower);
  const ranked: Array<FuzzySearchResult<TMeta>> = [];

  for (const entryIdx of candidates) {
    const entry = index.entries[entryIdx];
    if (!entry) continue;
    const match = fuzzyMatch(queryLower, entry.textLower);
    if (!match.match) continue;
    ranked.push({
      id: entry.id,
      text: entry.text,
      meta: entry.meta,
      score: match.score,
      indices: match.indices,
    });
  }

  ranked.sort((a, b) => {
    if (b.score !== a.score) return b.score - a.score;
    if (a.text.length !== b.text.length) return a.text.length - b.text.length;
    return a.text.localeCompare(b.text);
  });

  return ranked.slice(0, Math.max(1, limit));
}

function extractContext(sequence: string, start: number, end: number, pad = 20): string {
  const s = Math.max(0, start - pad);
  const e = Math.min(sequence.length, end + pad);
  return sequence.slice(s, e);
}

function normalizeStrand(strand?: StrandOption | string | null): StrandOption {
  if (strand === '+') return '+';
  if (strand === '-') return '-';
  return 'both';
}

function createHit(
  position: number,
  length: number,
  strand: StrandOption,
  label: string,
  sequence: string,
  feature?: SearchFeature,
  matchType?: string,
  score?: number
): SearchHit {
  return {
    position,
    end: position + length,
    strand,
    label,
    context: extractContext(sequence, position, position + length),
    feature,
    matchType,
    score,
  };
}

function sequenceDistance(a: string, b: string): number {
  let mismatches = 0;
  for (let i = 0; i < a.length; i++) {
    if (a[i] !== b[i]) mismatches++;
  }
  return mismatches;
}

function runSequenceSearch(req: SearchRequest): SearchHit[] {
  const { query, sequence, options } = req;
  const maxMismatches = Math.max(0, options?.mismatches ?? 0);
  const strandOpt = options?.strand ?? 'both';
  if (!query || query.length === 0) return [];

  const haystack = options?.caseSensitive ? sequence : sequence.toUpperCase();
  const needle = options?.caseSensitive ? query : query.toUpperCase();
  const len = needle.length;
  const seqLength = sequence.length;
  const hits: SearchHit[] = [];

  const searchOneStrand = (seq: string, strand: StrandOption) => {
    for (let i = 0; i <= seq.length - len; i++) {
      const window = seq.slice(i, i + len);
      if (maxMismatches === 0) {
        if (window === needle) {
          const position = strand === '-' ? seqLength - (i + len) : i;
          hits.push(createHit(position, len, strand, `${strand} strand match`, sequence));
        }
      } else {
        const dist = sequenceDistance(window, needle);
        if (dist <= maxMismatches) {
          const position = strand === '-' ? seqLength - (i + len) : i;
          hits.push(
            createHit(
              position,
              len,
              strand,
              `${strand} strand (${dist} mm)`,
              sequence,
              undefined,
              undefined,
              1 - dist / len
            )
          );
        }
      }
      if (hits.length >= (options?.maxResults ?? DEFAULT_MAX_RESULTS)) break;
    }
  };

  if (strandOpt === 'both' || strandOpt === '+') {
    searchOneStrand(haystack, '+');
  }
  if (hits.length < (options?.maxResults ?? DEFAULT_MAX_RESULTS) && (strandOpt === 'both' || strandOpt === '-')) {
    const rc = reverseComplement(haystack);
    searchOneStrand(rc, '-');
  }

  return hits;
}

function runMotifSearch(req: SearchRequest): SearchHit[] {
  const { query, sequence, options } = req;
  if (!query) return [];
  const regex = toRegexFromIupac(query);
  const strandOpt = options?.strand ?? 'both';
  const hits: SearchHit[] = [];
  const seqLength = sequence.length;

  const scan = (seq: string, strand: StrandOption) => {
    regex.lastIndex = 0;
    let match: RegExpExecArray | null;
    while ((match = regex.exec(seq)) !== null) {
      const position = strand === '-' ? seqLength - (match.index + match[0].length) : match.index;
      hits.push(createHit(position, match[0].length, strand, `${strand} motif`, sequence, undefined, 'motif'));
      if (hits.length >= (options?.maxResults ?? DEFAULT_MAX_RESULTS)) break;
    }
  };

  if (strandOpt === 'both' || strandOpt === '+') {
    scan(sequence.toUpperCase(), '+');
  }
  if (hits.length < (options?.maxResults ?? DEFAULT_MAX_RESULTS) && (strandOpt === 'both' || strandOpt === '-')) {
    scan(reverseComplement(sequence.toUpperCase()), '-');
  }

  return hits;
}

function runGeneSearch(req: SearchRequest): SearchHit[] {
  const { query, sequence, features, options } = req;
  if (!query) return [];
  const needle = options?.caseSensitive ? query : query.toLowerCase();

  const results: SearchHit[] = [];
  for (const feature of features) {
    const name = feature.name ?? '';
    const product = feature.product ?? '';
    const type = feature.type ?? '';
    const hay = options?.caseSensitive ? `${name} ${product} ${type}` : `${name} ${product} ${type}`.toLowerCase();
    if (hay.includes(needle)) {
      const strand = normalizeStrand(feature.strand);
      results.push(
        createHit(
          feature.start,
          feature.end - feature.start,
          strand === 'both' ? '+' : strand,
          feature.name || feature.product || 'Gene/feature match',
          sequence,
          feature,
          'gene/annotation'
        )
      );
    }
    if (results.length >= (options?.maxResults ?? DEFAULT_MAX_RESULTS)) break;
  }
  return results;
}

function runFeatureSearch(req: SearchRequest): SearchHit[] {
  const { query, sequence, features, options } = req;
  if (!query) return [];
  const needle = options?.caseSensitive ? query : query.toLowerCase();
  const results: SearchHit[] = [];

  for (const feature of features) {
    const type = feature.type ?? '';
    const name = feature.name ?? '';
    const product = feature.product ?? '';
    const hay = options?.caseSensitive ? `${type} ${name} ${product}` : `${type} ${name} ${product}`.toLowerCase();
    if (hay.includes(needle)) {
      const strand = normalizeStrand(feature.strand);
      results.push(
        createHit(
          feature.start,
          feature.end - feature.start,
          strand === 'both' ? '+' : strand,
          `${type || 'Feature'}${name ? `: ${name}` : ''}`,
          sequence,
          feature,
          'feature'
        )
      );
    }
    if (results.length >= (options?.maxResults ?? DEFAULT_MAX_RESULTS)) break;
  }

  return results;
}

function runPositionSearch(req: SearchRequest): SearchHit[] {
  const { query, sequence, features, options } = req;
  if (!query) return [];
  const ranges = query
    .split(',')
    .map((part) => part.trim())
    .filter(Boolean)
    .map((part) => {
      if (part.includes('-')) {
        const [s, e] = part.split('-').map((v) => Number(v.trim()));
        if (Number.isFinite(s) && Number.isFinite(e)) {
          return { start: Math.max(0, Math.min(s, e)), end: Math.max(s, e) };
        }
        return null;
      }
      const pos = Number(part);
      if (Number.isFinite(pos)) {
        return { start: pos, end: pos };
      }
      return null;
    })
    .filter((r): r is { start: number; end: number } => !!r);

  const results: SearchHit[] = [];

  for (const range of ranges) {
    // First, capture overlapping features
    for (const feature of features) {
      const overlaps = feature.end >= range.start && feature.start <= range.end;
      if (overlaps) {
        const strand = normalizeStrand(feature.strand);
        results.push(
          createHit(
            feature.start,
            feature.end - feature.start,
            strand === 'both' ? '+' : strand,
            feature.name || feature.type || 'Feature',
            sequence,
            feature,
            'position'
          )
        );
      }
      if (results.length >= (options?.maxResults ?? DEFAULT_MAX_RESULTS)) break;
    }

    if (results.length >= (options?.maxResults ?? DEFAULT_MAX_RESULTS)) break;

    // If no feature overlaps, still return a positional marker
    if (!features.some((f) => f.end >= range.start && f.start <= range.end)) {
      results.push(
        createHit(
          range.start,
          range.end - range.start || 1,
          '+',
          `Position ${range.start}${range.end !== range.start ? `-${range.end}` : ''}`,
          sequence,
          undefined,
          'position'
        )
      );
    }
  }

  return clampMaxResults(results, options?.maxResults ?? DEFAULT_MAX_RESULTS);
}

function runSearchInternal(request: SearchRequest): SearchResponse {
  const mode: SearchMode = request.mode;
  const options = { ...request.options, maxResults: request.options?.maxResults ?? DEFAULT_MAX_RESULTS };

  let hits: SearchHit[] = [];
  switch (mode) {
    case 'sequence':
      hits = runSequenceSearch({ ...request, options });
      break;
    case 'motif':
      hits = runMotifSearch({ ...request, options });
      break;
    case 'gene':
      hits = runGeneSearch({ ...request, options });
      break;
    case 'feature':
      hits = runFeatureSearch({ ...request, options });
      break;
    case 'position':
      hits = runPositionSearch({ ...request, options });
      break;
    default:
      hits = [];
  }

  return {
    mode,
    query: request.query,
    hits: clampMaxResults(hits, options.maxResults ?? DEFAULT_MAX_RESULTS),
  };
}

const workerAPI: SearchWorkerAPI = {
  async runSearch(request: SearchRequest): Promise<SearchResponse> {
    try {
      return runSearchInternal(request);
    } catch (error) {
      // Log error for debugging and return empty results instead of crashing worker
      console.error('Search worker error:', error);
      return {
        mode: request.mode,
        query: request.query,
        hits: [],
      };
    }
  },

  // Ping method for SearchOverlay to verify worker is ready
  async ping(): Promise<boolean> {
    return true;
  },

  async setFuzzyIndex<TMeta = unknown>(request: FuzzyIndexRequest<TMeta>): Promise<void> {
    const name = request.index?.trim();
    if (!name) return;

    const normalizedEntries: Array<FuzzyIndexEntry<TMeta>> = (request.entries ?? [])
      .filter((e): e is FuzzySearchEntry<TMeta> => Boolean(e && typeof e.id === 'string' && typeof e.text === 'string'))
      .map((e) => ({
        ...e,
        text: e.text,
        textLower: normalizeForSearch(e.text),
      }))
      .filter((e) => e.textLower.length > 0);

    fuzzyIndices.set(name, {
      entries: normalizedEntries,
      trigramIndex: buildTrigramIndex(normalizedEntries as Array<FuzzyIndexEntry>),
    });
  },

  async fuzzySearch<TMeta = unknown>(request: FuzzySearchRequest): Promise<Array<FuzzySearchResult<TMeta>>> {
    const name = request.index?.trim();
    if (!name) return [];
    const limit = request.limit ?? 50;
    return fuzzySearchIndex<TMeta>(name, request.query, limit);
  },
};

Comlink.expose(workerAPI);
