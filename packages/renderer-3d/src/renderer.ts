// ASCII 3D Renderer
// Renders 3D models to ASCII art with high-quality shading

import type { Vector3 } from './math';
import type { Model3D } from './models';
import { rotation, transform, project } from './math';

// Culling constants
const NEAR_PLANE = 0.1; // Objects closer than this are clipped
const FAR_PLANE = 10.0; // Objects farther than this are culled
const CAMERA_DISTANCE = 3; // Default camera distance (matches project() default)

// Standard 70-character ASCII gradient from darkest to brightest
// This is the industry-standard gradient used in high-quality ASCII art
const ASCII_GRADIENT_70 = " .'`^\",:;Il!i><~+_-?][}{1)(|\\/tfjrxnuvczXYUJCLQ0OZmwqpdbkhao*#MW&8%B@$";

// Shorter gradients for different quality levels
const ASCII_GRADIENT_10 = ' .:-=+*#%@';
const ASCII_GRADIENT_16 = ' .,:;!|+*%#&@$MW';

// Block characters for smooth shading (Unicode)
const BLOCK_GRADIENT = ' ░▒▓█';
const BLOCK_GRADIENT_DETAILED = ' ·░▒▓▆▇█';

export type RenderQuality = 'low' | 'medium' | 'high' | 'ultra';

export interface RenderConfig {
  width: number;
  height: number;
  useColor?: boolean;
  useBraille?: boolean;
  useBlocks?: boolean;
  quality?: RenderQuality;
  lightDirection?: Vector3;
}

export interface RenderedFrame {
  lines: string[];
  width: number;
  height: number;
}

// Select gradient based on quality and mode
function selectGradient(config: RenderConfig): string {
  const { useBlocks = false, quality = 'medium' } = config;

  if (useBlocks) {
    return quality === 'ultra' ? BLOCK_GRADIENT_DETAILED : BLOCK_GRADIENT;
  }

  switch (quality) {
    case 'low': return ASCII_GRADIENT_10;
    case 'medium': return ASCII_GRADIENT_16;
    case 'high': return ASCII_GRADIENT_70;
    case 'ultra': return ASCII_GRADIENT_70;
    default: return ASCII_GRADIENT_16;
  }
}

// Check if a point is inside the viewport
function isPointInViewport(x: number, y: number, width: number, height: number): boolean {
  return x >= 0 && x < width && y >= 0 && y < height;
}

// Cohen-Sutherland region codes for line clipping
const INSIDE = 0; // 0000
const LEFT = 1;   // 0001
const RIGHT = 2;  // 0010
const BOTTOM = 4; // 0100
const TOP = 8;    // 1000

// Compute Cohen-Sutherland region code for a point
function computeRegionCode(x: number, y: number, width: number, height: number): number {
  let code = INSIDE;
  if (x < 0) code |= LEFT;
  else if (x >= width) code |= RIGHT;
  if (y < 0) code |= TOP;
  else if (y >= height) code |= BOTTOM;
  return code;
}

// Cohen-Sutherland line clipping algorithm
// Returns null if line is entirely outside, or clipped coordinates with interpolated z
function clipLine(
  x0: number, y0: number, z0: number,
  x1: number, y1: number, z1: number,
  width: number, height: number
): { x0: number; y0: number; z0: number; x1: number; y1: number; z1: number } | null {
  let code0 = computeRegionCode(x0, y0, width, height);
  let code1 = computeRegionCode(x1, y1, width, height);

  while (true) {
    // Both endpoints inside viewport
    if ((code0 | code1) === 0) {
      return { x0, y0, z0, x1, y1, z1 };
    }

    // Both endpoints share an outside region (line entirely outside)
    if ((code0 & code1) !== 0) {
      return null;
    }

    // Line needs clipping - pick an outside point
    const codeOut = code0 !== 0 ? code0 : code1;
    let x: number, y: number, z: number;

    // Calculate intersection with viewport boundary
    const dx = x1 - x0;
    const dy = y1 - y0;
    const dz = z1 - z0;

    if (codeOut & TOP) {
      const t = (0 - y0) / dy;
      x = x0 + t * dx;
      y = 0;
      z = z0 + t * dz;
    } else if (codeOut & BOTTOM) {
      const t = (height - 1 - y0) / dy;
      x = x0 + t * dx;
      y = height - 1;
      z = z0 + t * dz;
    } else if (codeOut & RIGHT) {
      const t = (width - 1 - x0) / dx;
      x = x0 + t * dx;
      y = y0 + t * dy;
      z = z0 + t * dz;
    } else { // LEFT
      const t = (0 - x0) / dx;
      x = 0;
      y = y0 + t * dy;
      z = z0 + t * dz;
    }

    // Update the clipped endpoint
    if (codeOut === code0) {
      x0 = x;
      y0 = y;
      z0 = z;
      code0 = computeRegionCode(x0, y0, width, height);
    } else {
      x1 = x;
      y1 = y;
      z1 = z;
      code1 = computeRegionCode(x1, y1, width, height);
    }
  }
}

