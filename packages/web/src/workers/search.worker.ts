/**
 * Search Worker - Genomic search and feature lookup for SearchOverlay
 *
 * Runs in a Web Worker (Comlink) to keep the UI responsive while scanning
 * sequences for patterns, motifs, and feature metadata.
 */

import * as Comlink from 'comlink';
import { reverseComplement } from '@phage-explorer/core';
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

function toRegexFromIupac(pattern: string, caseSensitive: boolean): RegExp {
  if (!/^[ACGTRYSWKMBDHVN]+$/i.test(pattern)) {
    throw new Error('Motif queries accept IUPAC DNA symbols only (no regular expressions).');
  }
  const normalized = pattern
    .split('')
    .map(c => {
      const motif = IUPAC_MAP[c.toUpperCase()];
      return caseSensitive && c === c.toLowerCase() ? motif.toLowerCase() : motif;
    })
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
  const requestedEnd = Math.min(sequence.length, end + pad);
  const e = Math.min(requestedEnd, s + 240);
  return sequence.slice(s, e) + (e < requestedEnd ? '…' : '');
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
  const regex = toRegexFromIupac(query, options?.caseSensitive ?? false);
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
      // Global RegExp matching normally skips overlaps. Each starting base is a
      // distinct motif occurrence, including on the reverse-complement strand.
      regex.lastIndex = match.index + 1;
    }
  };

  if (strandOpt === 'both' || strandOpt === '+') {
    scan(options?.caseSensitive ? sequence : sequence.toUpperCase(), '+');
  }
  if (hits.length < (options?.maxResults ?? DEFAULT_MAX_RESULTS) && (strandOpt === 'both' || strandOpt === '-')) {
    scan(reverseComplement(options?.caseSensitive ? sequence : sequence.toUpperCase()), '-');
  }

  return hits;
}

function runAnnotationSearch(req: SearchRequest): SearchHit[] {
  const { query, sequence, features, options } = req;
  if (!query) return [];
  const needle = options?.caseSensitive ? query.trim() : query.trim().toLowerCase();
  if (!needle) return [];

  // Rank references first. Large annotations must not each allocate a sequence
  // context before the result limit is applied.
  const matches: Array<{ feature: SearchFeature; score: number | undefined }> = [];
  for (const feature of features) {
    const name = feature.name ?? '';
    const product = feature.product ?? '';
    const type = feature.type ?? '';
    const text = req.mode === 'feature' ? `${type} ${name} ${product}`
      : options?.fuzzy ? `${name} ${product}` : `${name} ${product} ${type}`;
    const hay = options?.caseSensitive ? text : text.toLowerCase();
    const fuzzy = options?.fuzzy ? fuzzyMatch(needle, hay) : null;
    if (fuzzy ? fuzzy.match : hay.includes(needle)) {
      matches.push({ feature, score: fuzzy?.score });
    }
    if (!options?.fuzzy && matches.length >= (options?.maxResults ?? DEFAULT_MAX_RESULTS)) break;
  }
  if (options?.fuzzy) {
    matches.sort((a, b) => (b.score ?? 0) - (a.score ?? 0) || a.feature.start - b.feature.start || a.feature.end - b.feature.end);
  }
  return matches.slice(0, options?.maxResults ?? DEFAULT_MAX_RESULTS).map(({ feature, score }) => {
    const strand = normalizeStrand(feature.strand);
    return createHit(feature.start, feature.end - feature.start, strand === 'both' ? '+' : strand,
      req.mode === 'feature' ? `${feature.type || 'Feature'}${feature.name ? `: ${feature.name}` : ''}`
        : feature.name || feature.product || 'Gene/feature match',
      sequence, feature, req.mode === 'feature' ? 'feature' : 'gene/annotation', score);
  });
}

