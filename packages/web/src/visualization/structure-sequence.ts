/** Shared coordinate parsing and exact sequence-to-CDS correspondence.
 * No renderer dependency: the structure worker and genome navigation use the same identities.
 */
import type { GeneInfo } from '../../../core/src/types';
import { reconstructCdsReference, type CdsReference } from '../../../core/src/analysis/cds-consequences';
import { mapCdsResidueRange } from '../../../core/src/phase-portraits';

export interface AtomRecord {
  x: number; y: number; z: number;
  element: string; atomName: string; chainId: string; resSeq: number; resName: string;
  insertionCode?: string;
  /** mmCIF polymer/chain identifiers are independent of the author's residue numbering. */
  labelChainId?: string;
  labelSeqId?: number;
}

/** Preserve the author residue and insertion code; never conflate chains sharing an author label. */
export function structureResidueKey(atom: AtomRecord): string {
  return JSON.stringify([atom.labelChainId ?? atom.chainId, atom.resSeq, atom.insertionCode ?? '']);
}

// wwPDB ATOM/MODEL conventions: https://www.wwpdb.org/documentation/file-format-content/format33/sect9.html
export function parsePDB(text: string): AtomRecord[] {
  const atoms: AtomRecord[] = [];
  let modelSeen = false;
  for (const line of text.split(/\r?\n/)) {
    if (line.startsWith('MODEL ')) {
      if (modelSeen || atoms.length) break;
      modelSeen = true;
      continue;
    }
    if (line.startsWith('ENDMDL')) break;
    if (!line.startsWith('ATOM  ') && !line.startsWith('HETATM')) continue;
    const atomName = line.slice(12, 16).trim().toUpperCase();
    const x = Number.parseFloat(line.slice(30, 38)), y = Number.parseFloat(line.slice(38, 46)), z = Number.parseFloat(line.slice(46, 54));
    const element = (line.slice(76, 78).trim() || line.slice(12, 14).trim()).toUpperCase();
    const chainId = line.slice(21, 22).trim() || 'A';
    const resSeq = Number.parseInt(line.slice(22, 26).trim(), 10);
    const insertionCode = line.slice(26, 27).trim();
    const resName = line.slice(17, 20).trim().toUpperCase() || 'UNK';
    if ([x, y, z].every(Number.isFinite)) atoms.push({ x, y, z, element, atomName, chainId, resSeq, resName, insertionCode });
  }
  return atoms;
}

function cifTokens(line: string): string[] {
  const tokens: string[] = [];
  let i = 0;
  while (i < line.length) {
    while (/\s/.test(line[i] ?? '') && i < line.length) i++;
    if (i === line.length || line[i] === '#') break;
    const quote = line[i];
    if (quote === '"' || quote === "'") {
      const start = ++i;
      while (i < line.length && !(line[i] === quote && (i + 1 === line.length || /\s/.test(line[i + 1])))) i++;
      if (i === line.length) throw new Error('Unclosed quoted atom_site value.');
      tokens.push(line.slice(start, i++));
    } else {
      const start = i;
      while (i < line.length && !/\s/.test(line[i])) i++;
      tokens.push(line.slice(start, i));
    }
  }
  return tokens;
}