// Check if a point passes near/far plane test (in camera space)
function isInViewFrustum(z: number): boolean {
  const cameraZ = z + CAMERA_DISTANCE;
  return cameraZ >= NEAR_PLANE && cameraZ <= FAR_PLANE;
}

// Render a 3D model to ASCII
export function renderModel(
  model: Model3D,
  rotationAngles: { rx: number; ry: number; rz: number },
  config: RenderConfig
): RenderedFrame {
  const { width, height } = config;
  const chars = selectGradient(config);

  // Initialize flat buffers for performance
  // Use Infinity for Z-buffer depth (far away)
  const zBuffer = new Float32Array(width * height).fill(Infinity);
  const bBuffer = new Float32Array(width * height);

  // Create rotation matrix
  const rotMatrix = rotation(rotationAngles.rx, rotationAngles.ry, rotationAngles.rz);

  // Transform and project all vertices, with view frustum culling
  const projectedVertices: Array<{ x: number; y: number; z: number; visible: boolean }> = [];

  for (const vertex of model.vertices) {
    const transformed = transform(vertex, rotMatrix);

    // Near/far plane culling in 3D space (before projection)
    const visible = isInViewFrustum(transformed.z);
    const projected = project(transformed, width, height, 1.5, CAMERA_DISTANCE);
    projectedVertices.push({ ...projected, visible });
  }

  // Prepare edges with depth info for front-to-back sorting
  const edgesWithDepth: Array<{ i1: number; i2: number; avgZ: number }> = [];

  for (const [i1, i2] of model.edges) {
    const p1 = projectedVertices[i1];
    const p2 = projectedVertices[i2];

    // Skip edges where both vertices are outside the view frustum
    if (!p1.visible && !p2.visible) {
      continue;
    }

    // Calculate average z for depth sorting (lower z = closer to camera)
    const avgZ = (p1.z + p2.z) / 2;
    edgesWithDepth.push({ i1, i2, avgZ });
  }

  // Sort edges front-to-back for better z-buffer performance
  // Closer edges (lower z) drawn first, so farther edges can be quickly rejected
  edgesWithDepth.sort((a, b) => a.avgZ - b.avgZ);

  // Draw edges with z-buffering and line clipping
  for (const { i1, i2 } of edgesWithDepth) {
    const p1 = projectedVertices[i1];
    const p2 = projectedVertices[i2];

    // Use Cohen-Sutherland clipping instead of simple rejection
    const clipped = clipLine(p1.x, p1.y, p1.z, p2.x, p2.y, p2.z, width, height);

    if (clipped === null) {
      continue; // Line entirely outside viewport
    }

    // Draw clipped line with z-interpolation
    drawLine(
      Math.round(clipped.x0), Math.round(clipped.y0), clipped.z0,
      Math.round(clipped.x1), Math.round(clipped.y1), clipped.z1,
      zBuffer, bBuffer, width, height
    );
  }

  // Draw vertices as points (brighter) with viewport and frustum culling
  // Sort vertices front-to-back as well
  const sortedVertexIndices = projectedVertices
    .map((p, i) => ({ z: p.z, i }))
    .sort((a, b) => a.z - b.z)
    .map(v => v.i);

  for (const i of sortedVertexIndices) {
    const p = projectedVertices[i];

    // Skip vertices outside view frustum
    if (!p.visible) {
      continue;
    }

    const x = Math.round(p.x);
    const y = Math.round(p.y);

    // Skip vertices outside viewport
    if (!isPointInViewport(x, y, width, height)) {
      continue;
    }

    const idx = y * width + x;
    if (p.z < zBuffer[idx]) {
      // Vertices are brighter than edges - use full brightness range
      const depthFactor = Math.max(0, Math.min(1, (4.5 - p.z) / 3));
      const brightness = 0.5 + depthFactor * 0.5; // Range: 0.5 to 1.0
      zBuffer[idx] = p.z;
      bBuffer[idx] = brightness;
    }
  }

  // Convert buffer to ASCII characters
  const lines: string[] = [];
  for (let y = 0; y < height; y++) {
    let line = '';
    const rowOffset = y * width;
    for (let x = 0; x < width; x++) {
      const idx = rowOffset + x;
      const z = zBuffer[idx];
      if (z !== Infinity) {
        const brightness = bBuffer[idx];
        const charIndex = Math.max(0, Math.min(
          chars.length - 1,
          Math.floor(brightness * (chars.length - 1))
        ));
        line += chars[charIndex];
      } else {
        line += ' ';
      }
    }
    lines.push(line);
  }

  return { lines, width, height };
}

