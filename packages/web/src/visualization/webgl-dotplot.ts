/**
 * WebGL DotPlot Renderer
 *
 * GPU-accelerated dot plot for comparing DNA sequences.
 * Uses WebGL shaders to compute similarity matrix in parallel.
 */

// Vertex shader - draws a fullscreen quad
const VERTEX_SHADER = `#version 300 es
precision highp float;

in vec2 a_position;
out vec2 v_texCoord;

void main() {
  gl_Position = vec4(a_position, 0.0, 1.0);
  // Map from [-1,1] to [0,1] for texture coords
  v_texCoord = (a_position + 1.0) * 0.5;
}
`;

// Fragment shader - computes sequence similarity
const FRAGMENT_SHADER = `#version 300 es
precision highp float;

uniform sampler2D u_sequenceA;
uniform sampler2D u_sequenceB;
uniform vec2 u_sizeA;       // Width, height of sequence A texture
uniform vec2 u_sizeB;       // Width, height of sequence B texture
uniform int u_lengthA;      // Actual sequence length A
uniform int u_lengthB;      // Actual sequence length B
uniform int u_windowSize;   // K-mer window size for matching
uniform float u_threshold;  // Similarity threshold for display
uniform vec2 u_pan;         // Pan offset (0-1)
uniform float u_zoom;       // Zoom level (1.0 = full view)
uniform vec3 u_matchColor;  // Color for matches
uniform vec3 u_bgColor;     // Background color

in vec2 v_texCoord;
out vec4 fragColor;

// Decode base from texture value (0=A, 0.25=C, 0.5=G, 0.75=T, 1=N)
int decodeBase(float value) {
  if (value < 0.125) return 0;      // A
  if (value < 0.375) return 1;      // C
  if (value < 0.625) return 2;      // G
  if (value < 0.875) return 3;      // T
  return 4;                          // N (ambiguous)
}

// Get base at position from sequence texture
int getBase(sampler2D seq, vec2 size, int pos, int len) {
  if (pos < 0 || pos >= len) return 4; // Out of bounds = N
  int texWidth = int(size.x);
  int x = pos % texWidth;
  int y = pos / texWidth;
  vec2 coord = (vec2(float(x), float(y)) + 0.5) / size;
  float value = texture(seq, coord).r;
  return decodeBase(value);
}

// Count matches in a window
float windowMatch(int posA, int posB) {
  int matches = 0;
  int validBases = 0;

  for (int i = 0; i < u_windowSize; i++) {
    int baseA = getBase(u_sequenceA, u_sizeA, posA + i, u_lengthA);
    int baseB = getBase(u_sequenceB, u_sizeB, posB + i, u_lengthB);

    // Skip if either is ambiguous
    if (baseA == 4 || baseB == 4) continue;

    validBases++;
    if (baseA == baseB) matches++;
  }

  if (validBases == 0) return 0.0;
  return float(matches) / float(validBases);
}

void main() {
  // Apply pan and zoom to get actual sequence positions
  vec2 viewCoord = (v_texCoord - 0.5) / u_zoom + u_pan + 0.5;

  // Clamp to valid range
  if (viewCoord.x < 0.0 || viewCoord.x > 1.0 ||
      viewCoord.y < 0.0 || viewCoord.y > 1.0) {
    fragColor = vec4(u_bgColor * 0.5, 1.0);
    return;
  }

  // Convert to sequence positions
  int posA = int(viewCoord.x * float(u_lengthA - u_windowSize + 1));
  int posB = int(viewCoord.y * float(u_lengthB - u_windowSize + 1));

  // Compute similarity
  float similarity = windowMatch(posA, posB);

  // Apply threshold and color
  if (similarity >= u_threshold) {
    // Intensity based on similarity
    float intensity = (similarity - u_threshold) / (1.0 - u_threshold);
    fragColor = vec4(mix(u_bgColor, u_matchColor, intensity), 1.0);
  } else {
    fragColor = vec4(u_bgColor, 1.0);
  }
}
`;

