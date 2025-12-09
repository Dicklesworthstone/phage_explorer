import {
  Box3,
  CatmullRomCurve3,
  Color,
  CylinderGeometry,
  Group,
  InstancedMesh,
  Matrix4,
  Mesh,
  MeshPhongMaterial,
  SphereGeometry,
  TubeGeometry,
  Vector3,
  Quaternion,
} from 'three';

export type StructureFormat = 'pdb' | 'mmcif';

export interface LoadedStructure {
  atoms: AtomRecord[];
  bonds: Bond[];
  backboneTraces: Vector3[][];
  chains: string[];
  center: Vector3;
  radius: number;
  atomCount: number;
}

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

// HIGH CONTRAST element colors for dark backgrounds
const ELEMENT_COLORS: Record<string, Color> = {
  H: new Color('#e0e0e0'),    // Light gray (visible on dark bg)
  C: new Color('#60a5fa'),    // Bright sky blue (NOT dark gray!)
  N: new Color('#34d399'),    // Bright emerald green
  O: new Color('#f87171'),    // Bright coral red
  S: new Color('#fbbf24'),    // Bright amber
  P: new Color('#c084fc'),    // Purple
  MG: new Color('#4ade80'),   // Bright green
  FE: new Color('#fb923c'),   // Orange
  CA: new Color('#a3e635'),   // Lime
  ZN: new Color('#7dd3fc'),   // Light blue
  CL: new Color('#86efac'),   // Light green
  NA: new Color('#fdba74'),   // Light orange
};