// label_seq_id includes unmodeled polymer residues; auth_seq_id is only an author label.
// https://mmcif.wwpdb.org/docs/user-guide/resources/coordinate_section.html
export function parseMMCIF(text: string): AtomRecord[] {
  const atoms: AtomRecord[] = [], lines = text.split(/\r?\n/), headers: string[] = [];
  let i = 0;
  for (; i < lines.length; i++) {
    const line = lines[i].trim();
    if (line.startsWith('_atom_site.')) headers.push(line);
    else if (headers.length && line) break;
  }
  if (!headers.length) return atoms;
  const index = (name: string) => headers.indexOf('_atom_site.' + name);
  const cols = Object.fromEntries(['Cartn_x', 'Cartn_y', 'Cartn_z', 'type_symbol', 'label_atom_id', 'auth_atom_id',
    'auth_asym_id', 'label_asym_id', 'auth_seq_id', 'label_seq_id', 'auth_comp_id', 'label_comp_id',
    'pdbx_PDB_ins_code', 'pdbx_PDB_model_num', 'group_PDB'].map(name => [name, index(name)]));
  let pending: string[] = [], firstModel: string | null = null;
  for (; i < lines.length; i++) {
    const line = lines[i].trim();
    if (!line) continue;
    if (line.startsWith('#') || line === 'loop_' || line.startsWith('_') || line.startsWith('data_')) break;
    if (lines[i].startsWith(';')) throw new Error('Multiline atom_site values are unsupported.');
    pending.push(...cifTokens(line));
    while (pending.length >= headers.length) {
      const row = pending.slice(0, headers.length); pending = pending.slice(headers.length);
      const pick = (name: string, fallback = '') => {
        const value = cols[name] >= 0 ? row[cols[name]] : undefined;
        return value === undefined || value === '.' || value === '?' ? fallback : value;
      };
      const group = pick('group_PDB', 'ATOM');
      if (group !== 'ATOM' && group !== 'HETATM') continue;
      const model = pick('pdbx_PDB_model_num', '1');
      firstModel ??= model;
      if (model !== firstModel) continue;
      const x = Number.parseFloat(pick('Cartn_x')), y = Number.parseFloat(pick('Cartn_y')), z = Number.parseFloat(pick('Cartn_z'));
      const element = pick('type_symbol', 'C').toUpperCase();
      const atomName = pick('label_atom_id', pick('auth_atom_id', element)).toUpperCase();
      const labelChainId = pick('label_asym_id') || undefined;
      const chainId = pick('auth_asym_id', labelChainId ?? 'A');
      const label = Number(pick('label_seq_id', 'NaN'));
      const labelSeqId = Number.isSafeInteger(label) && label > 0 ? label : undefined;
      const auth = pick('auth_seq_id', String(labelSeqId ?? 'NaN'));
      const resSeq = /^-?\d+$/.test(auth) ? Number(auth) : NaN;
      const resName = pick('auth_comp_id', pick('label_comp_id', 'UNK')).toUpperCase();
      const insertionCode = pick('pdbx_PDB_ins_code');
      if ([x, y, z].every(Number.isFinite)) atoms.push({ x, y, z, element, atomName, chainId, resSeq, resName,
        insertionCode, ...(labelChainId ? { labelChainId } : {}), ...(labelSeqId ? { labelSeqId } : {}) });
    }
  }
  if (pending.length) throw new Error('Incomplete atom_site row.');
  return atoms;
}

const AMINO_ACIDS: Record<string, string> = {
  ALA: 'A', ARG: 'R', ASN: 'N', ASP: 'D', CYS: 'C', GLN: 'Q', GLU: 'E', GLY: 'G', HIS: 'H', ILE: 'I',
  LEU: 'L', LYS: 'K', MET: 'M', PHE: 'F', PRO: 'P', SER: 'S', THR: 'T', TRP: 'W', TYR: 'Y', VAL: 'V',
};
export interface StructureGenomeResidue {
  geneId: number;
  geneLabel: string;
  /** One-based conceptual protein position; genomic segments remain zero-based, half-open. */
  proteinPosition: number;
  genomeSegments: CdsReference['segments'];
  genomePos: number;
  matchedResidues: number;
  method: 'polymer-sequence-offset' | 'unique-contiguous-sequence';
}
interface ObservedResidue { key: string; aa: string; labelSeqId?: number }
interface Match { reference: CdsReference; positions: Array<number | null>; method: StructureGenomeResidue['method'] }

/** Without polymer indices, only an uninterrupted exact sequence is supported.
 * Missing coordinate residues must not be placed using an arbitrary-gapped alignment.
 */
function contiguousPositions(observed: string, protein: string): Array<number | null> | null {
  const start = protein.indexOf(observed);
  if (start < 0) return null;
  if (protein.indexOf(observed, start + 1) >= 0) return Array.from(observed, () => null);
  return Array.from(observed, (_, i) => start + i);
}

function polymerPositions(rows: ObservedResidue[], protein: string): Array<number | null> | null {
  const first = rows[0].labelSeqId!, offsets = rows.map(row => row.labelSeqId! - first);
  if (offsets.some((offset, i) => offset < 0 || i > 0 && offset <= offsets[i - 1])) return null;
  // Use the longest observed contiguous stretch as an exact search anchor.
  let start = 0, bestStart = 0, bestLength = 1;
  for (let i = 1; i <= rows.length; i++) {
    if (i === rows.length || offsets[i] !== offsets[i - 1] + 1) {
      if (i - start > bestLength) { bestStart = start; bestLength = i - start; }
      start = i;
    }
  }
  const anchor = rows.slice(bestStart, bestStart + bestLength).map(row => row.aa).join('');
  let position = protein.indexOf(anchor), matched: Array<number | null> | null = null;
  while (position >= 0) {
    const origin = position - offsets[bestStart];
    if (origin >= 0 && origin + offsets[offsets.length - 1] < protein.length &&
      rows.every((row, i) => protein[origin + offsets[i]] === row.aa)) {
      if (matched) return matched.map(() => null); // Repeated exact placements cannot select a residue.
      matched = offsets.map(offset => origin + offset);
    }
    position = protein.indexOf(anchor, position + 1);
  }
  return matched;
}