export interface DotPlotOptions {
  /** Canvas element to render to */
  canvas: HTMLCanvasElement;
  /** Window size for k-mer matching (default: 11) */
  windowSize?: number;
  /** Similarity threshold (0-1, default: 0.7) */
  threshold?: number;
  /** Match color as RGB (0-1) */
  matchColor?: [number, number, number];
  /** Background color as RGB (0-1) */
  bgColor?: [number, number, number];
}

export interface DotPlotState {
  pan: [number, number];
  zoom: number;
}

/**
 * Encode DNA sequence into a texture-ready Float32Array
 * Values: A=0, C=0.25, G=0.5, T=0.75, N=1
 */
export function encodeSequenceToTexture(sequence: string): {
  data: Float32Array;
  width: number;
  height: number;
} {
  const length = sequence.length;
  // Use power-of-2 texture dimensions for efficiency
  const width = Math.min(4096, Math.ceil(Math.sqrt(length)));
  const height = Math.ceil(length / width);
  const data = new Float32Array(width * height);

  for (let i = 0; i < length; i++) {
    const base = sequence[i].toUpperCase();
    switch (base) {
      case 'A':
        data[i] = 0.0;
        break;
      case 'C':
        data[i] = 0.25;
        break;
      case 'G':
        data[i] = 0.5;
        break;
      case 'T':
      case 'U':
        data[i] = 0.75;
        break;
      default:
        data[i] = 1.0; // N or unknown
    }
  }

  // Fill remaining with N
  for (let i = length; i < width * height; i++) {
    data[i] = 1.0;
  }

  return { data, width, height };
}

export class WebGLDotPlotRenderer {
  private gl: WebGL2RenderingContext;
  private program: WebGLProgram;
  private vao: WebGLVertexArrayObject;

  private textureA: WebGLTexture | null = null;
  private textureB: WebGLTexture | null = null;
  private lengthA = 0;
  private lengthB = 0;
  private texSizeA: [number, number] = [1, 1];
  private texSizeB: [number, number] = [1, 1];

  private windowSize: number;
  private threshold: number;
  private matchColor: [number, number, number];
  private bgColor: [number, number, number];

  private pan: [number, number] = [0, 0];
  private zoom = 1;

  private animationFrameId: number | null = null;
  private needsRender = true;

  constructor(options: DotPlotOptions) {
    const { canvas, windowSize = 11, threshold = 0.7, matchColor = [0.2, 0.8, 0.4], bgColor = [0.05, 0.05, 0.1] } = options;

    // Get WebGL2 context
    const gl = canvas.getContext('webgl2', { antialias: false, alpha: false });
    if (!gl) throw new Error('WebGL2 not supported');
    this.gl = gl;

    this.windowSize = windowSize;
    this.threshold = threshold;
    this.matchColor = matchColor;
    this.bgColor = bgColor;

    // Compile shaders
    const vertexShader = this.compileShader(gl.VERTEX_SHADER, VERTEX_SHADER);
    const fragmentShader = this.compileShader(gl.FRAGMENT_SHADER, FRAGMENT_SHADER);

    // Create program
    this.program = gl.createProgram()!;
    gl.attachShader(this.program, vertexShader);
    gl.attachShader(this.program, fragmentShader);
    gl.linkProgram(this.program);

    if (!gl.getProgramParameter(this.program, gl.LINK_STATUS)) {
      const error = gl.getProgramInfoLog(this.program);
      throw new Error(`Program link failed: ${error}`);
    }

    // Create fullscreen quad VAO
    this.vao = gl.createVertexArray()!;
    gl.bindVertexArray(this.vao);

    const positions = new Float32Array([-1, -1, 1, -1, -1, 1, 1, 1]);
    const positionBuffer = gl.createBuffer();
    gl.bindBuffer(gl.ARRAY_BUFFER, positionBuffer);
    gl.bufferData(gl.ARRAY_BUFFER, positions, gl.STATIC_DRAW);

    const positionLoc = gl.getAttribLocation(this.program, 'a_position');
    gl.enableVertexAttribArray(positionLoc);
    gl.vertexAttribPointer(positionLoc, 2, gl.FLOAT, false, 0, 0);

    gl.bindVertexArray(null);

    // Start render loop
    this.startRenderLoop();
  }

