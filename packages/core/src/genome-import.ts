import type { GeneInfo, PhageFull, ReadingFrame, ViewMode } from './types';

export const GENOME_IMPORT_LIMITS = { bytes: 10 * 1024 * 1024, records: 100, bases: 5_000_000, features: 50_000, segments: 1000 } as const;
export interface GenomeInput { name: string; text: string }
export interface LocalGenome {
  phage: PhageFull;
  sequence: string;
  original: GenomeInput;
  warnings: string[];
}
export interface LocalGenomeView {
  contentId: string;
  viewMode: ViewMode;
  readingFrame: ReadingFrame;
  scrollPosition: number;
}
export interface GenomeImportResult { genomes: LocalGenome[]; view?: LocalGenomeView }

/** Preserve transcript segments so neither frontend paints an intron or circular-origin gap as CDS. */
export function getGeneMapSegments(gene: GeneInfo): { start: number; end: number; strand: GeneInfo['strand'] }[] {
  const segments = gene.qualifiers?._segments;
  if (Array.isArray(segments)) {
    return segments.filter((segment): segment is { start: number; end: number; strand: '+' | '-' } => {
      if (!segment || typeof segment !== 'object') return false;
      const value = segment as Record<string, unknown>;
      return typeof value.start === 'number' && Number.isSafeInteger(value.start) && value.start >= 0 &&
        typeof value.end === 'number' && Number.isSafeInteger(value.end) && value.end > value.start &&
        (value.strand === '+' || value.strand === '-');
    });
  }
  return [{ start: Math.min(gene.startPos, gene.endPos), end: Math.max(gene.startPos, gene.endPos), strand: gene.strand }];
}

interface Segment { start: number; end: number; strand: '+' | '-' }
interface Feature { type: string; location: string; qualifiers: Record<string, string>; segments?: Segment[] }
interface ParsedRecord {
  name: string; accession: string; sequence: string; topology: 'linear' | 'circular' | 'unknown';
  format: 'fasta' | 'genbank'; features: Feature[]; warnings: string[]; original: GenomeInput;
}

/** INSDC locations are 1-based inclusive; internal intervals are 0-based half-open.
 * https://www.insdc.org/submitting-standards/feature-table/ section 3.4.
 * Remote, uncertain, between-base and order() locations are retained as unsupported
 * annotations, never approximated into a coding interval.
 */
export function parseLocalFeatureLocation(location: string, length: number, depth = 0): Segment[] {
  if (depth > 16) throw new Error('Feature location nesting exceeds 16 levels');
  const text = location.replace(/\s/g, '');
  if (text.startsWith('complement(') && text.endsWith(')')) {
    return parseLocalFeatureLocation(text.slice(11, -1), length, depth + 1)
      .reverse().map(segment => ({ ...segment, strand: segment.strand === '+' ? '-' : '+' }));
  }
  if (text.startsWith('join(') && text.endsWith(')')) {
    const parts: string[] = [];
    let level = 0;
    let start = 5;
    for (let i = 5; i < text.length - 1; i++) {
      if (text[i] === '(') level++;
      if (text[i] === ')') level--;
      if (level < 0) throw new Error('Unbalanced feature location');
      if (text[i] === ',' && level === 0) { parts.push(text.slice(start, i)); start = i + 1; }
    }
    if (level !== 0) throw new Error('Unbalanced feature location');
    parts.push(text.slice(start, -1));
    if (parts.length < 2) throw new Error('join() requires multiple segments');
    if (parts.length > GENOME_IMPORT_LIMITS.segments) throw new Error('Feature exceeds 1,000 location segments');
    const segments: Segment[] = [];
    for (const part of parts) {
      segments.push(...parseLocalFeatureLocation(part, length, depth + 1));
      if (segments.length > GENOME_IMPORT_LIMITS.segments) throw new Error('Feature exceeds 1,000 location segments');
    }
    return segments;
  }
  const match = /^(\d+)(?:\.\.(\d+))?$/.exec(text);
  if (!match) throw new Error(`Unsupported feature location: ${text.slice(0, 100)}`);
  const start = Number(match[1]);
  const end = Number(match[2] ?? match[1]);
  if (!Number.isSafeInteger(start) || !Number.isSafeInteger(end) || start < 1 || end < start || end > length) {
    throw new Error(`Feature interval ${text} is outside the ${length}-base record`);
  }
  return [{ start: start - 1, end, strand: '+' }];
}