const ELEMENT_RADII: Record<string, number> = {
  H: 0.31,
  C: 0.76,
  N: 0.71,
  O: 0.66,
  S: 1.05,
  P: 1.07,
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

export function parsePDB(text: string): AtomRecord[] {
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

function colorForElement(element: string): Color {
  const key = element.toUpperCase();
  return ELEMENT_COLORS[key] ?? new Color('#22d3ee');
}

function detectBonds(atoms: AtomRecord[]): Bond[] {
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

function buildBackboneTraces(atoms: AtomRecord[]): Vector3[][] {
  const chainMap = new Map<string, AtomRecord[]>();
  for (const atom of atoms) {
    if (atom.atomName !== 'CA' && atom.atomName !== 'C' && atom.atomName !== 'N') continue;
    if (!chainMap.has(atom.chainId)) chainMap.set(atom.chainId, []);
    chainMap.get(atom.chainId)!.push(atom);
  }
  const traces: Vector3[][] = [];
  for (const [, chainAtoms] of chainMap) {
    const sorted = chainAtoms.sort((a, b) => a.resSeq - b.resSeq);
    traces.push(sorted.map(a => new Vector3(a.x, a.y, a.z)));
  }
  return traces;
}

export async function loadStructure(
  idOrUrl: string,
  signal?: AbortSignal
): Promise<LoadedStructure> {
  const format = detectFormat(idOrUrl);
  const url = resolveDownloadUrl(idOrUrl, format);
  const res = await fetch(url, { signal });
  if (!res.ok) {
    throw new Error(`Failed to fetch structure (${res.status})`);
  }
  const text = await res.text();
  const atoms = format === 'mmcif' ? parseMMCIF(text) : parsePDB(text);
  if (atoms.length === 0) {
    throw new Error('No atoms parsed from structure file');
  }

  const bonds = detectBonds(atoms);
  const backboneTraces = buildBackboneTraces(atoms);
  const chains = Array.from(new Set(atoms.map(a => a.chainId)));

  const box = new Box3();
  for (const atom of atoms) {
    box.expandByPoint(new Vector3(atom.x, atom.y, atom.z));
  }
  const center = box.getCenter(new Vector3());
  const radius = box.getSize(new Vector3()).length() / 2 || 1;

  return {
    atoms,
    bonds,
    backboneTraces,
    chains,
    center,
    radius,
    atomCount: atoms.length,
  };
}

export function buildBallAndStick(atoms: AtomRecord[], bonds: Bond[], sphereRadius = 0.5, bondRadius = 0.15): Group {
  const group = new Group();

  // ATOMS - use instanced mesh with per-instance colors
  const atomGeo = new SphereGeometry(sphereRadius, 24, 24);
  const atomMat = new MeshPhongMaterial({
    vertexColors: true,
    shininess: 80,
    specular: new Color('#555555'),
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
  group.add(atomMesh);

  // BONDS - bright silver/white for visibility
  const bondGeo = new CylinderGeometry(bondRadius, bondRadius, 1, 16, 1, true);
  const bondMat = new MeshPhongMaterial({
    color: '#d4d4d8',  // Bright zinc/silver
    shininess: 60,
    specular: new Color('#888888'),
    emissive: new Color('#1a1a2e'),  // Slight self-illumination
    emissiveIntensity: 0.1,
  });
  const bondMesh = new InstancedMesh(bondGeo, bondMat, bonds.length);
  const bondMatrix = new Matrix4();
  const scaleMatrix = new Matrix4();
  const up = new Vector3(0, 1, 0);
  const quat = new Quaternion();
  bonds.forEach((bond, i) => {
    const a = atoms[bond.a];
    const b = atoms[bond.b];
    const start = new Vector3(a.x, a.y, a.z);
    const end = new Vector3(b.x, b.y, b.z);
    const mid = start.clone().add(end).multiplyScalar(0.5);
    const dir = end.clone().sub(start);
    const length = dir.length();
    if (length === 0) return;
    dir.normalize();
    quat.setFromUnitVectors(up, dir);
    bondMatrix.identity();
    bondMatrix.makeRotationFromQuaternion(quat);
    scaleMatrix.identity().makeScale(1, length, 1);
    bondMatrix.multiply(scaleMatrix);
    bondMatrix.setPosition(mid);
    bondMesh.setMatrixAt(i, bondMatrix);
  });
  bondMesh.instanceMatrix.needsUpdate = true;
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

export function buildTubeFromTraces(traces: Vector3[][], radius: number, radialSegments: number, defaultColor: string, opacity = 1, colors?: string[]): Group {
  const group = new Group();
  traces.forEach((trace, idx) => {
    if (trace.length < 2) return;
    const curve = new CatmullRomCurve3(trace);
    const tubeSegments = Math.max(30, trace.length * 3); // Smoother tubes
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

export function buildSurfaceImpostor(atoms: AtomRecord[], scale = 1.6): Group {
  const group = new Group();

  // Create a more visible, colorful surface
  const geo = new SphereGeometry(0.7 * scale, 12, 12);

  // Outer surface - semi-transparent blue
  const outerMat = new MeshPhongMaterial({
    color: '#38bdf8', // Bright sky blue
    transparent: true,
    opacity: 0.5,
    shininess: 60,
    specular: new Color('#88ccff'),
    side: 2, // DoubleSide
    depthWrite: false,
  });
  const outerMesh = new InstancedMesh(geo, outerMat, atoms.length);
  const matrix = new Matrix4();
  atoms.forEach((atom, idx) => {
    matrix.makeTranslation(atom.x, atom.y, atom.z);
    outerMesh.setMatrixAt(idx, matrix);
  });
  outerMesh.instanceMatrix.needsUpdate = true;
  group.add(outerMesh);

  // Inner core - brighter for depth perception
  const innerGeo = new SphereGeometry(0.3 * scale, 8, 8);
  const innerMat = new MeshPhongMaterial({
    color: '#f0f9ff', // Very light blue/white
    shininess: 100,
    emissive: new Color('#60a5fa'),
    emissiveIntensity: 0.2,
  });
  const innerMesh = new InstancedMesh(innerGeo, innerMat, atoms.length);
  atoms.forEach((atom, idx) => {
    matrix.makeTranslation(atom.x, atom.y, atom.z);
    innerMesh.setMatrixAt(idx, matrix);
  });
  innerMesh.instanceMatrix.needsUpdate = true;
  group.add(innerMesh);

  return group;
}