function runPositionSearch(req: SearchRequest): SearchHit[] {
  const { query, sequence, features, options } = req;
  if (!query) return [];
  // The explorer stores and searches 0-based half-open intervals. A single
  // coordinate denotes one base; the exclusive feature end never overlaps it.
  const ranges = query.split(',').map(part => {
    const match = /^\s*(\d+)\s*(?:-\s*(\d+)\s*)?$/.exec(part);
    if (!match) throw new Error('Use whole-number positions or ranges such as 0, 1000-2000 (0-based, end exclusive).');
    const a = Number(match[1]), b = match[2] === undefined ? a + 1 : Number(match[2]);
    const start = Math.min(a, b), end = Math.max(a, b);
    if (!Number.isSafeInteger(start) || !Number.isSafeInteger(end) || start >= end || end > sequence.length) {
      throw new Error(`Positions must select bases within 0-${sequence.length} (end exclusive).`);
    }
    return { start, end };
  });
  const results: SearchHit[] = [];
  const seenFeatures = new Set<number>(), seenMarkers = new Set<string>();
  const limit = options?.maxResults ?? DEFAULT_MAX_RESULTS;

  for (const range of ranges) {
    let hasFeature = false;
    for (let i = 0; i < features.length; i++) {
      const feature = features[i];
      if (feature.start < range.end && feature.end > range.start) {
        hasFeature = true;
        if (seenFeatures.has(i)) continue;
        seenFeatures.add(i);
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
      if (results.length >= limit) break;
    }

    if (results.length >= limit) break;

    // If no feature overlaps, still return a positional marker
    const marker = `${range.start}:${range.end}`;
    if (!hasFeature && !seenMarkers.has(marker)) {
      seenMarkers.add(marker);
      results.push(
        createHit(
          range.start,
          range.end - range.start,
          '+',
          `Position ${range.start}${range.end !== range.start + 1 ? `-${range.end}` : ''}`,
          sequence,
          undefined,
          'position'
        )
      );
    }
    if (results.length >= limit) break;
  }

  return clampMaxResults(results, options?.maxResults ?? DEFAULT_MAX_RESULTS);
}

function runSearchInternal(request: SearchRequest): SearchResponse {
  const mode: SearchMode = request.mode;
  const options = { ...request.options, maxResults: request.options?.maxResults ?? DEFAULT_MAX_RESULTS };
  if (!Number.isSafeInteger(options.maxResults) || options.maxResults < 1 || options.maxResults > 2000) {
    throw new Error('Search result limit must be a whole number from 1 to 2,000.');
  }
  if (options.mismatches !== undefined && (!Number.isSafeInteger(options.mismatches) || options.mismatches < 0 || options.mismatches > 3)) {
    throw new Error('Search mismatches must be a whole number from 0 to 3.');
  }
  if (options.strand !== undefined && !['+', '-', 'both'].includes(options.strand)) throw new Error('Unsupported search strand.');

  let hits: SearchHit[] = [];
  switch (mode) {
    case 'sequence':
      hits = runSequenceSearch({ ...request, options });
      break;
    case 'motif':
      hits = runMotifSearch({ ...request, options });
      break;
    case 'gene':
    case 'feature':
      hits = runAnnotationSearch({ ...request, options });
      break;
    case 'position':
      hits = runPositionSearch({ ...request, options });
      break;
    default:
      throw new Error('Unsupported search mode.');
  }

  return {
    mode,
    query: request.query,
    hits: clampMaxResults(hits, options.maxResults ?? DEFAULT_MAX_RESULTS),
  };
}

const workerAPI: SearchWorkerAPI = {
  async runSearch(request: SearchRequest): Promise<SearchResponse> {
    // Comlink propagates failures to the caller. Invalid input or failed work is
    // not evidence that the selected genome contains no matching sequence.
    return runSearchInternal(request);
  },

  // Ping method for SearchOverlay to verify worker is ready
  async ping(): Promise<boolean> {
    return true;
  },

  async setFuzzyIndex<TMeta = unknown>(request: FuzzyIndexRequest<TMeta>): Promise<void> {
    const name = request.index?.trim();
    if (!name) return;

    const entries = request.entries ?? [];
    const normalizedEntries: Array<FuzzyIndexEntry<TMeta>> = [];
    for (let i = 0; i < entries.length; i++) {
      const e = entries[i];
      if (e && typeof e.id === 'string' && typeof e.text === 'string') {
        const textLower = normalizeForSearch(e.text);
        if (textLower.length > 0) {
          normalizedEntries.push({
            ...e,
            text: e.text,
            textLower,
          });
        }
      }
    }

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
