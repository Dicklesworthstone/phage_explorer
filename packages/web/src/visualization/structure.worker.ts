// structure.worker.ts
// Worker for offloading heavy structure parsing and graph analysis
// (parsing PDB/MMCIF, bond detection, functional group detection)

import {
  type AtomRecord,
  type Bond,
  type FunctionalGroup,
  type FunctionalGroupType,
} from './structure-loader';

// --- Worker-local Types (mirroring structure-loader but without Three.js deps) ---
// We can't import Three.js here easily in a standard worker setup without careful bundling,
// and we want to keep the worker payload small. We only need the geometric data.

// Simplified Functional Group for transfer
interface SerializedFunctionalGroup {
  type: FunctionalGroupType;
  atomIndices: number[];
  colorHex: string; // Transfer color as hex string
}

export interface WorkerInput {
  text: string;
  format: 'pdb' | 'mmcif';
}

export interface WorkerOutput {
  atoms: AtomRecord[];
  bonds: Bond[];
  backboneTraces: { x: number; y: number; z: number }[][];
  chains: string[];
  center: { x: number; y: number; z: number };
  radius: number;
  functionalGroups: SerializedFunctionalGroup[];
}

// --- Logic duplicated/adapted from structure-loader.ts to run in worker ---
// Note: ELEMENT_RADII needed for bond detection
const ELEMENT_RADII: Record<string, number> = {
  H: 0.31, C: 0.76, N: 0.71, O: 0.66, S: 1.05, P: 1.07,
};

const FUNCTIONAL_GROUP_COLORS_HEX: Record<FunctionalGroupType, string> = {
  aromatic: '#c084fc',
  disulfide: '#facc15',
  phosphate: '#fb923c',
};

function parsePDB(text: string): AtomRecord[] {
  const atoms: AtomRecord[] = [];
  const lines = text.split(/\r?\n/);
  for (const line of lines) {
    if (!line.startsWith('ATOM') && !line.startsWith('HETATM')) continue;
    const atomName = line.slice(12, 16).trim();
    const x = parseFloat(line.slice(30, 38));
    const y = parseFloat(line.slice(38, 46));
    const z = parseFloat(line.slice(46, 54));
    const element = (line.slice(76, 78).trim() || line.slice(12, 14).trim()).toUpperCase();
    const chainId = line.slice(21, 22).trim() || 'A';
    const resSeq = parseInt(line.slice(22, 26).trim() || '0', 10);
    const resName = line.slice(17, 20).trim() || 'UNK';
    if (Number.isFinite(x) && Number.isFinite(y) && Number.isFinite(z)) {
      atoms.push({ x, y, z, element, atomName, chainId, resSeq, resName });
    }
  }
  return atoms;
}

function parseMMCIF(text: string): AtomRecord[] {
  const atoms: AtomRecord[] = [];
  const lines = text.split(/\r?\n/);
  const headers: string[] = [];
  let inAtomLoop = false;
  let dataStart = 0;

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i].trim();
    if (line === 'loop_') {
      inAtomLoop = true;
      continue;
    }
    if (inAtomLoop && line.startsWith('_atom_site.')) {
      headers.push(line);
      continue;
    }
    if (inAtomLoop && headers.length > 0 && !line.startsWith('_atom_site.')) {
      dataStart = i;
      break;
    }
  }

  if (headers.length === 0 || dataStart === 0) return atoms;

  const colIndex = (name: string) => headers.findIndex(h => h.includes(name));
  const xIdx = colIndex('Cartn_x');
  const yIdx = colIndex('Cartn_y');
  const zIdx = colIndex('Cartn_z');
  const elIdx = colIndex('type_symbol');
  const atomNameIdx = colIndex('label_atom_id');
  const chainIdx = colIndex('auth_asym_id');
  const resSeqIdx = colIndex('auth_seq_id');
  const resNameIdx = colIndex('auth_comp_id');

  for (let i = dataStart; i < lines.length; i++) {
    const line = lines[i].trim();
    if (line.startsWith('#') || line.startsWith('loop_') || line === '') break;
    const parts = line.split(/\s+/);
    const pick = (idx: number, fallback = '') => (idx >= 0 ? parts[idx] ?? fallback : fallback);
    const x = parseFloat(pick(xIdx, 'NaN'));
    const y = parseFloat(pick(yIdx, 'NaN'));
    const z = parseFloat(pick(zIdx, 'NaN'));
    const element = pick(elIdx, 'C').toUpperCase();
    const atomName = pick(atomNameIdx, '').toUpperCase() || element;
    const chainId = pick(chainIdx, 'A') || 'A';
    const resSeq = parseInt(pick(resSeqIdx, '0'), 10);
    const resName = pick(resNameIdx, 'UNK').toUpperCase();
    if (Number.isFinite(x) && Number.isFinite(y) && Number.isFinite(z)) {
      atoms.push({ x, y, z, element, atomName, chainId, resSeq, resName });
    }
  }

  return atoms;
}

