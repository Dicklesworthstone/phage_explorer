import {
  Box3,
  Color,
  Group,
  InstancedMesh,
  Matrix4,
  MeshPhongMaterial,
  SphereGeometry,
  Vector3,
} from 'three';

export type StructureFormat = 'pdb' | 'mmcif';

export interface LoadedStructure {
  group: Group;
  center: Vector3;
  radius: number;
  atomCount: number;
}

interface AtomRecord {
  x: number;
  y: number;
  z: number;
  element: string;
}

const ELEMENT_COLORS: Record<string, Color> = {
  H: new Color('#ffffff'),
  C: new Color('#4b5563'),
  N: new Color('#2563eb'),
  O: new Color('#dc2626'),
  S: new Color('#f59e0b'),
  P: new Color('#c084fc'),
  MG: new Color('#22c55e'),
  FE: new Color('#ef4444'),
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
    const x = parseFloat(line.slice(30, 38));
    const y = parseFloat(line.slice(38, 46));
    const z = parseFloat(line.slice(46, 54));
    const element = line.slice(76, 78).trim() || line.slice(12, 14).trim();
    if (Number.isFinite(x) && Number.isFinite(y) && Number.isFinite(z)) {
      atoms.push({ x, y, z, element: element.toUpperCase() });
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

  for (let i = dataStart; i < lines.length; i++) {
    const line = lines[i].trim();
    if (line.startsWith('#') || line.startsWith('loop_') || line === '') break;
    const parts = line.split(/\s+/);
    const x = parseFloat(parts[xIdx]);
    const y = parseFloat(parts[yIdx]);
    const z = parseFloat(parts[zIdx]);
    const element = (parts[elIdx] ?? 'C').toUpperCase();
    if (Number.isFinite(x) && Number.isFinite(y) && Number.isFinite(z)) {
      atoms.push({ x, y, z, element });
    }
  }

  return atoms;
}

function colorForElement(element: string): Color {
  const key = element.toUpperCase();
  return ELEMENT_COLORS[key] ?? new Color('#22d3ee');
}

function buildMesh(atoms: AtomRecord[]): Group {
  const group = new Group();
  const geometry = new SphereGeometry(0.5, 18, 18);
  const material = new MeshPhongMaterial({ vertexColors: true, shininess: 40 });
  const mesh = new InstancedMesh(geometry, material, atoms.length);
  const matrix = new Matrix4();
  const color = new Color();

  atoms.forEach((atom, index) => {
    matrix.setPosition(atom.x, atom.y, atom.z);
    mesh.setMatrixAt(index, matrix);
    mesh.setColorAt(index, color.copy(colorForElement(atom.element)));
  });

  mesh.instanceMatrix.needsUpdate = true;
  if (mesh.instanceColor) {
    mesh.instanceColor.needsUpdate = true;
  }
  group.add(mesh);
  return group;
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
  const group = buildMesh(atoms);
  const box = new Box3().setFromObject(group);
  const center = box.getCenter(new Vector3());
  const radius = box.getSize(new Vector3()).length() / 2 || 1;
  return { group, center, radius, atomCount: atoms.length };
}

