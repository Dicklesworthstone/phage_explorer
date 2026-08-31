// Pre-built 3D models for phage visualization
// These are simplified geometric approximations of phage structures

import type { Vector3 } from './math';
import { vec3, normalize, scale, add } from './math';

export interface Model3D {
  vertices: Vector3[];
  edges: [number, number][]; // Pairs of vertex indices to connect
  name: string;
}

// Generate icosahedron vertices (for capsid)
function generateIcosahedron(radius: number): Vector3[] {
  const phi = (1 + Math.sqrt(5)) / 2; // Golden ratio

  const vertices: Vector3[] = [
    vec3(-1, phi, 0),
    vec3(1, phi, 0),
    vec3(-1, -phi, 0),
    vec3(1, -phi, 0),
    vec3(0, -1, phi),
    vec3(0, 1, phi),
    vec3(0, -1, -phi),
    vec3(0, 1, -phi),
    vec3(phi, 0, -1),
    vec3(phi, 0, 1),
    vec3(-phi, 0, -1),
    vec3(-phi, 0, 1),
  ];

  // Normalize and scale to radius
  return vertices.map(v => scale(normalize(v), radius));
}

// Generate cylinder points (for tail)
function generateCylinder(
  radius: number,
  height: number,
  segments: number,
  yOffset: number = 0
): Vector3[] {
  const vertices: Vector3[] = [];

  for (let ring = 0; ring <= 4; ring++) {
    const y = yOffset - (ring * height) / 4;
    for (let i = 0; i < segments; i++) {
      const angle = (i * 2 * Math.PI) / segments;
      vertices.push({
        x: radius * Math.cos(angle),
        y: y,
        z: radius * Math.sin(angle),
      });
    }
  }

  return vertices;
}

// Generate leg/fiber points (for tail fibers)
function generateFibers(count: number, length: number, yOffset: number): Vector3[] {
  const vertices: Vector3[] = [];

  for (let i = 0; i < count; i++) {
    const angle = (i * 2 * Math.PI) / count;
    const baseX = 0.15 * Math.cos(angle);
    const baseZ = 0.15 * Math.sin(angle);

    // Base point
    vertices.push(vec3(baseX, yOffset, baseZ));

    // Mid point (angled outward)
    vertices.push(vec3(baseX * 2, yOffset - length * 0.4, baseZ * 2));

    // Tip (angled further)
    vertices.push(vec3(baseX * 3, yOffset - length * 0.8, baseZ * 3));
  }

  return vertices;
}

// Lambda phage model (siphovirus - icosahedral head + long flexible tail)
export function createLambdaPhage(): Model3D {
  const vertices: Vector3[] = [];
  const edges: [number, number][] = [];

  // Head (icosahedron, centered at y=0.5)
  const headVertices = generateIcosahedron(0.4);
  headVertices.forEach(v => vertices.push(add(v, vec3(0, 0.5, 0))));

  // Connect icosahedron vertices
  const icoEdges: [number, number][] = [
    [0, 1], [0, 5], [0, 7], [0, 10], [0, 11],
    [1, 5], [1, 7], [1, 8], [1, 9],
    [2, 3], [2, 4], [2, 6], [2, 10], [2, 11],
    [3, 4], [3, 6], [3, 8], [3, 9],
    [4, 5], [4, 9], [4, 11],
    [5, 9], [5, 11],
    [6, 7], [6, 8], [6, 10],
    [7, 8], [7, 10],
    [8, 9],
    [10, 11],
  ];
  edges.push(...icoEdges);

  // Tail (long thin cylinder)
  const tailStart = vertices.length;
  const tailVertices = generateCylinder(0.08, 1.2, 6, 0.1);
  vertices.push(...tailVertices);

  // Connect tail rings
  for (let ring = 0; ring < 4; ring++) {
    for (let i = 0; i < 6; i++) {
      const curr = tailStart + ring * 6 + i;
      const next = tailStart + ring * 6 + ((i + 1) % 6);
      const below = tailStart + (ring + 1) * 6 + i;
      edges.push([curr, next]);
      edges.push([curr, below]);
    }
  }
  // Close bottom ring
  for (let i = 0; i < 6; i++) {
    const curr = tailStart + 4 * 6 + i;
    const next = tailStart + 4 * 6 + ((i + 1) % 6);
    edges.push([curr, next]);
  }

  // Tail tip
  const tipStart = vertices.length;
  vertices.push(vec3(0, -1.1, 0));
  for (let i = 0; i < 6; i++) {
    edges.push([tailStart + 4 * 6 + i, tipStart]);
  }

  return { vertices, edges, name: 'Lambda Phage' };
}

