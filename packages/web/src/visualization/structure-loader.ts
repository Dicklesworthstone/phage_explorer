import {
  BufferGeometry,
  CatmullRomCurve3,
  Color,
  CylinderGeometry,
  Float32BufferAttribute,
  Group,
  InstancedMesh,
  LineBasicMaterial,
  LineSegments,
  Matrix4,
  Mesh,
  MeshPhongMaterial,
  Quaternion,
  SphereGeometry,
  TubeGeometry,
  Vector3,
} from 'three';

export type StructureFormat = 'pdb' | 'mmcif';

export interface AtomRecord {
  x: number;
  y: number;
  z: number;
  element: string;
  atomName: string;
  chainId: string;
  resSeq: number;
  resName: string;
}

export interface Bond {
  a: number;
  b: number;
}

export type FunctionalGroupType = 'aromatic' | 'disulfide' | 'phosphate';

export interface FunctionalGroup {
  type: FunctionalGroupType;
  atomIndices: number[];
  color: Color;
}

export interface LoadedStructure {
  atoms: AtomRecord[];
  bonds: Bond[];
  backboneTraces: Vector3[][];
  chains: string[];
  center: Vector3;
  radius: number;
  atomCount: number;
  functionalGroups: FunctionalGroup[];
  timings?: WorkerTimings;
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

type StructureWorkerCtor = new () => Worker;
let cachedStructureWorkerCtor: StructureWorkerCtor | null = null;

async function getStructureWorkerCtor(): Promise<StructureWorkerCtor> {
  if (cachedStructureWorkerCtor) return cachedStructureWorkerCtor;
  const mod = await import('./structure.worker?worker');
  cachedStructureWorkerCtor = mod.default as StructureWorkerCtor;
  return cachedStructureWorkerCtor;
}

// ============================================================
// StructureWorkerPool - Reuses workers for structure parsing
// ============================================================

interface PooledWorker {
  worker: Worker;
  busy: boolean;
  lastUsed: number;
}

/**
 * Pool of structure parsing workers.
 * Reuses workers instead of creating/destroying for each load.
 */
class StructureWorkerPool {
  private static instance: StructureWorkerPool | null = null;
  private pool: PooledWorker[] = [];
  private maxWorkers: number;
  private idleTimeout: number;
  private cleanupInterval: ReturnType<typeof setInterval> | null = null;
  private workerCtorPromise: Promise<StructureWorkerCtor> | null = null;

  private constructor(maxWorkers = 2, idleTimeout = 60000) {
    this.maxWorkers = maxWorkers;
    this.idleTimeout = idleTimeout;

    // Cleanup idle workers periodically
    this.cleanupInterval = setInterval(() => this.cleanupIdleWorkers(), 30000);
  }

  static getInstance(): StructureWorkerPool {
    if (!StructureWorkerPool.instance) {
      StructureWorkerPool.instance = new StructureWorkerPool();
    }
    return StructureWorkerPool.instance;
  }

  /**
   * Acquire a worker from the pool or create a new one if under capacity.
   */
  async acquire(): Promise<PooledWorker> {
    // Find an available worker
    const available = this.pool.find(pw => !pw.busy);
    if (available) {
      available.busy = true;
      available.lastUsed = Date.now();
      return available;
    }

    // Create new worker if under capacity
    if (this.pool.length < this.maxWorkers) {
      if (!this.workerCtorPromise) {
        this.workerCtorPromise = getStructureWorkerCtor();
      }
      const WorkerCtor = await this.workerCtorPromise;
      const worker = new WorkerCtor();
      const pooledWorker: PooledWorker = {
        worker,
        busy: true,
        lastUsed: Date.now(),
      };
      this.pool.push(pooledWorker);
      return pooledWorker;
    }

    // At capacity - wait for one to become available
    return new Promise((resolve) => {
      const checkInterval = setInterval(() => {
        const available = this.pool.find(pw => !pw.busy);
        if (available) {
          clearInterval(checkInterval);
          available.busy = true;
          available.lastUsed = Date.now();
          resolve(available);
        }
      }, 10);
    });
  }

  /**
   * Release a worker back to the pool.
   */
  release(pooledWorker: PooledWorker): void {
    pooledWorker.busy = false;
    pooledWorker.lastUsed = Date.now();
    // Reset message handlers to clean up previous listeners
    pooledWorker.worker.onmessage = null;
    pooledWorker.worker.onerror = null;
  }

