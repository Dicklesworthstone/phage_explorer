// NCBI E-utilities fetcher for phage sequences
// API documentation: https://www.ncbi.nlm.nih.gov/books/NBK25499/

const NCBI_BASE_URL = 'https://eutils.ncbi.nlm.nih.gov/entrez/eutils';
const RATE_LIMIT_MS = 350; // ~3 requests per second without API key

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
  start: number;
  end: number;
  strand: '+' | '-';
  gene?: string;
  locusTag?: string;
  product?: string;
  qualifiers: Record<string, string>;
  segments?: Array<{ start: number; end: number }>;
}

// Sleep helper for rate limiting
function sleep(ms: number): Promise<void> {
  return new Promise(resolve => setTimeout(resolve, ms));
}

// Fetch sequence in FASTA format
export async function fetchFasta(accession: string): Promise<string> {
  const url = `${NCBI_BASE_URL}/efetch.fcgi?db=nuccore&id=${encodeURIComponent(accession)}&rettype=fasta&retmode=text`;

  const response = await fetch(url);
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

  const response = await fetch(url);
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

// Parse GenBank format to extract sequence and features
export function parseGenBank(genbank: string): NCBISequenceResult {
  const lines = genbank.split('\n');
  let accession = '';
  const sequenceParts: string[] = []; // Use array for O(N) concatenation
  const features: NCBIFeature[] = [];
  const metadata: Record<string, string> = {};

  let inSequence = false;
  let inFeatures = false;
  let currentFeature: Partial<NCBIFeature> | null = null;
  let currentQualifierKey = '';
  let currentQualifierValue = '';

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];

    // Parse accession
    if (line.startsWith('ACCESSION')) {
      accession = line.replace('ACCESSION', '').trim().split(/\s+/)[0];
    }

    // Parse definition
    if (line.startsWith('DEFINITION')) {
      metadata['definition'] = line.replace('DEFINITION', '').trim();
    }

    // Parse organism
    if (line.startsWith('  ORGANISM')) {
      metadata['organism'] = line.replace('  ORGANISM', '').trim();
    }

    // Feature section
    if (line.startsWith('FEATURES')) {
      inFeatures = true;
      continue;
    }

    // Sequence section
    if (line.startsWith('ORIGIN')) {
      inFeatures = false;
      inSequence = true;
      if (currentFeature && currentFeature.type) {
        // Save pending qualifier for the last feature
        if (currentQualifierKey && currentQualifierValue) {
          currentFeature.qualifiers![currentQualifierKey] = currentQualifierValue.replace(/^"|"$/g, '');
        }
        features.push(currentFeature as NCBIFeature);
      }
      continue;
    }

    // End of record
    if (line.startsWith('//')) {
      break;
    }

    // Parse features
    if (inFeatures) {
      // New feature (starts at column 5)
      if (line.length > 5 && line[5] !== ' ' && !line.startsWith('FEATURES')) {
        // Save previous feature
        if (currentFeature && currentFeature.type) {
          if (currentQualifierKey && currentQualifierValue) {
            currentFeature.qualifiers![currentQualifierKey] = currentQualifierValue.replace(/^"|"$/g, '');
          }
          features.push(currentFeature as NCBIFeature);
        }

        // Parse new feature line
        const featurePart = line.substring(5, 21).trim();
        let locationPart = line.substring(21).trim();

        // Handle multi-line locations
        let nextLineIdx = i + 1;
        while (nextLineIdx < lines.length) {
          const nextLine = lines[nextLineIdx];
          // Check if it's a continuation line (starts with spaces, no '/')
          // It must NOT be a qualifier (start with /) and must NOT be a new feature (start at col 5)
          // Location continuations are usually indented to col 21, but we relax to 20+
          if (
            nextLine.match(/^\s{20,}/) &&
            !nextLine.trim().startsWith('/') &&
            !nextLine.substring(5, 21).trim()
          ) {
            locationPart += nextLine.trim();
            i++; // Advance main loop
            nextLineIdx++;
          } else {
            break;
          }
        }

        currentFeature = {
          type: featurePart,
          qualifiers: {},
          strand: '+',
          start: 0,
          end: 0,
        };
        currentQualifierKey = '';
        currentQualifierValue = '';

        // Parse location (simplified - handles most common cases)
        parseLocation(locationPart, currentFeature);
      }
      // Qualifier line (starts with / after the standard qualifier indentation)
      else if (line.match(/^\s{20,}\/\w+/) && currentFeature) {
        // Save previous qualifier
        if (currentQualifierKey && currentQualifierValue) {
          currentFeature.qualifiers![currentQualifierKey] = currentQualifierValue.replace(/^"|"$/g, '');
        }

        const qualMatch = line.match(/\/(\w+)(?:=(.*))?/);
        if (qualMatch) {
          currentQualifierKey = qualMatch[1];
          currentQualifierValue = qualMatch[2] || '';

          // Special handling for common qualifiers
          if (currentQualifierKey === 'gene') {
            currentFeature.gene = currentQualifierValue.replace(/^"|"$/g, '');
          } else if (currentQualifierKey === 'locus_tag') {
            currentFeature.locusTag = currentQualifierValue.replace(/^"|"$/g, '');
          } else if (currentQualifierKey === 'product') {
            currentFeature.product = currentQualifierValue.replace(/^"|"$/g, '');
          }
        }
      }
      // Continuation of qualifier value (relaxed indentation check)
      else if (line.match(/^\s{20,}/) && currentQualifierKey) {
        const part = line.trim();
        const needsSpace = ['product', 'note', 'function', 'inference', 'standard_name', 'organism'].includes(currentQualifierKey);
        
        if (needsSpace && currentQualifierValue.length > 0 && !currentQualifierValue.endsWith('-') && !currentQualifierValue.endsWith('"')) {
          currentQualifierValue += ' ' + part;
        } else {
          currentQualifierValue += part;
        }
      }
    }

    // Parse sequence
    if (inSequence && line.match(/^\s*\d+/)) {
      sequenceParts.push(line.replace(/[\d\s\/]/g, '').toUpperCase());
    }
  }

  const sequence = sequenceParts.join('');

  // Calculate GC content
  let gc = 0;
  let total = 0;
  for (const c of sequence) {
    if (c === 'G' || c === 'C') gc++;
    if (c === 'A' || c === 'T' || c === 'G' || c === 'C') total++;
  }
  const gcContent = total > 0 ? (gc / total) * 100 : 0;

  return {
    accession,
    sequence,
    length: sequence.length,
    gcContent,
    features: features.filter(f => 
      ['CDS', 'gene', 'tRNA', 'rRNA', 'tmRNA', 'ncRNA', 'mobile_element', 'repeat_region', 'misc_feature', 'regulatory'].includes(f.type)
    ),
    metadata,
  };
}