// T4 phage model (myovirus - icosahedral head + contractile tail + baseplate + fibers)
export function createT4Phage(): Model3D {
  const vertices: Vector3[] = [];
  const edges: [number, number][] = [];

  // Elongated head (stretched icosahedron)
  const headVertices = generateIcosahedron(0.35);
  headVertices.forEach(v => {
    // Stretch vertically
    vertices.push(vec3(v.x, v.y * 1.4 + 0.6, v.z));
  });

  // Icosahedron edges
  const icoEdges: [number, number][] = [
    [0, 1], [0, 5], [0, 7], [0, 10], [0, 11],
    [1, 5], [1, 7], [1, 8], [1, 9],
    [2, 3], [2, 4], [2, 6], [2, 10], [2, 11],
    [3, 4], [3, 6], [3, 8], [3, 9],
    [4, 5], [4, 9], [4, 11],
    [5, 9], [5, 11],
    [6, 7], [6, 8], [6, 10],
    [7, 8], [7, 10],
    [8, 9],
    [10, 11],
  ];
  edges.push(...icoEdges);

  // Neck/collar
  const neckStart = vertices.length;
  for (let i = 0; i < 6; i++) {
    const angle = (i * 2 * Math.PI) / 6;
    vertices.push(vec3(0.12 * Math.cos(angle), 0.15, 0.12 * Math.sin(angle)));
  }
  for (let i = 0; i < 6; i++) {
    edges.push([neckStart + i, neckStart + ((i + 1) % 6)]);
  }

  // Tail sheath (thicker cylinder)
  const tailStart = vertices.length;
  const tailVertices = generateCylinder(0.15, 0.8, 8, 0.1);
  vertices.push(...tailVertices);

  for (let ring = 0; ring < 4; ring++) {
    for (let i = 0; i < 8; i++) {
      const curr = tailStart + ring * 8 + i;
      const next = tailStart + ring * 8 + ((i + 1) % 8);
      const below = tailStart + (ring + 1) * 8 + i;
      edges.push([curr, next]);
      edges.push([curr, below]);
    }
  }
  // Close bottom ring
  for (let i = 0; i < 8; i++) {
    const curr = tailStart + 4 * 8 + i;
    const next = tailStart + 4 * 8 + ((i + 1) % 8);
    edges.push([curr, next]);
  }

  // Baseplate
  const baseStart = vertices.length;
  for (let i = 0; i < 6; i++) {
    const angle = (i * 2 * Math.PI) / 6;
    vertices.push(vec3(0.2 * Math.cos(angle), -0.7, 0.2 * Math.sin(angle)));
  }
  for (let i = 0; i < 6; i++) {
    edges.push([baseStart + i, baseStart + ((i + 1) % 6)]);
  }

  // Tail fibers
  const fiberStart = vertices.length;
  const fiberVertices = generateFibers(6, 0.5, -0.7);
  vertices.push(...fiberVertices);

  for (let i = 0; i < 6; i++) {
    const base = fiberStart + i * 3;
    edges.push([base, base + 1]);
    edges.push([base + 1, base + 2]);
  }

  return { vertices, edges, name: 'T4 Phage' };
}

// T7 phage model (podovirus - icosahedral head + short tail)
export function createT7Phage(): Model3D {
  const vertices: Vector3[] = [];
  const edges: [number, number][] = [];

  // Head
  const headVertices = generateIcosahedron(0.45);
  headVertices.forEach(v => vertices.push(add(v, vec3(0, 0.3, 0))));

  const icoEdges: [number, number][] = [
    [0, 1], [0, 5], [0, 7], [0, 10], [0, 11],
    [1, 5], [1, 7], [1, 8], [1, 9],
    [2, 3], [2, 4], [2, 6], [2, 10], [2, 11],
    [3, 4], [3, 6], [3, 8], [3, 9],
    [4, 5], [4, 9], [4, 11],
    [5, 9], [5, 11],
    [6, 7], [6, 8], [6, 10],
    [7, 8], [7, 10],
    [8, 9],
    [10, 11],
  ];
  edges.push(...icoEdges);

  // Short stubby tail
  const tailStart = vertices.length;
  const tailVertices = generateCylinder(0.12, 0.3, 6, -0.15);
  vertices.push(...tailVertices);

  for (let ring = 0; ring < 4; ring++) {
    for (let i = 0; i < 6; i++) {
      const curr = tailStart + ring * 6 + i;
      const next = tailStart + ring * 6 + ((i + 1) % 6);
      const below = tailStart + (ring + 1) * 6 + i;
      edges.push([curr, next]);
      edges.push([curr, below]);
    }
  }
  // Close bottom ring
  for (let i = 0; i < 6; i++) {
    const curr = tailStart + 4 * 6 + i;
    const next = tailStart + 4 * 6 + ((i + 1) % 6);
    edges.push([curr, next]);
  }

  // Small tail fibers
  const fiberStart = vertices.length;
  for (let i = 0; i < 6; i++) {
    const angle = (i * 2 * Math.PI) / 6;
    vertices.push(vec3(0.15 * Math.cos(angle), -0.45, 0.15 * Math.sin(angle)));
    vertices.push(vec3(0.25 * Math.cos(angle), -0.55, 0.25 * Math.sin(angle)));
    edges.push([fiberStart + i * 2, fiberStart + i * 2 + 1]);
  }

  return { vertices, edges, name: 'T7 Phage' };
}

