/**
 * WebGL Post-Processing Pipeline
 *
 * Orchestrates a chain of fragment shaders to apply visual effects:
 * 1. CRT/Scanlines
 * 2. Phosphor Bloom
 * 3. Chromatic Aberration
 * 4. Screen Curvature (optional)
 */

export interface PostProcessingOptions {
  canvas: HTMLCanvasElement;
  width: number;
  height: number;
  enableScanlines?: boolean;
  enableBloom?: boolean;
  enableAberration?: boolean;
  intensity?: number;
}

export class PostProcessingPipeline {
  private canvas: HTMLCanvasElement;
  private gl: WebGL2RenderingContext;
  private program: WebGLProgram | null = null;
  private texture: WebGLTexture | null = null;
  private framebuffer: WebGLFramebuffer | null = null;
  
  // Uniform locations
  private uniforms: Record<string, WebGLUniformLocation | null> = {};
  
  // State
  private width: number;
  private height: number;
  private time = 0;
  private options: Required<Omit<PostProcessingOptions, 'canvas' | 'width' | 'height'>>;

  constructor(options: PostProcessingOptions) {
    this.canvas = options.canvas;
    this.width = options.width;
    this.height = options.height;
    this.options = {
      enableScanlines: options.enableScanlines ?? true,
      enableBloom: options.enableBloom ?? true,
      enableAberration: options.enableAberration ?? true,
      intensity: options.intensity ?? 1.0,
    };

    const gl = this.canvas.getContext('webgl2', {
      alpha: false,
      desynchronized: true,
      powerPreference: 'high-performance',
    });

    if (!gl) {
      throw new Error('WebGL 2 not supported');
    }
    this.gl = gl;

    this.init();
  }

  private init(): void {
    const { gl } = this;

    // Create full-screen quad
    const vertices = new Float32Array([
      -1, -1,
       1, -1,
      -1,  1,
       1,  1,
    ]);

    const buffer = gl.createBuffer();
    gl.bindBuffer(gl.ARRAY_BUFFER, buffer);
    gl.bufferData(gl.ARRAY_BUFFER, vertices, gl.STATIC_DRAW);

    // Create program
    const vs = this.createShader(gl.VERTEX_SHADER, VERTEX_SHADER);
    const fs = this.createShader(gl.FRAGMENT_SHADER, FRAGMENT_SHADER);
    
    const program = gl.createProgram();
    if (!program) throw new Error('Failed to create program');
    
    gl.attachShader(program, vs);
    gl.attachShader(program, fs);
    gl.linkProgram(program);

    if (!gl.getProgramParameter(program, gl.LINK_STATUS)) {
      console.error(gl.getProgramInfoLog(program));
      throw new Error('Failed to link program');
    }

    this.program = program;

    // Get attribute/uniform locations
    const positionLoc = gl.getAttribLocation(program, 'a_position');
    gl.enableVertexAttribArray(positionLoc);
    gl.vertexAttribPointer(positionLoc, 2, gl.FLOAT, false, 0, 0);

    this.uniforms = {
      u_resolution: gl.getUniformLocation(program, 'u_resolution'),
      u_time: gl.getUniformLocation(program, 'u_time'),
      u_texture: gl.getUniformLocation(program, 'u_texture'),
      u_enable_scanlines: gl.getUniformLocation(program, 'u_enable_scanlines'),
      u_enable_bloom: gl.getUniformLocation(program, 'u_enable_bloom'),
      u_enable_aberration: gl.getUniformLocation(program, 'u_enable_aberration'),
      u_intensity: gl.getUniformLocation(program, 'u_intensity'),
    };

    // Create texture for input content
    this.texture = gl.createTexture();
    gl.bindTexture(gl.TEXTURE_2D, this.texture);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.LINEAR);
  }

  private createShader(type: number, source: string): WebGLShader {
    const { gl } = this;
    const shader = gl.createShader(type);
    if (!shader) throw new Error('Failed to create shader');

    gl.shaderSource(shader, source);
    gl.compileShader(shader);

    if (!gl.getShaderParameter(shader, gl.COMPILE_STATUS)) {
      console.error(gl.getShaderInfoLog(shader));
      gl.deleteShader(shader);
      throw new Error('Failed to compile shader');
    }

    return shader;
  }

  resize(width: number, height: number): void {
    this.width = width;
    this.height = height;
    this.canvas.width = width;
    this.canvas.height = height;
    this.gl.viewport(0, 0, width, height);
  }

  updateOptions(options: Partial<PostProcessingOptions>): void {
    this.options = { ...this.options, ...options };
  }

  render(sourceCanvas: HTMLCanvasElement | OffscreenCanvas): void {
    const { gl } = this;

    gl.useProgram(this.program);

    // Update texture with source canvas
    gl.activeTexture(gl.TEXTURE0);
    gl.bindTexture(gl.TEXTURE_2D, this.texture);
    gl.texImage2D(
      gl.TEXTURE_2D,
      0,
      gl.RGBA,
      gl.RGBA,
      gl.UNSIGNED_BYTE,
      sourceCanvas as HTMLCanvasElement // Type assertion mainly for OffscreenCanvas compat
    );

    // Set uniforms
    gl.uniform2f(this.uniforms.u_resolution, this.width, this.height);
    gl.uniform1f(this.uniforms.u_time, this.time);
    gl.uniform1i(this.uniforms.u_texture, 0);
    gl.uniform1f(this.uniforms.u_enable_scanlines, this.options.enableScanlines ? 1 : 0);
    gl.uniform1f(this.uniforms.u_enable_bloom, this.options.enableBloom ? 1 : 0);
    gl.uniform1f(this.uniforms.u_enable_aberration, this.options.enableAberration ? 1 : 0);
    gl.uniform1f(this.uniforms.u_intensity, this.options.intensity);

    // Draw
    gl.drawArrays(gl.TRIANGLE_STRIP, 0, 4);

    this.time += 0.016; // approx 60fps
  }

  dispose(): void {
    const { gl } = this;
    gl.deleteProgram(this.program);
    gl.deleteTexture(this.texture);
    // Lose context if possible to free resources
    gl.getExtension('WEBGL_lose_context')?.loseContext();
  }
}