function detectBonds(atoms: AtomRecord[]): Bond[] {
  const bonds: Bond[] = [];
  // Simple spatial hashing could speed this up, but keeping it O(N^2) for simplicity in worker
  // (Moving to worker fixes the UI freeze regardless of optimization)
  for (let i = 0; i < atoms.length; i++) {
    for (let j = i + 1; j < atoms.length; j++) {
      const a = atoms[i];
      const b = atoms[j];
      const dx = a.x - b.x;
      const dy = a.y - b.y;
      const dz = a.z - b.z;
      const dist2 = dx * dx + dy * dy + dz * dz;
      const r1 = ELEMENT_RADII[a.element] ?? 0.8;
      const r2 = ELEMENT_RADII[b.element] ?? 0.8;
      const threshold = (r1 + r2) * 1.25;
      if (dist2 <= threshold * threshold) {
        bonds.push({ a: i, b: j });
      }
    }
  }
  return bonds;
}

function buildBackboneTraces(atoms: AtomRecord[]): { x: number; y: number; z: number }[][] {
  const chainMap = new Map<string, AtomRecord[]>();
  for (const atom of atoms) {
    if (atom.atomName !== 'CA' && atom.atomName !== 'C' && atom.atomName !== 'N') continue;
    if (!chainMap.has(atom.chainId)) chainMap.set(atom.chainId, []);
    chainMap.get(atom.chainId)!.push(atom);
  }
  const traces: { x: number; y: number; z: number }[][] = [];
  for (const [, chainAtoms] of chainMap) {
    const sorted = chainAtoms.sort((a, b) => a.resSeq - b.resSeq);
    traces.push(sorted.map(a => ({ x: a.x, y: a.y, z: a.z })));
  }
  return traces;
}

// --- Functional Group Detection ---

function buildAdjacency(atoms: AtomRecord[], bonds: Bond[]): number[][] {
  const adj: number[][] = Array.from({ length: atoms.length }, () => []);
  for (const { a, b } of bonds) {
    adj[a].push(b);
    adj[b].push(a);
  }
  return adj;
}

function detectAromaticRings(atoms: AtomRecord[], bonds: Bond[]): SerializedFunctionalGroup[] {
  const adj = buildAdjacency(atoms, bonds);
  const rings: SerializedFunctionalGroup[] = [];
  const isCarbon = (idx: number) => atoms[idx].element.toUpperCase() === 'C';
  const maxPlanarOffset = 0.25;

  for (let start = 0; start < atoms.length; start++) {
    if (!isCarbon(start)) continue;
    const stack: number[] = [start];
    const visited = new Set<number>([start]);

    const dfs = (current: number, depth: number) => {
      if (depth === 5) {
        for (const next of adj[current]) {
          if (next === start) {
            const ring = [...stack];
            if (ring.some(idx => idx < start)) continue;
            if (!ring.every(isCarbon)) continue;
            if (isPlanarRing(ring, atoms, maxPlanarOffset)) {
              rings.push({
                type: 'aromatic',
                atomIndices: ring,
                colorHex: FUNCTIONAL_GROUP_COLORS_HEX.aromatic,
              });
            }
          }
        }
        return;
      }
      for (const next of adj[current]) {
        if (next === start) continue;
        if (next <= start) continue;
        if (visited.has(next)) continue;
        visited.add(next);
        stack.push(next);
        dfs(next, depth + 1);
        stack.pop();
        visited.delete(next);
      }
    };
    dfs(start, 1);
  }
  return rings;
}

function isPlanarRing(indices: number[], atoms: AtomRecord[], tolerance: number): boolean {
  // Geometric check logic adapted for plain objects (no Vector3 class)
  if (indices.length < 3) return false;
  const [i0, i1, i2] = indices;
  // Vector subtraction/cross/normalize manual implementation
  const ax = atoms[i0].x, ay = atoms[i0].y, az = atoms[i0].z;
  const bx = atoms[i1].x, by = atoms[i1].y, bz = atoms[i1].z;
  const cx = atoms[i2].x, cy = atoms[i2].y, cz = atoms[i2].z;

  const v1x = bx - ax, v1y = by - ay, v1z = bz - az;
  const v2x = cx - ax, v2y = cy - ay, v2z = cz - az;

  // Cross product
  let nx = v1y * v2z - v1z * v2y;
  let ny = v1z * v2x - v1x * v2z;
  let nz = v1x * v2y - v1y * v2x;

  // Normalize
  const len = Math.sqrt(nx * nx + ny * ny + nz * nz);
  if (len === 0) return false;
  nx /= len; ny /= len; nz /= len;

  // Distance to plane
  for (const idx of indices) {
    const px = atoms[idx].x, py = atoms[idx].y, pz = atoms[idx].z;
    const dist = Math.abs(nx * (px - ax) + ny * (py - ay) + nz * (pz - az));
    if (dist > tolerance) return false;
  }
  return true;
}