// Bresenham's line algorithm with z-interpolation
function drawLine(
  x0: number, y0: number, z0: number,
  x1: number, y1: number, z1: number,
  zBuffer: Float32Array,
  bBuffer: Float32Array,
  width: number, height: number
): void {
  const dx = Math.abs(x1 - x0);
  const dy = Math.abs(y1 - y0);
  const sx = x0 < x1 ? 1 : -1;
  const sy = y0 < y1 ? 1 : -1;
  let err = dx - dy;

  const steps = Math.max(dx, dy);
  const dz = steps > 0 ? (z1 - z0) / steps : 0;
  let z = z0;

  while (true) {
    if (x0 >= 0 && x0 < width && y0 >= 0 && y0 < height) {
      const idx = y0 * width + x0;
      if (z < zBuffer[idx]) {
        // Edges are slightly dimmer than vertices
        const depthFactor = Math.max(0, Math.min(1, (4.5 - z) / 3));
        const brightness = 0.2 + depthFactor * 0.5; // Range: 0.2 to 0.7
        zBuffer[idx] = z;
        bBuffer[idx] = brightness;
      }
    }

    if (x0 === x1 && y0 === y1) break;

    const e2 = 2 * err;
    if (e2 > -dy) {
      err -= dy;
      x0 += sx;
    }
    if (e2 < dx) {
      err += dx;
      y0 += sy;
    }
    z += dz;
  }
}

// Animation state
export interface AnimationState {
  rx: number;
  ry: number;
  rz: number;
  time: number;
}

// Update animation state
export function updateAnimation(
  state: AnimationState,
  deltaTime: number,
  speed: number = 1
): AnimationState {
  const rotSpeed = 0.02 * speed;
  return {
    rx: state.rx + rotSpeed * 0.3 * deltaTime,
    ry: state.ry + rotSpeed * deltaTime,
    rz: state.rz + rotSpeed * 0.1 * deltaTime,
    time: state.time + deltaTime,
  };
}

// Create initial animation state
export function createAnimationState(): AnimationState {
  return { rx: 0.3, ry: 0, rz: 0, time: 0 };
}

// Pre-render a sequence of frames for storage
export function preRenderFrames(
  model: Model3D,
  config: RenderConfig,
  frameCount: number = 60
): string[] {
  const frames: string[] = [];
  let state = createAnimationState();

  for (let i = 0; i < frameCount; i++) {
    const frame = renderModel(model, {
      rx: state.rx,
      ry: state.ry,
      rz: state.rz,
    }, config);

    frames.push(frame.lines.join('\n'));
    state = updateAnimation(state, 1, 1);
  }

  return frames;
}

// Render frame to string with optional border
export function frameToString(frame: RenderedFrame, addBorder: boolean = false): string {
  if (!addBorder) {
    return frame.lines.join('\n');
  }

  const horizontal = '─'.repeat(frame.width);
  const bordered = [
    `┌${horizontal}┐`,
    ...frame.lines.map(line => `│${line.padEnd(frame.width)}│`),
    `└${horizontal}┘`,
  ];

  return bordered.join('\n');
}
