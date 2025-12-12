// ASCII 3D Renderer
// Renders 3D models to ASCII art with high-quality shading

import type { Vector3 } from './math';
import type { Model3D } from './models';
import { rotation, transform, project } from './math';

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

  // Transform and project all vertices
  const projectedVertices: { x: number; y: number; z: number }[] = [];

  for (const vertex of model.vertices) {
    const transformed = transform(vertex, rotMatrix);
    projectedVertices.push(project(transformed, width, height, 1.5, 3));
  }

  // Draw edges with z-buffering
  for (const [i1, i2] of model.edges) {
    const p1 = projectedVertices[i1];
    const p2 = projectedVertices[i2];

    // Simple line drawing with z-interpolation
    drawLine(
      Math.round(p1.x), Math.round(p1.y), p1.z,
      Math.round(p2.x), Math.round(p2.y), p2.z,
      zBuffer, bBuffer, width, height
    );
  }

  // Draw vertices as points (brighter)
  for (let i = 0; i < projectedVertices.length; i++) {
    const p = projectedVertices[i];
    const x = Math.round(p.x);
    const y = Math.round(p.y);

    if (x >= 0 && x < width && y >= 0 && y < height) {
      const idx = y * width + x;
      if (p.z < zBuffer[idx]) {
        // Vertices are brighter than edges - use full brightness range
        const depthFactor = Math.max(0, Math.min(1, (4.5 - p.z) / 3));
        const brightness = 0.5 + depthFactor * 0.5; // Range: 0.5 to 1.0
        zBuffer[idx] = p.z;
        bBuffer[idx] = brightness;
      }
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