function detectDisulfides(atoms: AtomRecord[], bonds: Bond[]): SerializedFunctionalGroup[] {
  const adj = buildAdjacency(atoms, bonds);
  const groups: SerializedFunctionalGroup[] = [];
  const sulfurIdx = atoms
    .map((atom, idx) => ({ atom, idx }))
    .filter(({ atom }) => atom.element.toUpperCase() === 'S')
    .map(({ idx }) => idx);

  for (let i = 0; i < sulfurIdx.length; i++) {
    for (let j = i + 1; j < sulfurIdx.length; j++) {
      const a = sulfurIdx[i];
      const b = sulfurIdx[j];
      const bonded = adj[a].includes(b);
      const dx = atoms[a].x - atoms[b].x;
      const dy = atoms[a].y - atoms[b].y;
      const dz = atoms[a].z - atoms[b].z;
      const dist = Math.sqrt(dx * dx + dy * dy + dz * dz);
      if (bonded || dist <= 2.2) {
        groups.push({
          type: 'disulfide',
          atomIndices: [a, b],
          colorHex: FUNCTIONAL_GROUP_COLORS_HEX.disulfide,
        });
      }
    }
  }
  return groups;
}

function detectPhosphates(atoms: AtomRecord[], bonds: Bond[]): SerializedFunctionalGroup[] {
  const adj = buildAdjacency(atoms, bonds);
  const groups: SerializedFunctionalGroup[] = [];
  atoms.forEach((atom, idx) => {
    if (atom.element.toUpperCase() !== 'P') return;
    const oxyNeighbors = adj[idx].filter(n => atoms[n].element.toUpperCase() === 'O');
    if (oxyNeighbors.length >= 3) {
      groups.push({
        type: 'phosphate',
        atomIndices: [idx, ...oxyNeighbors],
        colorHex: FUNCTIONAL_GROUP_COLORS_HEX.phosphate,
      });
    }
  });
  return groups;
}

self.onmessage = (e: MessageEvent<WorkerInput>) => {
  const { text, format } = e.data;
  
  try {
    const atoms = format === 'mmcif' ? parseMMCIF(text) : parsePDB(text);
    if (atoms.length === 0) {
      throw new Error('No atoms parsed from structure file');
    }

    const bonds = detectBonds(atoms);
    const backboneTraces = buildBackboneTraces(atoms);
    const chains = Array.from(new Set(atoms.map(a => a.chainId)));
    
    // Functional Groups
    const rings = detectAromaticRings(atoms, bonds);
    const disulfides = detectDisulfides(atoms, bonds);
    const phosphates = detectPhosphates(atoms, bonds);
    const functionalGroups = [...rings, ...disulfides, ...phosphates];

    // Compute bounds
    let minX = Infinity, minY = Infinity, minZ = Infinity;
    let maxX = -Infinity, maxY = -Infinity, maxZ = -Infinity;

    for (const atom of atoms) {
      minX = Math.min(minX, atom.x);
      minY = Math.min(minY, atom.y);
      minZ = Math.min(minZ, atom.z);
      maxX = Math.max(maxX, atom.x);
      maxY = Math.max(maxY, atom.y);
      maxZ = Math.max(maxZ, atom.z);
    }

    const center = {
      x: (minX + maxX) / 2,
      y: (minY + maxY) / 2,
      z: (minZ + maxZ) / 2,
    };
    
    const sizeX = maxX - minX;
    const sizeY = maxY - minY;
    const sizeZ = maxZ - minZ;
    const radius = Math.sqrt(sizeX*sizeX + sizeY*sizeY + sizeZ*sizeZ) / 2 || 1;

    const result: WorkerOutput = {
      atoms,
      bonds,
      backboneTraces,
      chains,
      center,
      radius,
      functionalGroups,
    };

    self.postMessage({ type: 'success', data: result });

  } catch (err) {
    self.postMessage({ type: 'error', error: err instanceof Error ? err.message : String(err) });
  }
};