/** Map only observed canonical residues that agree with one complete genomic CDS.
 * Full-genome bases are supplied by the active repository. No gene-name, length,
 * affinity or homology inference is used, and ambiguous residue placements stay unmapped.
 */
export function buildStructureResidueMappings(atoms: readonly AtomRecord[], genes: readonly GeneInfo[], genome: string): Map<string, StructureGenomeResidue> {
  const mappings = new Map<string, StructureGenomeResidue>();
  const bases = genome.toUpperCase();
  const references = genes.filter(gene => gene.type === 'CDS' &&
    !/[<>]/.test(String(gene.qualifiers?._location ?? '')) && !Object.hasOwn(gene.qualifiers ?? {}, 'partial'))
    .map(gene => reconstructCdsReference(gene, bases))
    .filter(reference => reference.reasons.length === 0 && reference.protein !== null)
    .map(reference => ({ reference, protein: reference.protein!.replace(/\*$/, '') }));
  const chains = new Map<string, { rows: Map<string, ObservedResidue>; invalid: boolean }>();
  for (const atom of atoms) {
    const aa = AMINO_ACIDS[atom.resName];
    if (!aa && !(atom.atomName === 'CA' && atom.element === 'C')) continue;
    const chainId = atom.labelChainId ?? atom.chainId;
    let chain = chains.get(chainId);
    if (!chain) { chain = { rows: new Map(), invalid: false }; chains.set(chainId, chain); }
    if (!aa || !Number.isSafeInteger(atom.resSeq)) { chain.invalid = true; continue; }
    const key = structureResidueKey(atom), previous = chain.rows.get(key);
    if (previous && (previous.aa !== aa || previous.labelSeqId !== atom.labelSeqId)) chain.invalid = true;
    else if (!previous) chain.rows.set(key, { key, aa, labelSeqId: atom.labelSeqId });
  }
  // Repeated assembly chains share the expensive sequence matching, never residue identities.
  const cache = new Map<string, Match | null>();
  for (const chain of chains.values()) {
    const rows = [...chain.rows.values()];
    if (chain.invalid || rows.length < 8) continue;
    const hasLabels = rows.every(row => Number.isSafeInteger(row.labelSeqId) && row.labelSeqId! > 0);
    if (!hasLabels && rows.some(row => row.labelSeqId !== undefined)) continue;
    if (hasLabels) rows.sort((a, b) => a.labelSeqId! - b.labelSeqId!);
    const observed = rows.map(row => row.aa).join('');
    const signature = JSON.stringify([observed, hasLabels ? rows.map(row => row.labelSeqId! - rows[0].labelSeqId!) : null]);
    if (!cache.has(signature)) {
      let match: Match | null = null;
      for (const { reference, protein } of references) {
        if (protein.length < rows.length) continue;
        const positions = hasLabels ? polymerPositions(rows, protein) : contiguousPositions(observed, protein);
        if (!positions) continue;
        if (match) { match = null; break; }
        match = { reference, positions, method: hasLabels ? 'polymer-sequence-offset' : 'unique-contiguous-sequence' };
      }
      cache.set(signature, match);
    }
    const match = cache.get(signature);
    if (!match) continue;
    rows.forEach((row, i) => {
      const position = match.positions[i];
      if (position === null) return;
      const genomeSegments = mapCdsResidueRange(match.reference, position, position + 1), first = genomeSegments[0];
      if (!first) return;
      mappings.set(row.key, {
        geneId: match.reference.geneId, geneLabel: match.reference.product ?? match.reference.name,
        proteinPosition: position + 1, genomeSegments,
        genomePos: first.strand === '+' ? first.start : first.end - 1,
        matchedResidues: rows.length, method: match.method,
      });
    });
  }
  return mappings;
}