function validateSequence(sequence: string, accession: string): string {
  const normalized = sequence.replace(/\s/g, '').toUpperCase();
  if (!normalized) throw new Error(`${accession}: sequence is empty`);
  if (/[^ACGTRYSWKMBDHVN]/.test(normalized)) {
    throw new Error(`${accession}: expected IUPAC DNA bases (ACGT and ambiguity codes); RNA U, gaps, digits and protein letters are not accepted`);
  }
  if (normalized.length > GENOME_IMPORT_LIMITS.bases) throw new Error('Input exceeds the 5,000,000-base limit');
  return normalized;
}

function parseFastaRecords(input: GenomeInput): ParsedRecord[] {
  if (!input.text.trimStart().startsWith('>')) throw new Error('FASTA must begin with a >header');
  const records = input.text.trim().split(/\n(?=>)/);
  if (records.length > GENOME_IMPORT_LIMITS.records) throw new Error('Import requires 1–100 records');
  return records.map(raw => {
    const lines = raw.split('\n');
    const name = lines[0].slice(1).trim();
    if (!name || name.length > 2000) throw new Error('FASTA headers must contain 1–2,000 characters');
    const accession = name.split(/\s+/)[0];
    return {
      name, accession, sequence: validateSequence(lines.slice(1).join(''), accession),
      topology: /\[topology=circular\]/i.test(name) ? 'circular' : /\[topology=linear\]/i.test(name) ? 'linear' : 'unknown',
      format: 'fasta', features: [], warnings: ['FASTA supplies no gene annotations.'],
      original: { name: input.name, text: `${raw}\n` },
    };
  });
}

