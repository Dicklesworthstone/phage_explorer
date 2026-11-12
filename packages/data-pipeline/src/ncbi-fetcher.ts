// NCBI E-utilities fetcher for phage sequences
// API documentation: https://www.ncbi.nlm.nih.gov/books/NBK25499/

import { parseLocalFeatureLocation } from '@phage-explorer/core';

const NCBI_BASE_URL = 'https://eutils.ncbi.nlm.nih.gov/entrez/eutils';
const RATE_LIMIT_MS = 350; // ~3 requests per second without API key
const NCBI_HEADERS = { 'User-Agent': 'phage_explorer-data-pipeline (+https://github.com/Dicklesworthstone/phage_explorer)' };

export interface NCBISequenceResult {
  accession: string;
  sequence: string;
  length: number;
  gcContent: number;
  features: NCBIFeature[];
  metadata: Record<string, string>;
}

export interface NCBIFeature {
  type: string;
  /** Original, assembled INSDC expression; never replaced with its bounding span. */
  location: string;
  start: number;
  end: number;
  strand: '+' | '-' | null;
  gene?: string;
  locusTag?: string;
  product?: string;
  /** Flags have an empty value. Repeated qualifiers retain every value in source order. */
  qualifiers: Record<string, string | string[]>;
  /** Zero-based, half-open intervals in transcript order; [] means unsupported geometry. */
  segments: Array<{ start: number; end: number; strand: '+' | '-' }>;
}

// Sleep helper for rate limiting
function sleep(ms: number): Promise<void> {
  return new Promise(resolve => setTimeout(resolve, ms));
}

// Fetch sequence in FASTA format
export async function fetchFasta(accession: string): Promise<string> {
  const url = `${NCBI_BASE_URL}/efetch.fcgi?db=nuccore&id=${encodeURIComponent(accession)}&rettype=fasta&retmode=text`;

  const response = await fetch(url, { headers: NCBI_HEADERS });
  if (!response.ok) {
    throw new Error(`Failed to fetch FASTA for ${accession}: ${response.status}`);
  }

  const text = await response.text();
  await sleep(RATE_LIMIT_MS);

  return text;
}

// Fetch sequence in GenBank format (includes features)
export async function fetchGenBank(accession: string): Promise<string> {
  const url = `${NCBI_BASE_URL}/efetch.fcgi?db=nuccore&id=${encodeURIComponent(accession)}&rettype=gbwithparts&retmode=text`;

  const response = await fetch(url, { headers: NCBI_HEADERS });
  if (!response.ok) {
    throw new Error(`Failed to fetch GenBank for ${accession}: ${response.status}`);
  }

  const text = await response.text();
  await sleep(RATE_LIMIT_MS);

  return text;
}

// Parse FASTA format to extract sequence
export function parseFasta(fasta: string): { header: string; sequence: string } {
  const lines = fasta.trim().split('\n');
  const header = lines[0].replace(/^>/, '').trim();
  const sequence = lines.slice(1).join('').replace(/\s/g, '').toUpperCase();

  return { header, sequence };
}

interface RawFeature {
  type: string;
  location: string;
  qualifiers: NCBIFeature['qualifiers'];
}

/** Read feature values before deriving labels or geometry. INSDC permits repeated
 * qualifiers, valueless flags and doubled quotes within a quoted value.
 * https://www.insdc.org/submitting-standards/feature-table/ sections 3.3 and 3.4.
 */
