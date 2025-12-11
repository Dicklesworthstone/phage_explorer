import {
  Box3,
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

export interface LoadedStructure {
  atoms: AtomRecord[];
  bonds: Bond[];
  backboneTraces: Vector3[][];
  chains: string[];
  center: Vector3;
  radius: number;
  atomCount: number;
  functionalGroups: FunctionalGroup[];
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

export type FunctionalGroupType = 'aromatic' | 'disulfide' | 'phosphate';

export interface FunctionalGroup {
  type: FunctionalGroupType;
  atomIndices: number[];
  color: Color;
}

// CPK-based colors optimized for dark backgrounds
// Based on Corey-Pauling-Koltun standard with brightness adjustments
const ELEMENT_COLORS: Record<string, Color> = {
  H: new Color('#f8fafc'),    // Almost white (hydrogen - brightest, smallest)
  C: new Color('#64748b'),    // Slate gray (carbon backbone - neutral)
  N: new Color('#3b82f6'),    // True blue (nitrogen - CPK standard)
  O: new Color('#ef4444'),    // True red (oxygen - CPK standard)
  S: new Color('#fde047'),    // Bright yellow (sulfur - CPK standard)
  P: new Color('#fb923c'),    // Orange (phosphorus - CPK standard)
  MG: new Color('#22c55e'),   // Green (magnesium)
  FE: new Color('#ea580c'),   // Rust orange (iron in heme)
  CA: new Color('#16a34a'),   // Dark green (calcium)
  ZN: new Color('#7c3aed'),   // Purple (zinc - distinctive)
  CL: new Color('#4ade80'),   // Lime green (chlorine)
  NA: new Color('#a855f7'),   // Violet (sodium - distinctive from others)
  K: new Color('#8b5cf6'),    // Violet (potassium)
  MN: new Color('#9333ea'),   // Purple (manganese)
  CU: new Color('#f97316'),   // Orange-brown (copper)
  SE: new Color('#eab308'),   // Gold (selenium)
};

const ELEMENT_RADII: Record<string, number> = {
  H: 0.31,
  C: 0.76,
  N: 0.71,
  O: 0.66,
  S: 1.05,
  P: 1.07,
};

const FUNCTIONAL_GROUP_COLORS: Record<FunctionalGroupType, Color> = {
  aromatic: new Color('#c084fc'),
  disulfide: new Color('#facc15'),
  phosphate: new Color('#fb923c'),
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
  const functionalGroups = detectFunctionalGroups(atoms, bonds);

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
    functionalGroups,
  };
}

function buildAdjacency(atoms: AtomRecord[], bonds: Bond[]): number[][] {
  const adj: number[][] = Array.from({ length: atoms.length }, () => []);
  for (const { a, b } of bonds) {
    adj[a].push(b);
    adj[b].push(a);
  }
  return adj;
}

function detectAromaticRings(atoms: AtomRecord[], bonds: Bond[]): FunctionalGroup[] {
  const adj = buildAdjacency(atoms, bonds);
  const rings: FunctionalGroup[] = [];
  const isCarbon = (idx: number) => atoms[idx].element.toUpperCase() === 'C';

  const maxPlanarOffset = 0.25; // Å deviation from plane

  for (let start = 0; start < atoms.length; start++) {
    if (!isCarbon(start)) continue;
    const stack: number[] = [start];
    const visited = new Set<number>([start]);

    const dfs = (current: number, depth: number) => {
      if (depth === 5) {
        for (const next of adj[current]) {
          if (next === start) {
            const ring = [...stack];
            // Require start to be the smallest index to avoid duplicates
            if (ring.some(idx => idx < start)) continue;
            if (!ring.every(isCarbon)) continue;
            if (isPlanarRing(ring, atoms, maxPlanarOffset)) {
              rings.push({
                type: 'aromatic',
                atomIndices: ring,
                color: FUNCTIONAL_GROUP_COLORS.aromatic,
              });
            }
          }
        }
        return;
      }

      for (const next of adj[current]) {
        if (next === start) continue; // close only at depth 5
        if (next <= start) continue; // enforce ordering to limit duplicates
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
  if (indices.length < 3) return false;
  const [i0, i1, i2] = indices;
  const a = new Vector3(atoms[i0].x, atoms[i0].y, atoms[i0].z);
  const b = new Vector3(atoms[i1].x, atoms[i1].y, atoms[i1].z);
  const c = new Vector3(atoms[i2].x, atoms[i2].y, atoms[i2].z);
  const normal = b.clone().sub(a).cross(c.clone().sub(a)).normalize();
  if (normal.lengthSq() === 0) return false;

  const distanceToPlane = (p: Vector3) => Math.abs(normal.dot(p.clone().sub(a)));
  for (const idx of indices) {
    const p = new Vector3(atoms[idx].x, atoms[idx].y, atoms[idx].z);
    if (distanceToPlane(p) > tolerance) return false;
  }
  return true;
}

function detectDisulfides(atoms: AtomRecord[], bonds: Bond[]): FunctionalGroup[] {
  const adj = buildAdjacency(atoms, bonds);
  const groups: FunctionalGroup[] = [];
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
          color: FUNCTIONAL_GROUP_COLORS.disulfide,
        });
      }
    }
  }

  return groups;
}

function detectPhosphates(atoms: AtomRecord[], bonds: Bond[]): FunctionalGroup[] {
  const adj = buildAdjacency(atoms, bonds);
  const groups: FunctionalGroup[] = [];
  atoms.forEach((atom, idx) => {
    if (atom.element.toUpperCase() !== 'P') return;
    const oxyNeighbors = adj[idx].filter(n => atoms[n].element.toUpperCase() === 'O');
    if (oxyNeighbors.length >= 3) {
      groups.push({
        type: 'phosphate',
        atomIndices: [idx, ...oxyNeighbors],
        color: FUNCTIONAL_GROUP_COLORS.phosphate,
      });
    }
  });
  return groups;
}

function detectFunctionalGroups(atoms: AtomRecord[], bonds: Bond[]): FunctionalGroup[] {
  return [
    ...detectAromaticRings(atoms, bonds),
    ...detectDisulfides(atoms, bonds),
    ...detectPhosphates(atoms, bonds),
  ];
}

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

  // ATOMS - use instanced mesh with per-instance colors
  const atomGeo = new SphereGeometry(sphereRadius, sphereSegments, sphereSegments);
  const atomMat = new MeshPhongMaterial({
    shininess: 100,              // High shininess
    specular: new Color('#aaaaaa'),  // Bright specular
    emissive: new Color('#222222'),  // Base illumination to prevent blackness
    emissiveIntensity: 0.2,
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
  const bondGeo = new CylinderGeometry(bondRadius, bondRadius, 1, bondRadialSegments, 1, true);
  const bondMat = new MeshPhongMaterial({
    color: '#e4e4e7',  // Very bright zinc/silver
    shininess: 80,
    specular: new Color('#aaaaaa'),
    emissive: new Color('#333333'),  // Stronger self-illumination
    emissiveIntensity: 0.2,
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

  // Create a more visible, colorful surface
  const geo = new SphereGeometry(0.7 * scale, segments, segments);

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
        vertexColors: true,
        transparent: true,
        opacity: 0.35,
        shininess: 80,
        emissiveIntensity: 0.2,
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