  private compileShader(type: number, source: string): WebGLShader {
    const { gl } = this;
    const shader = gl.createShader(type)!;
    gl.shaderSource(shader, source);
    gl.compileShader(shader);

    if (!gl.getShaderParameter(shader, gl.COMPILE_STATUS)) {
      const error = gl.getShaderInfoLog(shader);
      gl.deleteShader(shader);
      throw new Error(`Shader compilation failed: ${error}`);
    }

    return shader;
  }

  private createSequenceTexture(encoded: { data: Float32Array; width: number; height: number }): WebGLTexture {
    const { gl } = this;
    const texture = gl.createTexture()!;
    gl.bindTexture(gl.TEXTURE_2D, texture);

    // Use R32F format for single-channel float data
    gl.texImage2D(gl.TEXTURE_2D, 0, gl.R32F, encoded.width, encoded.height, 0, gl.RED, gl.FLOAT, encoded.data);

    // Nearest filtering - we want exact values
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.NEAREST);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.NEAREST);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);

    return texture;
  }

  /**
   * Set the sequences to compare
   */
  setSequences(sequenceA: string, sequenceB: string): void {
    const { gl } = this;

    // Clean up old textures
    if (this.textureA) gl.deleteTexture(this.textureA);
    if (this.textureB) gl.deleteTexture(this.textureB);

    // Encode and create textures
    const encodedA = encodeSequenceToTexture(sequenceA);
    const encodedB = encodeSequenceToTexture(sequenceB);

    this.textureA = this.createSequenceTexture(encodedA);
    this.textureB = this.createSequenceTexture(encodedB);

    this.lengthA = sequenceA.length;
    this.lengthB = sequenceB.length;
    this.texSizeA = [encodedA.width, encodedA.height];
    this.texSizeB = [encodedB.width, encodedB.height];

    this.needsRender = true;
  }

  /**
   * Set pan position (0-1 range, where 0.5 is center)
   */
  setPan(x: number, y: number): void {
    this.pan = [x, y];
    this.needsRender = true;
  }

  /**
   * Set zoom level (1.0 = full view, higher = zoomed in)
   */
  setZoom(zoom: number): void {
    this.zoom = Math.max(0.1, Math.min(100, zoom));
    this.needsRender = true;
  }

  /**
   * Set similarity threshold (0-1)
   */
  setThreshold(threshold: number): void {
    this.threshold = Math.max(0, Math.min(1, threshold));
    this.needsRender = true;
  }

  /**
   * Update match and background colors
   */
  setColors(matchColor: [number, number, number], bgColor: [number, number, number]): void {
    this.matchColor = matchColor;
    this.bgColor = bgColor;
    this.needsRender = true;
  }

  /**
   * Set window size for k-mer matching
   */
  setWindowSize(size: number): void {
    this.windowSize = Math.max(1, Math.min(31, size)); // Limit for shader performance
    this.needsRender = true;
  }

  /**
   * Get current state for saving/restoring view
   */
  getState(): DotPlotState {
    return { pan: [...this.pan], zoom: this.zoom };
  }

  /**
   * Restore state
   */
  setState(state: DotPlotState): void {
    this.pan = [...state.pan];
    this.zoom = state.zoom;
    this.needsRender = true;
  }

  /**
   * Convert canvas coordinates to sequence positions
   */
  canvasToSequence(canvasX: number, canvasY: number): { posA: number; posB: number } | null {
    const { gl } = this;
    const width = gl.canvas.width;
    const height = gl.canvas.height;

    // Normalize to 0-1
    const normX = canvasX / width;
    const normY = 1 - canvasY / height; // Flip Y

    // Apply inverse pan/zoom
    const viewX = (normX - 0.5) / this.zoom + this.pan[0] + 0.5;
    const viewY = (normY - 0.5) / this.zoom + this.pan[1] + 0.5;

    if (viewX < 0 || viewX > 1 || viewY < 0 || viewY > 1) {
      return null;
    }

    return {
      posA: Math.floor(viewX * this.lengthA),
      posB: Math.floor(viewY * this.lengthB),
    };
  }

  private startRenderLoop(): void {
    const render = () => {
      if (this.needsRender) {
        this.render();
        this.needsRender = false;
      }
      this.animationFrameId = requestAnimationFrame(render);
    };
    render();
  }

  private render(): void {
    const { gl } = this;

    if (!this.textureA || !this.textureB) {
      // No sequences - just clear
      gl.viewport(0, 0, gl.canvas.width, gl.canvas.height);
      gl.clearColor(this.bgColor[0], this.bgColor[1], this.bgColor[2], 1);
      gl.clear(gl.COLOR_BUFFER_BIT);
      return;
    }

    gl.viewport(0, 0, gl.canvas.width, gl.canvas.height);
    gl.useProgram(this.program);
    gl.bindVertexArray(this.vao);

    // Bind textures
    gl.activeTexture(gl.TEXTURE0);
    gl.bindTexture(gl.TEXTURE_2D, this.textureA);
    gl.uniform1i(gl.getUniformLocation(this.program, 'u_sequenceA'), 0);

    gl.activeTexture(gl.TEXTURE1);
    gl.bindTexture(gl.TEXTURE_2D, this.textureB);
    gl.uniform1i(gl.getUniformLocation(this.program, 'u_sequenceB'), 1);

    // Set uniforms
    gl.uniform2f(gl.getUniformLocation(this.program, 'u_sizeA'), this.texSizeA[0], this.texSizeA[1]);
    gl.uniform2f(gl.getUniformLocation(this.program, 'u_sizeB'), this.texSizeB[0], this.texSizeB[1]);
    gl.uniform1i(gl.getUniformLocation(this.program, 'u_lengthA'), this.lengthA);
    gl.uniform1i(gl.getUniformLocation(this.program, 'u_lengthB'), this.lengthB);
    gl.uniform1i(gl.getUniformLocation(this.program, 'u_windowSize'), this.windowSize);
    gl.uniform1f(gl.getUniformLocation(this.program, 'u_threshold'), this.threshold);
    gl.uniform2f(gl.getUniformLocation(this.program, 'u_pan'), this.pan[0], this.pan[1]);
    gl.uniform1f(gl.getUniformLocation(this.program, 'u_zoom'), this.zoom);
    gl.uniform3f(gl.getUniformLocation(this.program, 'u_matchColor'), this.matchColor[0], this.matchColor[1], this.matchColor[2]);
    gl.uniform3f(gl.getUniformLocation(this.program, 'u_bgColor'), this.bgColor[0], this.bgColor[1], this.bgColor[2]);

    // Draw fullscreen quad
    gl.drawArrays(gl.TRIANGLE_STRIP, 0, 4);
  }

  /**
   * Resize canvas and trigger re-render
   */
  resize(): void {
    const { gl } = this;
    const canvas = gl.canvas as HTMLCanvasElement;
    const dpr = window.devicePixelRatio || 1;
    const width = canvas.clientWidth * dpr;
    const height = canvas.clientHeight * dpr;

    if (canvas.width !== width || canvas.height !== height) {
      canvas.width = width;
      canvas.height = height;
      this.needsRender = true;
    }
  }

  /**
   * Force a re-render
   */
  markDirty(): void {
    this.needsRender = true;
  }

  /**
   * Clean up resources
   */
  dispose(): void {
    if (this.animationFrameId !== null) {
      cancelAnimationFrame(this.animationFrameId);
    }
    const { gl } = this;
    if (this.textureA) gl.deleteTexture(this.textureA);
    if (this.textureB) gl.deleteTexture(this.textureB);
    gl.deleteProgram(this.program);
    gl.deleteVertexArray(this.vao);
  }
}

export default WebGLDotPlotRenderer;