function parseFeatures(lines: string[], accession: string): RawFeature[] {
  const features: RawFeature[] = [];
  let feature: RawFeature | undefined;
  const cursor: { qualifier?: { key: string; parts: string[]; quoted: boolean; closed: boolean; flag: boolean } } = {};
  const finishQualifier = (): void => {
    const qualifier = cursor.qualifier;
    if (!qualifier || !feature) return;
    if (!qualifier.closed) throw new Error(accession + ': unterminated quoted /' + qualifier.key);
    const value = qualifier.parts.join(['translation', 'rpt_unit_seq'].includes(qualifier.key) ? '' : ' ');
    const previous = feature.qualifiers[qualifier.key];
    if (!Object.hasOwn(feature.qualifiers, qualifier.key)) feature.qualifiers[qualifier.key] = value;
    else if (Array.isArray(previous)) previous.push(value);
    else feature.qualifiers[qualifier.key] = [previous, value];
    cursor.qualifier = undefined;
  };
  const appendValue = (text: string): void => {
    const qualifier = cursor.qualifier;
    if (!qualifier) return;
    if (qualifier.flag || qualifier.quoted && qualifier.closed) throw new Error(accession + ': unexpected continuation after /' + qualifier.key);
    if (!qualifier.quoted) { qualifier.parts.push(text); return; }
    let value = '';
    for (let i = 0; i < text.length; i++) {
      if (text[i] !== '"') value += text[i];
      else if (text[i + 1] === '"') { value += '"'; i++; }
      else {
        if (text.slice(i + 1).trim()) throw new Error(accession + ': text after closing quote in /' + qualifier.key);
        qualifier.closed = true;
        break;
      }
    }
    qualifier.parts.push(value);
  };
  const startQualifier = (text: string): void => {
    finishQualifier();
    const match = /^\/([A-Za-z][A-Za-z0-9_'-]*)(?:=(.*))?$/.exec(text);
    if (!match) throw new Error(accession + ': malformed feature qualifier');
    const value = match[2] ?? '';
    const quoted = value.startsWith('"');
    cursor.qualifier = { key: match[1], parts: [], quoted, closed: !quoted, flag: match[2] === undefined };
    if (!cursor.qualifier.flag) appendValue(quoted ? value.slice(1) : value);
  };
  const appendLocation = (text: string): void => {
    // A first qualifier may follow the last line of a wrapped location.
    const slash = text.indexOf('/');
    feature!.location += (slash < 0 ? text : text.slice(0, slash)).trim();
    if (slash >= 0) startQualifier(text.slice(slash));
  };
  for (const line of lines) {
    if (!line.trim()) continue;
    if (/^\S/.test(line)) break; // e.g. the optional BASE COUNT header before ORIGIN
    if (/^ {5}\S/.test(line)) {
      finishQualifier();
      feature = { type: line.slice(5, 21).trim(), location: '', qualifiers: Object.create(null) as NCBIFeature['qualifiers'] };
      features.push(feature);
      appendLocation(line.slice(21).trim());
    } else {
      if (!feature || !/^ {21}/.test(line)) throw new Error(accession + ': malformed feature continuation');
      const text = line.slice(21).trim();
      const qualifier = cursor.qualifier;
      if (text.startsWith('/') && !(qualifier?.quoted && !qualifier.closed)) startQualifier(text);
      else if (qualifier) appendValue(text);
      else appendLocation(text);
    }
  }
  finishQualifier();
  return features;
}

/** Parse one catalog record, retaining unsupported annotations instead of shortening
 * joins or treating remote coordinates as local. The private genome importer is DNA
 * only; this catalog path also supports declared RNA, whose INSDC base notation uses T.
 */
export function parseGenBank(genbank: string): NCBISequenceResult {
  const lines = genbank.replace(/^\uFEFF/, '').replace(/\r\n?/g, '\n').trim().split('\n');
  const locus = /^LOCUS\s+(\S+)\s+(\d+)\s+bp\b(.*)$/i.exec(lines[0]);
  if (!locus) throw new Error('GenBank LOCUS must name a nucleotide record and declare its length in bp');
  const declaredLength = Number(locus[2]);
  if (!Number.isSafeInteger(declaredLength) || declaredLength < 1) throw new Error('Invalid GenBank sequence length');
  const end = lines.findIndex(line => /^\/\/\s*$/.test(line));
  if (end < 0) throw new Error('GenBank record must end with //');
  if (lines.slice(end + 1).some(line => line.trim())) throw new Error('Expected one GenBank record; multiple records cannot be silently truncated');
  const origin = lines.findIndex(line => /^ORIGIN\b/.test(line));
  if (origin < 0 || origin > end) throw new Error(locus[1] + ': missing ORIGIN sequence');
  const version = lines.find(line => /^VERSION\s/.test(line))?.trim().split(/\s+/)[1];
  const accession = lines.find(line => /^ACCESSION\s/.test(line))?.trim().split(/\s+/)[1] ?? version ?? locus[1];
  const moleculeType = /(?:^|\s)(\S*(?:DNA|RNA))(?=\s|$)/i.exec(locus[3])?.[1];
  const molecule = moleculeType ? /RNA/i.test(moleculeType) ? 'RNA' : 'DNA' : 'unknown';
  const warnings: string[] = [];
  const metadata: Record<string, string> = {
    molecule,
    topology: /\bcircular\b/i.test(locus[3]) ? 'circular' : /\blinear\b/i.test(locus[3]) ? 'linear' : 'unknown',
  };
  if (moleculeType) metadata.moleculeType = moleculeType;
  if (version) metadata.version = version;
  const definition = lines.findIndex(line => /^DEFINITION\s/.test(line));
  if (definition >= 0) {
    const parts = [lines[definition].slice(12).trim()];
    for (let i = definition + 1; i < origin && /^ {12}\S/.test(lines[i]); i++) parts.push(lines[i].trim());
    metadata.definition = parts.join(' ');
  }
  const organism = lines.find(line => /^ {2}ORGANISM\s/.test(line));
  if (organism) metadata.organism = organism.slice(12).trim();

  const sequenceParts: string[] = [];
  let sequenceLength = 0;
  for (const line of lines.slice(origin + 1, end)) {
    if (!line.trim()) continue;
    const match = /^\s*(\d+)\s+([A-Za-z][A-Za-z\s]*)$/.exec(line);
    if (!match || Number(match[1]) !== sequenceLength + 1) throw new Error(accession + ': malformed or out-of-order ORIGIN line');
    const part = match[2].replace(/\s/g, '').toUpperCase();
    if (/[^ACGTURYSWKMBDHVN]/.test(part)) throw new Error(accession + ': ORIGIN contains non-IUPAC nucleotide symbols');
    sequenceParts.push(part);
    sequenceLength += part.length;
  }
  let sequence = sequenceParts.join('');
  if (sequence.length !== declaredLength) throw new Error(accession + ': LOCUS declares ' + declaredLength + ' bases but ORIGIN contains ' + sequence.length);
  if (sequence.includes('U')) {
    if (molecule !== 'RNA') throw new Error(accession + ': RNA U is only supported for a declared RNA catalog record');
    sequence = sequence.replaceAll('U', 'T');
    metadata.sequenceNormalization = 'RNA U-to-T';
    warnings.push('Declared RNA: U was normalized to T using INSDC nucleotide notation; molecule type remains RNA.');
  }

  const featureStart = lines.findIndex(line => /^FEATURES\b/.test(line));
  const rawFeatures = featureStart >= 0 && featureStart < origin ? parseFeatures(lines.slice(featureStart + 1, origin), accession) : [];
  const features = rawFeatures.map((feature): NCBIFeature => {
    let segments: NCBIFeature['segments'] = [];
    try { segments = parseLocalFeatureLocation(feature.location, sequence.length); }
    catch (error) {
      warnings.push(feature.type + ' ' + feature.location + ': ' + (error instanceof Error ? error.message : 'unsupported location') + '; no local interval or protein inferred, annotation retained.');
    }
    const label = (key: string): string | undefined => {
      const value = feature.qualifiers[key];
      if (Array.isArray(value)) {
        warnings.push(feature.type + ' ' + feature.location + ': repeated /' + key + ' retained; first value used for the display label.');
        return value[0];
      }
      return value;
    };
    return {
      ...feature, segments,
      start: segments.length ? Math.min(...segments.map(segment => segment.start)) : 0,
      end: segments.length ? Math.max(...segments.map(segment => segment.end)) : 0,
      strand: segments.length && segments.every(segment => segment.strand === segments[0].strand) ? segments[0].strand : null,
      gene: label('gene'), locusTag: label('locus_tag'), product: label('product'),
    };
  });
  metadata.warnings = JSON.stringify(warnings);
  let gc = 0, known = 0;
  for (const base of sequence) {
    if (base === 'G' || base === 'C') { gc++; known++; }
    else if (base === 'A' || base === 'T') known++;
  }
  return { accession, sequence, length: sequence.length, gcContent: known ? gc / known * 100 : 0, features, metadata };
}

// Fetch and parse a complete phage sequence with features
export async function fetchPhageSequence(accession: string): Promise<NCBISequenceResult> {
  console.log(`Fetching GenBank record for ${accession}...`);
  const genbank = await fetchGenBank(accession);
  return parseGenBank(genbank);
}

// Batch fetch multiple sequences with rate limiting
export async function fetchPhageSequences(
  accessions: string[],
  onProgress?: (current: number, total: number) => void
): Promise<Map<string, NCBISequenceResult | null>> {
  const results = new Map<string, NCBISequenceResult | null>();

  for (let i = 0; i < accessions.length; i++) {
    const accession = accessions[i];
    try {
      const result = await fetchPhageSequence(accession);
      results.set(accession, result);
    } catch (error) {
      console.error(`Failed to fetch ${accession}:`, error);
      results.set(accession, null); // Mark as failed
    }
    onProgress?.(i + 1, accessions.length);
  }

  return results;
}
