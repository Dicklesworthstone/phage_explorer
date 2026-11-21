// structure.worker.ts
// Worker for offloading heavy structure parsing and graph analysis
// (parsing PDB/MMCIF, bond detection, functional group detection)
//
// PERFORMANCE: Uses WASM spatial-hash bond detection for O(N) complexity
// instead of O(N²) JS implementation. Critical for large structures.

import {
  type Bond,
  type FunctionalGroupType,
} from './structure-loader';
import { parsePDB, parseMMCIF, type AtomRecord } from './structure-sequence';

// --- WASM Module Loading ---
// Use centralized loader for consistent initialization across workers
// @see packages/web/src/lib/wasm-loader.ts
// @see phage_explorer-8qk2.2
import { getWasmCompute } from '../lib/wasm-loader';
import type { WasmComputeModule } from '../lib/wasm-loader';

// Alias for compatibility with existing code
const getWasmModule = getWasmCompute;

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
  options?: WorkerOptions;
}

export interface WorkerOutput {
  atoms: AtomRecord[];
  bonds: Bond[];
  backboneTraces: { x: number; y: number; z: number }[][];
  chains: string[];
  center: { x: number; y: number; z: number };
  radius: number;
  functionalGroups: SerializedFunctionalGroup[];
  timings?: WorkerTimings;
}

export interface WorkerOptions {
  /**
   * Whether to compute bonds. `auto` computes bonds only for smaller structures
   * (large capsids default to ribbon/surface rendering, where bonds are unused).
   */
  includeBonds?: boolean | 'auto';
  /**
   * Whether to compute functional groups (rings/disulfides/phosphates).
   * This is expensive and is disabled by default in the UI.
   */
  includeFunctionalGroups?: boolean;
}