function parseGenbankRecord(raw: string, inputName: string): ParsedRecord {
  const lines = raw.split('\n');
  const locus = /^LOCUS\s+(\S+)\s+(\d+)\s+bp\b(.*)$/i.exec(lines[0]);
  if (!locus) throw new Error('GenBank LOCUS must name a DNA record and declare its length in bp');
  if (/RNA/i.test(locus[3])) throw new Error('RNA records are not supported by this DNA importer');
  const origin = lines.findIndex(line => /^ORIGIN\b/.test(line));
  if (origin < 0) throw new Error(`${locus[1]}: missing ORIGIN sequence`);
  const accession = lines.find(line => /^VERSION\s/.test(line))?.trim().split(/\s+/)[1]
    ?? lines.find(line => /^ACCESSION\s/.test(line))?.trim().split(/\s+/)[1] ?? locus[1];
  const sequence = validateSequence(lines.slice(origin + 1).filter(line => line.trim() !== '//').map(line => {
    if (!/^\s*\d+\s+[a-z\s]+$/i.test(line) && line.trim()) throw new Error(`${accession}: malformed ORIGIN line`);
    return line.replace(/^\s*\d+/, '');
  }).join(''), accession);
  if (sequence.length !== Number(locus[2])) throw new Error(`${accession}: LOCUS declares ${locus[2]} bases but ORIGIN contains ${sequence.length}`);
  const features: Feature[] = [];
  const warnings: string[] = [];
  let feature: Feature | undefined;
  let qualifier = '';
  let skipQualifier = false;
  let quoted = false;
  const featureStart = lines.findIndex(line => /^FEATURES\b/.test(line));
  for (const line of featureStart < 0 ? [] : lines.slice(featureStart + 1, origin)) {
    if (/^ {5}\S/.test(line)) {
      if (quoted) throw new Error(`${accession}: unterminated quoted qualifier`);
      feature = { type: line.slice(5, 21).trim(), location: line.slice(21).trim(), qualifiers: Object.create(null) as Record<string, string> };
      features.push(feature);
      if (features.length > GENOME_IMPORT_LIMITS.features) throw new Error('Too many annotated features');
      qualifier = '';
      skipQualifier = false;
    } else if (feature && line.trim()) {
      const text = line.slice(21).trim();
      if (text.startsWith('/') && !quoted) {
        const match = /^\/([A-Za-z][A-Za-z0-9_]*)(?:=(.*))?$/.exec(text);
        if (!match) throw new Error(`${accession}: malformed feature qualifier`);
        qualifier = match[1];
        skipQualifier = false;
        let value = match[2] ?? '';
        quoted = value.startsWith('"') && !value.slice(1).endsWith('"');
        value = value.replace(/^"/, '').replace(/"$/, '').replace(/""/g, '"');
        if (Object.hasOwn(feature.qualifiers, qualifier)) {
          warnings.push(`${feature.type}: repeated /${qualifier} retained in original source; first value used in the viewer.`);
          skipQualifier = true;
        } else feature.qualifiers[qualifier] = value;
      } else if (qualifier) {
        quoted = quoted && !text.endsWith('"');
        if (!skipQualifier) feature.qualifiers[qualifier] += (qualifier === 'translation' ? '' : ' ') + text.replace(/"$/, '').replace(/""/g, '"');
      } else if (!text.startsWith('/')) {
        feature.location += text;
      }
    }
  }
  if (quoted) throw new Error(`${accession}: unterminated quoted qualifier`);
  for (const item of features) {
    try { item.segments = parseLocalFeatureLocation(item.location, sequence.length); }
    catch (error) { warnings.push(`${item.type} ${item.location}: ${error instanceof Error ? error.message : 'unsupported location'}; excluded from the gene map, retained in source.`); }
  }
  const definitionIndex = lines.findIndex(line => /^DEFINITION\s/.test(line));
  let name = definitionIndex < 0 ? locus[1] : lines[definitionIndex].slice(12).trim();
  if (definitionIndex >= 0) {
    for (let i = definitionIndex + 1; i < origin && /^ {12}\S/.test(lines[i]); i++) name += ` ${lines[i].trim()}`;
  }
  return {
    name: name || accession, accession, sequence, features, warnings,
    topology: /\bcircular\b/i.test(locus[3]) ? 'circular' : /\blinear\b/i.test(locus[3]) ? 'linear' : 'unknown',
    format: 'genbank', original: { name: inputName, text: `${raw}\n` },
  };
}

async function sha256(text: string): Promise<string> {
  const bytes = new TextEncoder().encode(text);
  const digest = await crypto.subtle.digest('SHA-256', bytes);
  return Array.from(new Uint8Array(digest), byte => byte.toString(16).padStart(2, '0')).join('');
}

function validateView(value: unknown): LocalGenomeView | undefined {
  if (value === undefined) return undefined;
  if (!value || typeof value !== 'object') throw new Error('Invalid imported view');
  const view = value as Record<string, unknown>;
  if (typeof view.contentId !== 'string' || !/^[a-f0-9]{64}$/.test(view.contentId)
    || !['dna', 'aa', 'dual'].includes(view.viewMode as string)
    || ![0, 1, 2, -1, -2, -3].includes(view.readingFrame as number)
    || !Number.isSafeInteger(view.scrollPosition) || (view.scrollPosition as number) < 0) throw new Error('Invalid imported view');
  return { contentId: view.contentId, viewMode: view.viewMode as ViewMode, readingFrame: view.readingFrame as ReadingFrame, scrollPosition: view.scrollPosition as number };
}

/** No network or filesystem operations. Run in a worker to permit hard cancellation. */
export async function importLocalGenomes(input: GenomeInput, onProgress?: (completed: number, total: number) => void): Promise<GenomeImportResult> {
  if (typeof input.name !== 'string' || input.name.length > 2000 || typeof input.text !== 'string') throw new Error('Invalid local input');
  if (new TextEncoder().encode(input.text).length > GENOME_IMPORT_LIMITS.bytes) throw new Error('Input exceeds the 10 MiB limit');
  const text = input.text.replace(/^\uFEFF/, '').replace(/\r\n?/g, '\n').trim();
  if (!text) throw new Error('Input is empty');
  let inputs: GenomeInput[] = [input];
  let view: LocalGenomeView | undefined;
  if (text.startsWith('{')) {
    const bundle = JSON.parse(text) as Record<string, unknown>;
    if (bundle.format !== 'phage-explorer-local-genomes' || bundle.version !== 1 || !Array.isArray(bundle.inputs)
      || !bundle.inputs.length || bundle.inputs.length > GENOME_IMPORT_LIMITS.records) throw new Error('Unsupported local genome bundle');
    inputs = bundle.inputs.map(item => {
      if (!item || typeof item !== 'object' || typeof item.name !== 'string' || item.name.length > 2000 || typeof item.text !== 'string') throw new Error('Invalid bundled input');
      if (item.text.trimStart().startsWith('{')) throw new Error('Nested input bundles are not supported');
      return { name: item.name, text: item.text };
    });
    view = validateView(bundle.view);
  }
  const records = inputs.flatMap(source => {
    const normalized = source.text.replace(/^\uFEFF/, '').replace(/\r\n?/g, '\n').trim();
    if (normalized.startsWith('>')) return parseFastaRecords({ name: source.name, text: normalized }).map(record => ({ ...record, original: source }));
    if (normalized.startsWith('LOCUS')) {
      const raws = normalized.split(/\n\/\/\s*(?:\n|$)/);
      if (raws[raws.length - 1].trim()) throw new Error('GenBank records must end with //');
      if (raws.length - 1 > GENOME_IMPORT_LIMITS.records) throw new Error('Import requires 1–100 records');
      return raws.slice(0, -1).map(raw => ({ ...parseGenbankRecord(`${raw.trim()}\n//`, source.name), original: source }));
    }
    throw new Error('Expected FASTA, GenBank or a version 1 local genome bundle');
  });
  if (!records.length || records.length > GENOME_IMPORT_LIMITS.records) throw new Error('Import requires 1–100 records');
  if (records.reduce((sum, record) => sum + record.features.length, 0) > GENOME_IMPORT_LIMITS.features) throw new Error('Import exceeds the 50,000-feature total limit');
  if (records.reduce((sum, record) => sum + record.sequence.length, 0) > GENOME_IMPORT_LIMITS.bases) throw new Error('Input exceeds the 5,000,000-base total limit');
  const genomes: LocalGenome[] = [];
  for (const record of records) {
    const contentId = await sha256(JSON.stringify({ version: 1, format: record.format, accession: record.accession, name: record.name, sequence: record.sequence, topology: record.topology, features: record.features }));
    const sequenceSha256 = await sha256(record.sequence);
    const id = -(Number.parseInt(contentId.slice(0, 13), 16) + 1);
    const existing = genomes.find(genome => genome.phage.id === id);
    if (existing && existing.phage.localGenome?.contentId !== contentId) throw new Error('Local identifier collision; records were not imported');
    if (existing) continue;
    const genes: GeneInfo[] = record.features.filter(feature => feature.segments && feature.type !== 'source').map((feature, index) => {
      const segments = feature.segments!;
      const strands = new Set(segments.map(segment => segment.strand));
      return {
        id: index + 1, name: feature.qualifiers.gene ?? null, locusTag: feature.qualifiers.locus_tag ?? null,
        type: feature.type, product: feature.qualifiers.product ?? null,
        startPos: Math.min(...segments.map(segment => segment.start)), endPos: Math.max(...segments.map(segment => segment.end)),
        strand: strands.size === 1 ? segments[0].strand : null,
        qualifiers: { ...feature.qualifiers, _location: feature.location, ...(segments.length > 1 ? { _segments: segments } : {}) },
      };
    });
    let known = 0;
    let gc = 0;
    for (const base of record.sequence) {
      if (base === 'G' || base === 'C') { gc++; known++; }
      else if (base === 'A' || base === 'T') known++;
    }
    const ambiguous = record.sequence.length - known;
    if (ambiguous) record.warnings.push(`${ambiguous} ambiguous bases retained; GC excludes them, and reference-dependent analyses may be unavailable.`);
    genomes.push({
      sequence: record.sequence, original: record.original, warnings: record.warnings,
      phage: {
        id, slug: `local-${contentId}`, name: record.name, accession: record.accession,
        genomeLength: record.sequence.length, gcContent: known ? 100 * gc / known : null,
        family: null, host: null, morphology: null, lifecycle: null, description: `Local ${record.format} record; ${record.topology} topology.`,
        baltimoreGroup: null, genomeType: 'DNA', pdbIds: [], genes, codonUsage: null, hasModel: false,
        localGenome: { contentId, sequenceSha256, format: record.format, topology: record.topology },
      },
    });
    onProgress?.(genomes.length, records.length);
  }
  if (view && !genomes.some(genome => genome.phage.localGenome?.contentId === view.contentId && view.scrollPosition < genome.sequence.length)) {
    throw new Error('Imported view does not refer to a bundled genome position');
  }
  return { genomes, ...(view ? { view } : {}) };
}

export function exportLocalGenomeBundle(genomes: readonly LocalGenome[], view?: LocalGenomeView): string {
  const inputs = new Map<string, GenomeInput>();
  for (const genome of genomes) inputs.set(JSON.stringify(genome.original), genome.original);
  return JSON.stringify({ format: 'phage-explorer-local-genomes', version: 1, inputs: [...inputs.values()], ...(view ? { view } : {}) }, null, 2);
}