// PhiX174 model (microvirus - small icosahedron with spikes)
export function createPhiX174(): Model3D {
  const vertices: Vector3[] = [];
  const edges: [number, number][] = [];

  // Small icosahedral capsid
  const headVertices = generateIcosahedron(0.5);
  vertices.push(...headVertices);

  const icoEdges: [number, number][] = [
    [0, 1], [0, 5], [0, 7], [0, 10], [0, 11],
    [1, 5], [1, 7], [1, 8], [1, 9],
    [2, 3], [2, 4], [2, 6], [2, 10], [2, 11],
    [3, 4], [3, 6], [3, 8], [3, 9],
    [4, 5], [4, 9], [4, 11],
    [5, 9], [5, 11],
    [6, 7], [6, 8], [6, 10],
    [7, 8], [7, 10],
    [8, 9],
    [10, 11],
  ];
  edges.push(...icoEdges);

  // Spikes at each vertex
  const spikeStart = vertices.length;
  for (let i = 0; i < 12; i++) {
    const spike = scale(normalize(headVertices[i]), 0.7);
    vertices.push(spike);
    edges.push([i, spikeStart + i]);
  }

  return { vertices, edges, name: 'PhiX174' };
}

// M13 filamentous phage (long thin rod)
export function createM13Phage(): Model3D {
  const vertices: Vector3[] = [];
  const edges: [number, number][] = [];

  // Long filamentous body
  const segments = 20;
  const radius = 0.05;

  for (let ring = 0; ring <= segments; ring++) {
    const y = 1.0 - (ring * 2.0) / segments;
    for (let i = 0; i < 6; i++) {
      const angle = (i * 2 * Math.PI) / 6;
      vertices.push(vec3(radius * Math.cos(angle), y, radius * Math.sin(angle)));
    }
  }

  // Connect rings
  for (let ring = 0; ring < segments; ring++) {
    for (let i = 0; i < 6; i++) {
      const curr = ring * 6 + i;
      const next = ring * 6 + ((i + 1) % 6);
      const below = (ring + 1) * 6 + i;
      edges.push([curr, next]);
      edges.push([curr, below]);
    }
  }
  // Last ring
  for (let i = 0; i < 6; i++) {
    edges.push([segments * 6 + i, segments * 6 + ((i + 1) % 6)]);
  }

  // Caps
  const topCenter = vertices.length;
  vertices.push(vec3(0, 1.05, 0));
  const bottomCenter = vertices.length;
  vertices.push(vec3(0, -1.05, 0));

  for (let i = 0; i < 6; i++) {
    edges.push([i, topCenter]);
    edges.push([segments * 6 + i, bottomCenter]);
  }

  return { vertices, edges, name: 'M13 Phage' };
}

// Generic phage model (for phages without specific models)
export function createGenericPhage(): Model3D {
  return createLambdaPhage(); // Default to lambda shape
}

/**
 * Return a morphology-appropriate ASCII model for a phage slug.
 *
 * The 24 catalog phages are mapped to one of a few canonical shapes
 * (siphovirus, myovirus, podovirus, tailless icosahedral, filamentous,
 * ssRNA levivirus, etc.) so every phage gets a distinct *visual identity*
 * rather than falling back to the same generic Lambda shape.
 */
export function getPhageModel(slug: string): Model3D {
  const model = ((): Model3D => {
    switch (slug) {
      // Long non-contractile tail (siphoviruses)
      case 'lambda':
      case 't1':
      case 't5':
      case 'p2':
      case 'n4':
      case 'spbeta':
      case 'phic31':
      case 'l5':
      case 'felixo1':
        return createLambdaPhage();

      // Contractile tail (myoviruses)
      case 't4':
      case 'p1':
      case 'mu':
      case 'phikz':
        return createT4Phage();

      // Short tail (podoviruses)
      case 't7':
      case 'p22':
      case 'phi29':
      case 'd29':
        return createT7Phage();

      // Small tailless icosahedral
      case 'phix174':
      case 'ms2':
      case 'qbeta':
      case 'prd1':
      case 'pm2':
      case 'phi6':
        return createPhiX174();

      // Filamentous
      case 'm13':
        return createM13Phage();

      default:
        return createGenericPhage();
    }
  })();

  // Normalize the model name to the selected phage for a polished feel.
  return { ...model, name: slug };
}