export interface WorkerTimings {
  totalMs: number;
  parseMs: number;
  bondsMs: number;
  tracesMs: number;
  functionalMs: number;
  boundsMs: number;
  atomCount: number;
  bondCount: number;
  includeBonds: boolean;
  includeFunctionalGroups: boolean;
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

// Known single-character elements with specific radii (must match WASM and JS)
const KNOWN_ELEMENTS = new Set(['H', 'C', 'N', 'O', 'S', 'P']);

/**
 * Convert element symbol to single char for WASM.
 * For known elements (H, C, N, O, S, P), use the element directly.
 * For unknown/multi-char elements (CA, FE, MG, etc.), use 'X' to get default radius.
 * This ensures consistency between WASM and JS fallback.
 */
function elementToWasmChar(element: string): string {
  const upper = element.toUpperCase();
  // For single-char known elements, use as-is
  if (upper.length === 1 && KNOWN_ELEMENTS.has(upper)) {
    return upper;
  }
  // For multi-char elements or unknown, use 'X' for default radius (0.8)
  return 'X';
}

/**
 * Detect bonds between atoms using spatial hashing.
 *
 * Uses WASM spatial-hash algorithm when available (O(N) complexity).
 * Falls back to JS O(N²) for small structures or if WASM unavailable.
 *
 * Performance comparison for 50,000 atoms:
 * - JS O(N²): ~1.25 billion comparisons, 30-60+ seconds
 * - WASM spatial-hash: ~1 million comparisons, <1 second
 */
async function detectBondsWasm(
  atoms: AtomRecord[],
  wasm: WasmComputeModule
): Promise<Bond[]> {
  if (typeof wasm.detect_bonds_spatial !== 'function') {
    throw new Error('detect_bonds_spatial not available');
  }

  // Prepare flat arrays for WASM
  const positions = new Float32Array(atoms.length * 3);
  const elements: string[] = [];

  for (let i = 0; i < atoms.length; i++) {
    const atom = atoms[i];
    positions[i * 3] = atom.x;
    positions[i * 3 + 1] = atom.y;
    positions[i * 3 + 2] = atom.z;
    // Convert element to single char, ensuring consistency with JS fallback
    elements.push(elementToWasmChar(atom.element));
  }

  const elementStr = elements.join('');
  const result = wasm.detect_bonds_spatial(positions, elementStr);
  const bondData = result.bonds;
  const bondCount = result.bond_count;

  // Convert flat array [a0, b0, a1, b1, ...] to Bond[] format
  const bonds: Bond[] = [];
  for (let i = 0; i < bondCount; i++) {
    bonds.push({
      a: bondData[i * 2],
      b: bondData[i * 2 + 1],
    });
  }

  return bonds;
}

/**
 * Fallback JS bond detection (O(N²) complexity).
 * Used for small structures or when WASM is unavailable.
 */
function detectBondsJS(atoms: AtomRecord[]): Bond[] {
  const bonds: Bond[] = [];
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

// Threshold for using WASM vs JS (small structures are fast enough with JS)
const WASM_ATOM_THRESHOLD = 2000;
// Auto-mode cap: skip bonds for huge structures (matches UI's ribbon default threshold)
const AUTO_BOND_ATOM_LIMIT = 15000;

async function detectBonds(atoms: AtomRecord[]): Promise<Bond[]> {
  // For small structures, JS is fast enough
  if (atoms.length < WASM_ATOM_THRESHOLD) {
    return detectBondsJS(atoms);
  }

  // Try WASM for large structures
  const wasm = await getWasmModule();
  if (wasm) {
    try {
      return await detectBondsWasm(atoms, wasm);
    } catch (err) {
      console.warn('[structure.worker] WASM bond detection failed, falling back to JS:', err);
    }
  }

  // Fallback to JS
  return detectBondsJS(atoms);
}

function buildBackboneTraces(atoms: AtomRecord[]): { x: number; y: number; z: number }[][] {
  const chainMap = new Map<string, AtomRecord[]>();
  for (const atom of atoms) {
    if (atom.atomName !== 'CA' && atom.atomName !== 'C' && atom.atomName !== 'N') continue;
    const chainId = atom.labelChainId ?? atom.chainId;
    let chainAtoms = chainMap.get(chainId);
    if (!chainAtoms) {
      chainAtoms = [];
      chainMap.set(chainId, chainAtoms);
    }
    chainAtoms.push(atom);
  }
  const traces: { x: number; y: number; z: number }[][] = [];
  for (const [, chainAtoms] of chainMap) {
    const sorted = chainAtoms.sort((a, b) => (a.labelSeqId ?? a.resSeq) - (b.labelSeqId ?? b.resSeq) ||
      (a.insertionCode ?? '').localeCompare(b.insertionCode ?? ''));
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

// --- WASM-accelerated Functional Group Detection ---

/**
 * Detect functional groups using WASM for O(N) complexity on large structures.
 */
async function detectFunctionalGroupsWasm(
  atoms: AtomRecord[],
  bonds: Bond[],
  wasm: WasmComputeModule
): Promise<SerializedFunctionalGroup[]> {
  if (typeof wasm.detect_functional_groups !== 'function') {
    throw new Error('detect_functional_groups not available');
  }

  // Prepare flat arrays for WASM
  const positions = new Float32Array(atoms.length * 3);
  const elements: string[] = [];

  for (let i = 0; i < atoms.length; i++) {
    const atom = atoms[i];
    positions[i * 3] = atom.x;
    positions[i * 3 + 1] = atom.y;
    positions[i * 3 + 2] = atom.z;
    elements.push(elementToWasmChar(atom.element));
  }

  const elementStr = elements.join('');

  // Convert bonds to flat Uint32Array [a0, b0, a1, b1, ...]
  const bondsFlat = new Uint32Array(bonds.length * 2);
  for (let i = 0; i < bonds.length; i++) {
    bondsFlat[i * 2] = bonds[i].a;
    bondsFlat[i * 2 + 1] = bonds[i].b;
  }

  const result = wasm.detect_functional_groups(positions, elementStr, bondsFlat);

  const groups: SerializedFunctionalGroup[] = [];

  // Parse aromatic rings
  const aromaticIndices = result.aromatic_indices;
  const ringSizes = result.ring_sizes;
  let ringOffset = 0;
  for (let r = 0; r < result.aromatic_count; r++) {
    const size = ringSizes[r];
    const atomIndices: number[] = [];
    for (let i = 0; i < size; i++) {
      atomIndices.push(aromaticIndices[ringOffset + i]);
    }
    groups.push({
      type: 'aromatic',
      atomIndices,
      colorHex: FUNCTIONAL_GROUP_COLORS_HEX.aromatic,
    });
    ringOffset += size;
  }

  // Parse disulfide pairs
  const disulfidePairs = result.disulfide_pairs;
  for (let i = 0; i < result.disulfide_count; i++) {
    groups.push({
      type: 'disulfide',
      atomIndices: [disulfidePairs[i * 2], disulfidePairs[i * 2 + 1]],
      colorHex: FUNCTIONAL_GROUP_COLORS_HEX.disulfide,
    });
  }

  // Parse phosphate groups
  const phosphateData = result.phosphate_data;
  let pOffset = 0;
  for (let p = 0; p < result.phosphate_count; p++) {
    const pIdx = phosphateData[pOffset];
    const numOxygens = phosphateData[pOffset + 1];
    const atomIndices: number[] = [pIdx];
    for (let o = 0; o < numOxygens; o++) {
      atomIndices.push(phosphateData[pOffset + 2 + o]);
    }
    groups.push({
      type: 'phosphate',
      atomIndices,
      colorHex: FUNCTIONAL_GROUP_COLORS_HEX.phosphate,
    });
    pOffset += 2 + numOxygens;
  }

  // Free WASM memory
  if (typeof result.free === 'function') {
    result.free();
  }

  return groups;
}

/**
 * Detect all functional groups with WASM acceleration for large structures.
 */
async function detectAllFunctionalGroups(
  atoms: AtomRecord[],
  bonds: Bond[]
): Promise<SerializedFunctionalGroup[]> {
  // For large structures, try WASM
  if (atoms.length >= WASM_ATOM_THRESHOLD) {
    const wasm = await getWasmModule();
    if (wasm && typeof wasm.detect_functional_groups === 'function') {
      try {
        return await detectFunctionalGroupsWasm(atoms, bonds, wasm);
      } catch (err) {
        console.warn('[structure.worker] WASM functional group detection failed, falling back to JS:', err);
      }
    }
  }

  // Fallback to JS
  const rings = detectAromaticRings(atoms, bonds);
  const disulfides = detectDisulfides(atoms, bonds);
  const phosphates = detectPhosphates(atoms, bonds);
  return [...rings, ...disulfides, ...phosphates];
}

self.onmessage = async (e: MessageEvent<WorkerInput>) => {
  const { text, format, options } = e.data;

  try {
    const totalStart = performance.now();

    // Report progress: parsing
    self.postMessage({ type: 'progress', stage: 'parsing', percent: 30 });

    const parseStart = performance.now();
    const atoms = format === 'mmcif' ? parseMMCIF(text) : parsePDB(text);
    const parseMs = performance.now() - parseStart;
    if (atoms.length === 0) {
      throw new Error('No atoms parsed from structure file');
    }

    const includeFunctionalGroups = options?.includeFunctionalGroups === true;
    const includeBondsSetting = options?.includeBonds ?? 'auto';
    const includeBonds = includeFunctionalGroups
      || includeBondsSetting === true
      || (includeBondsSetting === 'auto' && atoms.length <= AUTO_BOND_ATOM_LIMIT);

    let bonds: Bond[] = [];
    let bondsMs = 0;
    if (includeBonds) {
      // Report progress: bond detection
      // This now uses WASM spatial-hash for O(N) complexity on large structures
      self.postMessage({ type: 'progress', stage: 'bonds', percent: 45 });
      const bondsStart = performance.now();
      bonds = await detectBonds(atoms);
      bondsMs = performance.now() - bondsStart;
    }

    // Report progress: building traces
    self.postMessage({ type: 'progress', stage: 'traces', percent: 70 });

    const tracesStart = performance.now();
    const backboneTraces = buildBackboneTraces(atoms);
    const tracesMs = performance.now() - tracesStart;
    const chains = Array.from(new Set(atoms.map(a => a.labelChainId ?? a.chainId)));

    let functionalGroups: SerializedFunctionalGroup[] = [];
    let functionalMs = 0;
    if (includeFunctionalGroups && bonds.length > 0) {
      // Report progress: functional groups
      // This now uses WASM acceleration for large structures
      self.postMessage({ type: 'progress', stage: 'functional', percent: 85 });

      const functionalStart = performance.now();
      functionalGroups = await detectAllFunctionalGroups(atoms, bonds);
      functionalMs = performance.now() - functionalStart;
    }

    const boundsStart = performance.now();
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
    const boundsMs = performance.now() - boundsStart;

    // Report progress: finalizing
    self.postMessage({ type: 'progress', stage: 'finalizing', percent: 95 });

    const timings: WorkerTimings = {
      totalMs: performance.now() - totalStart,
      parseMs,
      bondsMs,
      tracesMs,
      functionalMs,
      boundsMs,
      atomCount: atoms.length,
      bondCount: bonds.length,
      includeBonds,
      includeFunctionalGroups,
    };

    const result: WorkerOutput = {
      atoms,
      bonds,
      backboneTraces,
      chains,
      center,
      radius,
      functionalGroups,
      timings,
    };

    self.postMessage({ type: 'success', data: result });

  } catch (err) {
    self.postMessage({ type: 'error', error: err instanceof Error ? err.message : String(err) });
  }
};
