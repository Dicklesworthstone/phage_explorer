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

// Updated structure-loader.ts using Web Worker
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
import StructureWorker from './structure.worker?worker';

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
const ELEMENT_COLORS: Record<string, Color> = {
  H: new Color('#f8fafc'),
  C: new Color('#94a3b8'),
  N: new Color('#3b82f6'),
  O: new Color('#ef4444'),
  S: new Color('#fde047'),
  P: new Color('#fb923c'),
  MG: new Color('#22c55e'),
  FE: new Color('#ea580c'),
  CA: new Color('#16a34a'),
  ZN: new Color('#7c3aed'),
  CL: new Color('#4ade80'),
  NA: new Color('#a855f7'),
  K: new Color('#8b5cf6'),
  MN: new Color('#9333ea'),
  CU: new Color('#f97316'),
  SE: new Color('#eab308'),
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

  // Offload to worker
  return new Promise((resolve, reject) => {
    const worker = new StructureWorker();
    
    worker.onmessage = (e) => {
      const { type, data, error } = e.data;
      if (type === 'error') {
        worker.terminate();
        reject(new Error(error));
        return;
      }
      
      if (type === 'success') {
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

        worker.terminate();
        resolve({
          atoms,
          bonds,
          backboneTraces,
          chains,
          center,
          radius,
          atomCount: atoms.length,
          functionalGroups,
        });
      }
    };

    worker.onerror = (e) => {
      worker.terminate();
      reject(new Error(e.message));
    };

    worker.postMessage({ text, format });
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

  // ATOMS - use instanced mesh with per-instance colors
  const atomGeo = new SphereGeometry(sphereRadius, sphereSegments, sphereSegments);
  const atomMat = new MeshPhongMaterial({
    shininess: 140,              // High shininess for crisp highlights
    specular: new Color('#cbd5e1'),  // Bright specular
    emissive: new Color('#0b1224'),  // Base illumination to prevent blackness
    emissiveIntensity: 0.14,
    vertexColors: true,
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
    color: '#f3f4f6',  // Very bright zinc/silver
    shininess: 90,
    specular: new Color('#cbd5e1'),
    emissive: new Color('#1f2937'),  // Gentle self-illumination
    emissiveIntensity: 0.16,
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