/**
 * Split a location expression on a delimiter, but only at the top nesting level
 * of parentheses. Used to separate the sub-locations inside join(...).
 */
function splitTopLevel(input: string, delimiter: string): string[] {
  const parts: string[] = [];
  let depth = 0;
  let current = '';
  for (const ch of input) {
    if (ch === '(') {
      depth++;
    } else if (ch === ')') {
      depth--;
    }
    if (depth === 0 && ch === delimiter) {
      parts.push(current);
      current = '';
    } else {
      current += ch;
    }
  }
  if (current.length > 0) parts.push(current);
  return parts;
}

/**
 * Parse a single GenBank location segment of the forms:
 *   start..end, complement(start..end), start, or complement(start)
 * Returns null for unsupported syntax.
 */
function parseSegment(segment: string): { start: number; end: number } | null {
  const trimmed = segment.trim();
  const rangeMatch = trimmed.match(/^complement\((\d+)\.\.(\d+)\)$/) || trimmed.match(/^(\d+)\.\.(\d+)$/);
  if (rangeMatch) {
    const start = parseInt(rangeMatch[1], 10);
    const end = parseInt(rangeMatch[2], 10);
    // GenBank is 1-based inclusive. Convert to 0-based half-open [start, end).
    return { start: Math.max(0, start - 1), end };
  }
  const pointMatch = trimmed.match(/^complement\((\d+)\)$/) || trimmed.match(/^(\d+)$/);
  if (pointMatch) {
    const p = parseInt(pointMatch[1], 10);
    return { start: Math.max(0, p - 1), end: p };
  }
  return null;
}

// Parse feature location string to find total extent (min start, max end)
function parseLocation(location: string, feature: Partial<NCBIFeature>): void {
  // Remove accession references (e.g., "NC_001234.1:")
  const localLocation = location.replace(/[A-Z][A-Z0-9_]*\.[0-9]+:/g, '').replace(/\s+/g, '');

  // Detect top-level complement and join wrappers
  const isComplement = localLocation.startsWith('complement(');
  const isJoin = localLocation.includes('join(');

  feature.strand = isComplement ? '-' : '+';

  // Strip the outer wrapper(s) to get the inner expression
  let body = localLocation;
  if (isComplement && body.endsWith(')')) {
    body = body.slice('complement('.length, -1);
  }
  if (body.startsWith('join(') && body.endsWith(')')) {
    body = body.slice('join('.length, -1);
  }

  const segments: Array<{ start: number; end: number }> = [];
  for (const part of splitTopLevel(body, ',')) {
    const seg = parseSegment(part);
    if (seg) segments.push(seg);
  }

  if (segments.length === 0) return;

  // For a complement(join(...)), the coding order is the reverse of the
  // genomic order. The strand '-' flag triggers reverse-complementing later,
  // so here we only need to list exons in transcript order.
  if (isComplement && isJoin) {
    segments.reverse();
  }

  // Compute bounding box
  let min = Infinity;
  let max = -Infinity;
  for (const seg of segments) {
    if (seg.start < min) min = seg.start;
    if (seg.end > max) max = seg.end;
  }

  feature.start = min;
  feature.end = max;

  // Only store segments if there are multiple (e.g. join or distinct regions)
  if (segments.length > 1) {
    feature.segments = segments;
  }
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
