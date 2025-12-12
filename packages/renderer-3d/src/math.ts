// 3D Math utilities for ASCII rendering

export interface Vector3 {
  x: number;
  y: number;
  z: number;
}

export interface Matrix4 {
  m: number[][];
}

// Create a zero vector
export function vec3(x = 0, y = 0, z = 0): Vector3 {
  return { x, y, z };
}

// Vector operations
export function add(a: Vector3, b: Vector3): Vector3 {
  return { x: a.x + b.x, y: a.y + b.y, z: a.z + b.z };
}

export function sub(a: Vector3, b: Vector3): Vector3 {
  return { x: a.x - b.x, y: a.y - b.y, z: a.z - b.z };
}

export function scale(v: Vector3, s: number): Vector3 {
  return { x: v.x * s, y: v.y * s, z: v.z * s };
}

export function dot(a: Vector3, b: Vector3): number {
  return a.x * b.x + a.y * b.y + a.z * b.z;
}

export function cross(a: Vector3, b: Vector3): Vector3 {
  return {
    x: a.y * b.z - a.z * b.y,
    y: a.z * b.x - a.x * b.z,
    z: a.x * b.y - a.y * b.x,
  };
}

export function length(v: Vector3): number {
  return Math.hypot(v.x, v.y, v.z);
}

export function normalize(v: Vector3): Vector3 {
  const len = length(v);
  if (len === 0) return vec3();
  return scale(v, 1 / len);
}

// Matrix operations
export function identity(): Matrix4 {
  return {
    m: [
      [1, 0, 0, 0],
      [0, 1, 0, 0],
      [0, 0, 1, 0],
      [0, 0, 0, 1],
    ],
  };
}

export function rotationX(angle: number): Matrix4 {
  const c = Math.cos(angle);
  const s = Math.sin(angle);
  return {
    m: [
      [1, 0, 0, 0],
      [0, c, -s, 0],
      [0, s, c, 0],
      [0, 0, 0, 1],
    ],
  };
}

export function rotationY(angle: number): Matrix4 {
  const c = Math.cos(angle);
  const s = Math.sin(angle);
  return {
    m: [
      [c, 0, s, 0],
      [0, 1, 0, 0],
      [-s, 0, c, 0],
      [0, 0, 0, 1],
    ],
  };
}

export function rotationZ(angle: number): Matrix4 {
  const c = Math.cos(angle);
  const s = Math.sin(angle);
  return {
    m: [
      [c, -s, 0, 0],
      [s, c, 0, 0],
      [0, 0, 1, 0],
      [0, 0, 0, 1],
    ],
  };
}

export function multiply(a: Matrix4, b: Matrix4): Matrix4 {
  const result: number[][] = [];
  for (let i = 0; i < 4; i++) {
    result[i] = [];
    for (let j = 0; j < 4; j++) {
      result[i][j] = 0;
      for (let k = 0; k < 4; k++) {
        result[i][j] += a.m[i][k] * b.m[k][j];
      }
    }
  }
  return { m: result };
}

export function transform(v: Vector3, m: Matrix4): Vector3 {
  return {
    x: v.x * m.m[0][0] + v.y * m.m[0][1] + v.z * m.m[0][2] + m.m[0][3],
    y: v.x * m.m[1][0] + v.y * m.m[1][1] + v.z * m.m[1][2] + m.m[1][3],
    z: v.x * m.m[2][0] + v.y * m.m[2][1] + v.z * m.m[2][2] + m.m[2][3],
  };
}

// Create a combined rotation matrix
export function rotation(rx: number, ry: number, rz: number): Matrix4 {
  return multiply(multiply(rotationX(rx), rotationY(ry)), rotationZ(rz));
}

// Project 3D point to 2D screen coordinates
export function project(
  v: Vector3,
  screenWidth: number,
  screenHeight: number,
  fov: number = 1.5,
  distance: number = 3
): { x: number; y: number; z: number } {
  // Simple perspective projection
  const z = v.z + distance;
  const factor = fov / z;

  return {
    x: (v.x * factor * screenWidth) / 2 + screenWidth / 2,
    y: (-v.y * factor * screenHeight) / 2 + screenHeight / 2,
    z: z, // Keep z for depth sorting/shading
  };
}