  /**
   * Clean up idle workers beyond the first one.
   */
  private cleanupIdleWorkers(): void {
    const now = Date.now();
    // Keep at least one worker ready
    if (this.pool.length <= 1) return;

    // Find idle workers to remove (keep the first one)
    const toRemove: number[] = [];
    for (let i = 1; i < this.pool.length; i++) {
      const pw = this.pool[i];
      if (!pw.busy && now - pw.lastUsed > this.idleTimeout) {
        toRemove.push(i);
      }
    }

    // Remove from end to avoid index shifting issues
    for (let i = toRemove.length - 1; i >= 0; i--) {
      const idx = toRemove[i];
      const pw = this.pool[idx];
      pw.worker.terminate();
      this.pool.splice(idx, 1);
    }
  }

  /**
   * Terminate all workers and dispose the pool.
   */
  dispose(): void {
    if (this.cleanupInterval) {
      clearInterval(this.cleanupInterval);
      this.cleanupInterval = null;
    }
    for (const pw of this.pool) {
      pw.worker.terminate();
    }
    this.pool = [];
    StructureWorkerPool.instance = null;
  }

  /**
   * Get pool statistics.
   */
  getStats(): { total: number; busy: number; idle: number } {
    const busy = this.pool.filter(pw => pw.busy).length;
    return {
      total: this.pool.length,
      busy,
      idle: this.pool.length - busy,
    };
  }
}

/**
 * Get the structure worker pool singleton.
 */
export function getStructureWorkerPool(): StructureWorkerPool {
  return StructureWorkerPool.getInstance();
}

export function parsePDB(text: string): AtomRecord[] {
  const atoms: AtomRecord[] = [];
  const lines = text.split(/\r?\n/);
  for (const line of lines) {
    if (!line.startsWith('ATOM') && !line.startsWith('HETATM')) continue;
    const atomName = line.slice(12, 16).trim().toUpperCase();
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

export function parseMMCIF(text: string): AtomRecord[] {
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

// CPK-based colors optimized for dark backgrounds - vibrant and distinctive
const ELEMENT_COLORS: Record<string, Color> = {
  // Common organic elements
  H: new Color('#f8fafc'),      // White - hydrogen
  C: new Color('#64748b'),      // Slate gray - carbon (darker for contrast)
  N: new Color('#3b82f6'),      // Bright blue - nitrogen
  O: new Color('#ef4444'),      // Bright red - oxygen
  S: new Color('#fde047'),      // Bright yellow - sulfur
  P: new Color('#fb923c'),      // Orange - phosphorus
  // Metals
  MG: new Color('#22c55e'),     // Bright green - magnesium
  FE: new Color('#f97316'),     // Orange/rust - iron
  CA: new Color('#16a34a'),     // Green - calcium
  ZN: new Color('#7c3aed'),     // Purple - zinc
  CL: new Color('#4ade80'),     // Light green - chlorine
  NA: new Color('#a855f7'),     // Purple - sodium
  K: new Color('#8b5cf6'),      // Violet - potassium
  MN: new Color('#9333ea'),     // Dark purple - manganese
  CU: new Color('#ea580c'),     // Copper orange - copper
  SE: new Color('#eab308'),     // Yellow-gold - selenium
  // Additional elements
  BR: new Color('#a3262c'),     // Dark red - bromine
  I: new Color('#940094'),      // Dark purple - iodine
  F: new Color('#90e050'),      // Yellow-green - fluorine
  B: new Color('#ffb5b5'),      // Pink - boron
  SI: new Color('#f0c8a0'),     // Beige - silicon
  AL: new Color('#bfa6a6'),     // Gray-pink - aluminum
  CO: new Color('#f090a0'),     // Pink - cobalt
  NI: new Color('#50d050'),     // Green - nickel
};

function detectFormat(idOrUrl: string): StructureFormat {
  const lower = idOrUrl.toLowerCase();
  return lower.endsWith('.cif') || lower.endsWith('.mmcif') ? 'mmcif' : 'pdb';
}

function resolveDownloadUrl(idOrUrl: string, format: StructureFormat): string {
  if (idOrUrl.includes('://')) return idOrUrl;
  const bareId = idOrUrl.replace(/\.cif$/i, '').replace(/\.pdb$/i, '');
  const ext = format === 'mmcif' ? 'cif' : 'pdb';
  return `https://files.rcsb.org/download/${bareId}.${ext}`;
}

function colorForElement(element: string): Color {
  const key = element.toUpperCase();
  return ELEMENT_COLORS[key] ?? new Color('#22d3ee');
}

export type LoadingStage = 'fetching' | 'parsing' | 'bonds' | 'traces' | 'functional' | 'finalizing';

export interface ProgressInfo {
  stage: LoadingStage;
  percent: number;
}

export type ProgressCallback = (info: ProgressInfo) => void;

export type BondDetail = boolean | 'auto';

export interface LoadStructureOptions {
  includeBonds?: BondDetail;
  includeFunctionalGroups?: boolean;
}

// Lazy-loaded cache module to avoid circular dependencies
let cacheModule: typeof import('../db/structure-cache') | null = null;
async function getCache() {
  if (!cacheModule) {
    cacheModule = await import('../db/structure-cache');
  }
  return cacheModule;
}

/**
 * Extract the bare PDB ID from an ID or URL for cache key purposes.
 */
export function extractPdbId(idOrUrl: string): string {
  const normalize = (candidate: string): string =>
    candidate.replace(/\.(pdb|cif|mmcif)(?:\.gz)?$/i, '').toUpperCase();

  if (idOrUrl.includes('://')) {
    try {
      const url = new URL(idOrUrl);
      const parts = url.pathname.split('/').filter(Boolean);
      const filename = parts.length > 0 ? parts[parts.length - 1] : null;
      if (filename) {
        return normalize(filename);
      }
    } catch {
      // Fall back to regex parsing below.
    }

    const match = idOrUrl.match(/\/([A-Za-z0-9]+)\.(pdb|cif|mmcif)(?:\.gz)?(?:$|[?#])/i);
    if (match) return match[1].toUpperCase();
  }

  return normalize(idOrUrl);
}

export async function loadStructure(
  idOrUrl: string,
  signal?: AbortSignal,
  onProgress?: ProgressCallback,
  options?: LoadStructureOptions
): Promise<LoadedStructure> {
  const format = detectFormat(idOrUrl);
  const url = resolveDownloadUrl(idOrUrl, format);
  const pdbId = extractPdbId(idOrUrl);
  const resolvedOptions: LoadStructureOptions = {
    includeBonds: options?.includeBonds ?? 'auto',
    includeFunctionalGroups: options?.includeFunctionalGroups ?? false,
  };

  // Report: fetching (5%)
  onProgress?.({ stage: 'fetching', percent: 5 });

  // Check IndexedDB cache first
  let text: string;
  let fromCache = false;

  try {
    const cache = await getCache();
    const cached = await cache.getCachedStructure(pdbId);
    if (cached) {
      // Decode cached ArrayBuffer to text
      const decoder = new TextDecoder();
      text = decoder.decode(cached.data);
      fromCache = true;
      // Report: cache hit (20%)
      onProgress?.({ stage: 'fetching', percent: 20 });
    }
  } catch {
    // Cache miss or error, continue with fetch
  }

  // If not cached, fetch from network
  if (!fromCache) {
    // Report: fetching (10%)
    onProgress?.({ stage: 'fetching', percent: 10 });

    const res = await fetch(url, { signal });
    if (!res.ok) {
      throw new Error(`Failed to fetch structure (${res.status})`);
    }

    // Report: fetching complete (20%)
    onProgress?.({ stage: 'fetching', percent: 20 });

    text = await res.text();

    // Cache the fetched data (async, don't block)
    try {
      const cache = await getCache();
      const encoder = new TextEncoder();
      const data = encoder.encode(text).buffer;
      void cache.cacheStructure(pdbId, data, format);
    } catch {
      // Cache write failed, ignore
    }
  }

  if (signal?.aborted) {
    throw new DOMException('Aborted', 'AbortError');
  }

  // Use worker pool instead of creating/destroying workers each time
  const pool = StructureWorkerPool.getInstance();
  const pooledWorker = await pool.acquire();
  const worker = pooledWorker.worker;

  // Offload to worker
  return new Promise((resolve, reject) => {
    let settled = false;

    function cleanup() {
      if (signal) {
        signal.removeEventListener('abort', onAbort);
      }
      // Release worker back to pool instead of terminating
      pool.release(pooledWorker);
    }

    function onAbort() {
      if (settled) return;
      settled = true;
      cleanup();
      reject(new DOMException('Aborted', 'AbortError'));
    }

    if (signal) {
      if (signal.aborted) {
        onAbort();
        return;
      }
      signal.addEventListener('abort', onAbort, { once: true });
    }

    worker.onmessage = (e) => {
      const { type, data, error, stage, percent } = e.data;

      // Handle progress messages from worker
      if (type === 'progress') {
        onProgress?.({ stage, percent });
        return;
      }

      if (type === 'error') {
        if (settled) return;
        settled = true;
        cleanup();
        reject(new Error(error));
        return;
      }

      if (type === 'success') {
        if (settled) return;
        settled = true;
        // Hydrate plain objects back to Three.js types
        const atoms = data.atoms;
        const bonds = data.bonds;
        const chains = data.chains;

        const center = new Vector3(data.center.x, data.center.y, data.center.z);
        const radius = data.radius;

        const backboneTraces = data.backboneTraces.map((trace: any[]) =>
          trace.map((pt: any) => new Vector3(pt.x, pt.y, pt.z))
        );

        const functionalGroups = data.functionalGroups.map((fg: any) => ({
          type: fg.type,
          atomIndices: fg.atomIndices,
          color: new Color(fg.colorHex),
        }));

        const timings = data.timings as WorkerTimings | undefined;
        if (import.meta.env.DEV && timings) {
          console.log('[structure-loader] timings', {
            pdbId,
            format,
            fromCache,
            ...timings,
          });
        }

        cleanup();
        resolve({
          atoms,
          bonds,
          backboneTraces,
          chains,
          center,
          radius,
          atomCount: atoms.length,
          functionalGroups,
          timings,
        });
      }
    };

    worker.onerror = (e) => {
      if (settled) return;
      settled = true;
      cleanup();
      reject(new Error(e.message));
    };

    worker.postMessage({ text, format, options: resolvedOptions });
  });
}

// ... (Rest of buildBallAndStick, buildTubeFromTraces, etc. remains unchanged)


interface BallStickOptions {
  sphereRadius?: number;
  bondRadius?: number;
  sphereSegments?: number;
  bondRadialSegments?: number;
}

export function buildBallAndStick(
  atoms: AtomRecord[],
  bonds: Bond[],
  options: BallStickOptions = {}
): Group {
  const {
    sphereRadius = 0.5,
    bondRadius = 0.15,
    sphereSegments = 24,
    bondRadialSegments = 16,
  } = options;
  const group = new Group();

  // ATOMS - use instanced mesh with per-instance element-based colors
  const atomGeo = new SphereGeometry(sphereRadius, sphereSegments, sphereSegments);
  const atomMat = new MeshPhongMaterial({
    color: 0xffffff,             // White base - instance colors multiply against this
    shininess: 80,               // Moderate shininess for natural look
    specular: new Color('#888888'),  // Neutral specular
    emissive: new Color('#000000'),  // No emissive - let element colors shine
    emissiveIntensity: 0,
    // NOTE: Do NOT use vertexColors for InstancedMesh - it uses instanceColor instead
  });
  const atomMesh = new InstancedMesh(atomGeo, atomMat, atoms.length);
  const matrix = new Matrix4();
  const color = new Color();

  atoms.forEach((atom, index) => {
    matrix.setPosition(atom.x, atom.y, atom.z);
    atomMesh.setMatrixAt(index, matrix);
    atomMesh.setColorAt(index, color.copy(colorForElement(atom.element)));
  });
  atomMesh.instanceMatrix.needsUpdate = true;
  if (atomMesh.instanceColor) atomMesh.instanceColor.needsUpdate = true;
  atomMesh.userData = { pickKind: 'atom' };
  group.add(atomMesh);

  // BONDS - neutral gray, thin, doesn't compete with atom colors
  const bondGeo = new CylinderGeometry(bondRadius, bondRadius, 1, bondRadialSegments, 1, true);
  const bondMat = new MeshPhongMaterial({
    color: '#9ca3af',  // Medium gray - visible but not distracting
    shininess: 50,
    specular: new Color('#666666'),
    emissive: new Color('#000000'),
    emissiveIntensity: 0,
  });
  const bondMesh = new InstancedMesh(bondGeo, bondMat, bonds.length);
  const bondMatrix = new Matrix4();
  const scaleMatrix = new Matrix4();
  const up = new Vector3(0, 1, 0);
  const quat = new Quaternion();
  const start = new Vector3();
  const end = new Vector3();
  const mid = new Vector3();
  const dir = new Vector3();
  for (let i = 0; i < bonds.length; i++) {
    const bond = bonds[i];
    const a = atoms[bond.a];
    const b = atoms[bond.b];
    start.set(a.x, a.y, a.z);
    end.set(b.x, b.y, b.z);
    mid.addVectors(start, end).multiplyScalar(0.5);
    dir.subVectors(end, start);
    const length = dir.length();
    if (length === 0) continue;
    dir.multiplyScalar(1 / length);
    quat.setFromUnitVectors(up, dir);
    bondMatrix.identity();
    bondMatrix.makeRotationFromQuaternion(quat);
    scaleMatrix.identity().makeScale(1, length, 1);
    bondMatrix.multiply(scaleMatrix);
    bondMatrix.setPosition(mid);
    bondMesh.setMatrixAt(i, bondMatrix);
  }
  bondMesh.instanceMatrix.needsUpdate = true;
  bondMesh.userData = { pickKind: 'bond' };
  group.add(bondMesh);
  return group;
}

// Vibrant chain colors for better visibility
const CHAIN_COLORS = [
  '#60a5fa', // Blue
  '#f472b6', // Pink
  '#4ade80', // Green
  '#fb923c', // Orange
  '#a78bfa', // Purple
  '#22d3ee', // Cyan
  '#fbbf24', // Yellow
  '#f87171', // Red
];

export function buildTubeFromTraces(
  traces: Vector3[][],
  radius: number,
  radialSegments: number,
  defaultColor: string,
  opacity = 1,
  colors?: string[],
  minSegments = 30
): Group {
  const group = new Group();
  traces.forEach((trace, idx) => {
    if (trace.length < 2) return;
    const curve = new CatmullRomCurve3(trace);
    const tubeSegments = Math.max(minSegments, trace.length * 3); // Smoother tubes
    const tube = new TubeGeometry(curve, tubeSegments, radius, radialSegments, false);
    const chainColor = colors?.[idx % (colors.length || 1)] ?? CHAIN_COLORS[idx % CHAIN_COLORS.length] ?? defaultColor;
    const mat = new MeshPhongMaterial({
      color: chainColor,
      shininess: 100,
      specular: new Color('#444444'),
      emissive: new Color(chainColor),
      emissiveIntensity: 0.1, // Slight glow
      transparent: opacity < 1,
      opacity,
    });
    const mesh = new Mesh(tube, mat);
    group.add(mesh);
  });
  return group;
}

export function buildSurfaceImpostor(
  atoms: AtomRecord[],
  scale = 1.6,
  segments = 12
): Group {
  const group = new Group();

  // Outer surface - element-colored, semi-transparent
  const outerGeo = new SphereGeometry(0.7 * scale, segments, segments);
  const outerMat = new MeshPhongMaterial({
    color: 0xffffff,     // White base - instance colors multiply against this
    transparent: true,
    opacity: 0.55,
    shininess: 60,
    specular: new Color('#666666'),
    side: 2, // DoubleSide
    depthWrite: false,
    // NOTE: Do NOT use vertexColors for InstancedMesh - it uses instanceColor instead
  });
  const outerMesh = new InstancedMesh(outerGeo, outerMat, atoms.length);
  const matrix = new Matrix4();
  const color = new Color();

  // Apply element-based colors to each atom
  atoms.forEach((atom, idx) => {
    matrix.makeTranslation(atom.x, atom.y, atom.z);
    outerMesh.setMatrixAt(idx, matrix);
    outerMesh.setColorAt(idx, color.copy(colorForElement(atom.element)));
  });
  outerMesh.instanceMatrix.needsUpdate = true;
  if (outerMesh.instanceColor) outerMesh.instanceColor.needsUpdate = true;
  outerMesh.userData = { pickKind: 'atom' };
  group.add(outerMesh);

  // Inner core - smaller, brighter, element-colored for depth perception
  const innerGeo = new SphereGeometry(0.35 * scale, 8, 8);
  const innerMat = new MeshPhongMaterial({
    color: 0xffffff,     // White base - instance colors multiply against this
    shininess: 100,
    specular: new Color('#ffffff'),
    // NOTE: Do NOT use vertexColors for InstancedMesh - it uses instanceColor instead
  });
  const innerMesh = new InstancedMesh(innerGeo, innerMat, atoms.length);

  // Reuse Color objects to avoid allocations in the loop
  const innerColor = new Color();
  const whiteColor = new Color('#ffffff');

  atoms.forEach((atom, idx) => {
    matrix.makeTranslation(atom.x, atom.y, atom.z);
    innerMesh.setMatrixAt(idx, matrix);
    // Use slightly brighter version of element color for inner core
    innerColor.copy(colorForElement(atom.element)).lerp(whiteColor, 0.3);
    innerMesh.setColorAt(idx, innerColor);
  });
  innerMesh.instanceMatrix.needsUpdate = true;
  if (innerMesh.instanceColor) innerMesh.instanceColor.needsUpdate = true;
  innerMesh.userData = { pickKind: 'atom' };
  group.add(innerMesh);

  return group;
}

export type FunctionalGroupStyle = 'halo' | 'bounds' | 'lines';

interface FunctionalGroupHighlightOptions {
  style?: FunctionalGroupStyle;
}

export function buildFunctionalGroupHighlights(
  atoms: AtomRecord[],
  groups: FunctionalGroup[],
  options: FunctionalGroupHighlightOptions = {}
): Group {
  const style = options.style ?? 'halo';
  const group = new Group();
  if (!groups.length) return group;

  switch (style) {
    case 'bounds': {
      groups.forEach(g => {
        const centroid = g.atomIndices.reduce(
          (acc, idx) => acc.add(new Vector3(atoms[idx].x, atoms[idx].y, atoms[idx].z)),
          new Vector3()
        ).multiplyScalar(1 / g.atomIndices.length);
        let maxRadius = 0;
        g.atomIndices.forEach(idx => {
          const atomPos = new Vector3(atoms[idx].x, atoms[idx].y, atoms[idx].z);
          maxRadius = Math.max(maxRadius, atomPos.distanceTo(centroid));
        });
        const radius = maxRadius + 0.6;
        const geo = new SphereGeometry(radius, 16, 16);
        const mat = new MeshPhongMaterial({
          color: g.color,
          transparent: true,
          opacity: 0.22,
          emissive: g.color,
          emissiveIntensity: 0.15,
          depthWrite: false,
        });
        const mesh = new Mesh(geo, mat);
        mesh.position.copy(centroid);
        group.add(mesh);
      });
      break;
    }
    case 'lines': {
      const positions: number[] = [];
      const colors: number[] = [];
      groups.forEach(g => {
        const atomsInGroup = g.atomIndices;
        if (atomsInGroup.length < 2) return;
        for (let i = 0; i < atomsInGroup.length - 1; i++) {
          const a = atomsInGroup[i];
          const b = atomsInGroup[i + 1];
          positions.push(atoms[a].x, atoms[a].y, atoms[a].z);
          positions.push(atoms[b].x, atoms[b].y, atoms[b].z);
          colors.push(g.color.r, g.color.g, g.color.b);
          colors.push(g.color.r, g.color.g, g.color.b);
        }
      });
      if (positions.length) {
        const geo = new BufferGeometry();
        geo.setAttribute('position', new Float32BufferAttribute(positions, 3));
        geo.setAttribute('color', new Float32BufferAttribute(colors, 3));
        const mat = new LineBasicMaterial({ vertexColors: true, linewidth: 1 });
        const lines = new LineSegments(geo, mat);
        group.add(lines);
      }
      break;
    }
    case 'halo':
    default: {
      const instances: { idx: number; color: Color }[] = [];
      groups.forEach(g => {
        g.atomIndices.forEach(idx => instances.push({ idx, color: g.color }));
      });
      if (!instances.length) return group;
      const haloRadius = 0.65;
      const geo = new SphereGeometry(haloRadius, 14, 14);
      const mat = new MeshPhongMaterial({
        color: 0xffffff,     // White base - instance colors multiply against this
        transparent: true,
        opacity: 0.35,
        shininess: 80,
        emissiveIntensity: 0.2,
        // NOTE: Do NOT use vertexColors for InstancedMesh - it uses instanceColor instead
      });
      const mesh = new InstancedMesh(geo, mat, instances.length);
      const matrix = new Matrix4();
      const color = new Color();
      instances.forEach((item, i) => {
        const atom = atoms[item.idx];
        matrix.makeTranslation(atom.x, atom.y, atom.z);
        mesh.setMatrixAt(i, matrix);
        mesh.setColorAt(i, color.copy(item.color));
      });
      mesh.instanceMatrix.needsUpdate = true;
      if (mesh.instanceColor) mesh.instanceColor.needsUpdate = true;
      group.add(mesh);
      break;
    }
  }

  return group;
}