// ============================================================================
// SHADERS
// ============================================================================

const VERTEX_SHADER = `#version 300 es
in vec2 a_position;
out vec2 v_uv;

void main() {
  v_uv = a_position * 0.5 + 0.5;
  // Flip Y because WebGL textures are upside down relative to canvas
  v_uv.y = 1.0 - v_uv.y; 
  gl_Position = vec4(a_position, 0.0, 1.0);
}
`;

const FRAGMENT_SHADER = `#version 300 es
precision mediump float;

uniform sampler2D u_texture;
uniform vec2 u_resolution;
uniform float u_time;
uniform float u_enable_scanlines;
uniform float u_enable_bloom;
uniform float u_enable_aberration;
uniform float u_intensity;

in vec2 v_uv;
out vec4 fragColor;

// Chromatic Aberration
vec3 chromaticAberration(sampler2D tex, vec2 uv, float amount) {
  float r = texture(tex, uv + vec2(amount, 0.0)).r;
  float g = texture(tex, uv).g;
  float b = texture(tex, uv - vec2(amount, 0.0)).b;
  return vec3(r, g, b);
}

// Scanlines
float scanline(vec2 uv, float lines) {
  return 0.5 + 0.5 * sin(uv.y * lines * 3.14159 * 2.0);
}

// Simple Bloom (high-pass filter + blur approximation)
// Note: Real bloom needs multiple passes. This is a single-pass approximation
// by sampling neighbors.
vec3 bloom(sampler2D tex, vec2 uv, float intensity) {
  vec3 color = texture(tex, uv).rgb;
  
  // Simple gaussian-ish blur
  float size = 1.0 / u_resolution.x * 2.0; // blur radius
  vec3 blur = vec3(0.0);
  blur += texture(tex, uv + vec2(-size, -size)).rgb;
  blur += texture(tex, uv + vec2(0.0,   -size)).rgb;
  blur += texture(tex, uv + vec2(size,  -size)).rgb;
  blur += texture(tex, uv + vec2(-size, 0.0)).rgb;
  blur += texture(tex, uv + vec2(size,  0.0)).rgb;
  blur += texture(tex, uv + vec2(-size, size)).rgb;
  blur += texture(tex, uv + vec2(0.0,   size)).rgb;
  blur += texture(tex, uv + vec2(size,  size)).rgb;
  blur /= 8.0;
  
  // Combine
  return color + blur * intensity;
}

// Vignette
float vignette(vec2 uv, float radius, float softness) {
  vec2 position = uv - 0.5;
  float len = length(position);
  float vignette = smoothstep(radius, radius - softness, len);
  return vignette;
}

void main() {
  vec2 uv = v_uv;
  vec3 color = texture(u_texture, uv).rgb;

  // 1. Chromatic Aberration
  if (u_enable_aberration > 0.5) {
    // Distort edges more than center
    float dist = length(uv - 0.5);
    float aberrationAmount = 0.003 * u_intensity * (1.0 + dist);
    color = chromaticAberration(u_texture, uv, aberrationAmount);
  }

  // 2. Bloom
  if (u_enable_bloom > 0.5) {
    color = bloom(u_texture, uv, 0.5 * u_intensity);
  }

  // 3. Scanlines
  if (u_enable_scanlines > 0.5) {
    // Moving scanlines
    float s = scanline(uv + vec2(0.0, u_time * 0.05), u_resolution.y / 4.0);
    // Static fine scanlines
    float s2 = scanline(uv, u_resolution.y / 2.0);
    
    // Combine and attenuate
    float scanlineEffect = mix(1.0, s * s2, 0.1 * u_intensity);
    color *= scanlineEffect;
  }

  // 4. Vignette (always on for CRT feel)
  float v = vignette(uv, 0.8, 0.4);
  color *= v;

  // 5. Noise (film grain)
  float noise = fract(sin(dot(uv + u_time, vec2(12.9898, 78.233))) * 43758.5453);
  color += noise * 0.02 * u_intensity;

  fragColor = vec4(color, 1.0);
}
`;
