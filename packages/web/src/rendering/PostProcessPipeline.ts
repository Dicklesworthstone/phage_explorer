import { VERTEX_SHADER, CRT_FRAGMENT_SHADER } from './shaders';

export interface PostProcessOptions {
  reducedMotion?: boolean;
  enableScanlines?: boolean;
  enableBloom?: boolean;
  enableChromaticAberration?: boolean;
  scanlineIntensity?: number;
  bloomIntensity?: number;
  aberrationOffset?: number;
}

export class PostProcessPipeline {
  private opts: PostProcessOptions;
  private glCanvas: OffscreenCanvas | HTMLCanvasElement | null = null;
  private gl: WebGL2RenderingContext | null = null;
  private program: WebGLProgram | null = null;
  private texture: WebGLTexture | null = null;
  private positionBuffer: WebGLBuffer | null = null;
  private vao: WebGLVertexArrayObject | null = null;
  private uTime = 0;

  constructor(opts: PostProcessOptions = {}) {
    this.opts = {
      reducedMotion: false,
      enableScanlines: true,
      enableBloom: true,
      enableChromaticAberration: true,
      scanlineIntensity: 0.15,
      bloomIntensity: 0.4,
      aberrationOffset: 1.5,
      ...opts,
    };
  }

  updateOptions(opts: PostProcessOptions): void {
    Object.assign(this.opts, opts);
  }

  private initWebGL(): void {
    if (this.gl) return;

    try {
      if (typeof OffscreenCanvas !== 'undefined') {
        this.glCanvas = new OffscreenCanvas(1, 1);
      } else {
        this.glCanvas = document.createElement('canvas');
      }

      this.gl = this.glCanvas.getContext('webgl2', {
        alpha: false,
        desynchronized: true,
        antialias: false
      }) as WebGL2RenderingContext;

      if (!this.gl) {
        throw new Error('WebGL2 not supported');
      }

      // Compile Shaders
      const vert = this.compileShader(this.gl.VERTEX_SHADER, VERTEX_SHADER);
      const frag = this.compileShader(this.gl.FRAGMENT_SHADER, CRT_FRAGMENT_SHADER);
      
      this.program = this.gl.createProgram()!;
      this.gl.attachShader(this.program, vert);
      this.gl.attachShader(this.program, frag);
      this.gl.linkProgram(this.program);

      if (!this.gl.getProgramParameter(this.program, this.gl.LINK_STATUS)) {
        throw new Error('Program link failed: ' + this.gl.getProgramInfoLog(this.program));
      }

      // Setup Geometry (Full-screen quad)
      const positions = new Float32Array([
        -1, -1,
        1, -1,
        -1,  1,
        -1,  1,
        1, -1,
        1,  1,
      ]);

      this.positionBuffer = this.gl.createBuffer();
      this.gl.bindBuffer(this.gl.ARRAY_BUFFER, this.positionBuffer);
      this.gl.bufferData(this.gl.ARRAY_BUFFER, positions, this.gl.STATIC_DRAW);

      this.vao = this.gl.createVertexArray();
      this.gl.bindVertexArray(this.vao);
      
      const positionLoc = this.gl.getAttribLocation(this.program, 'a_position');
      this.gl.enableVertexAttribArray(positionLoc);
      this.gl.vertexAttribPointer(positionLoc, 2, this.gl.FLOAT, false, 0, 0);

      // Create Texture
      this.texture = this.gl.createTexture();
      this.gl.bindTexture(this.gl.TEXTURE_2D, this.texture);
      this.gl.texParameteri(this.gl.TEXTURE_2D, this.gl.TEXTURE_WRAP_S, this.gl.CLAMP_TO_EDGE);
      this.gl.texParameteri(this.gl.TEXTURE_2D, this.gl.TEXTURE_WRAP_T, this.gl.CLAMP_TO_EDGE);
      this.gl.texParameteri(this.gl.TEXTURE_2D, this.gl.TEXTURE_MIN_FILTER, this.gl.LINEAR);
      this.gl.texParameteri(this.gl.TEXTURE_2D, this.gl.TEXTURE_MAG_FILTER, this.gl.LINEAR);

    } catch (e) {
      console.error('Failed to init PostProcessPipeline:', e);
      this.gl = null; // Disable on failure
    }
  }

  private compileShader(type: number, source: string): WebGLShader {
    const shader = this.gl!.createShader(type)!;
    this.gl!.shaderSource(shader, source);
    this.gl!.compileShader(shader);
    if (!this.gl!.getShaderParameter(shader, this.gl!.COMPILE_STATUS)) {
      const log = this.gl!.getShaderInfoLog(shader);
      this.gl!.deleteShader(shader);
      throw new Error('Shader compile failed: ' + log);
    }
    return shader;
  }

  /**
   * Process the source image and render to the destination canvas.
   * 
   * @param source The source image (can be OffscreenCanvas, ImageBitmap, etc.)
   * @param destination The destination canvas to render the final result to
   * @returns boolean True if processing occurred, false if skipped (e.g. reduced motion)
   */
  process(source: TexImageSource, destination: HTMLCanvasElement): boolean {
    if (this.opts.reducedMotion || (!this.opts.enableScanlines && !this.opts.enableChromaticAberration && !this.opts.enableBloom)) {
      return false;
    }

    this.initWebGL();
    if (!this.gl || !this.program || !this.glCanvas) return false;

    const width = destination.width;
    const height = destination.height;

    // Resize WebGL canvas if needed
    if (this.glCanvas.width !== width || this.glCanvas.height !== height) {
      this.glCanvas.width = width;
      this.glCanvas.height = height;
      this.gl.viewport(0, 0, width, height);
    }

    // Upload texture
    this.gl.bindTexture(this.gl.TEXTURE_2D, this.texture);
    this.gl.texImage2D(this.gl.TEXTURE_2D, 0, this.gl.RGBA, this.gl.RGBA, this.gl.UNSIGNED_BYTE, source);

    // Draw
    this.gl.useProgram(this.program);
    this.gl.bindVertexArray(this.vao);

    // Uniforms
    this.gl.uniform2f(this.gl.getUniformLocation(this.program, 'u_resolution'), width, height);
    this.gl.uniform1f(this.gl.getUniformLocation(this.program, 'u_time'), this.uTime);
    this.gl.uniform1f(this.gl.getUniformLocation(this.program, 'u_scanlineIntensity'), this.opts.enableScanlines ? (this.opts.scanlineIntensity ?? 0.15) : 0.0);
    this.gl.uniform1f(this.gl.getUniformLocation(this.program, 'u_aberrationOffset'), this.opts.enableChromaticAberration ? (this.opts.aberrationOffset ?? 1.5) : 0.0);
    this.gl.uniform1f(this.gl.getUniformLocation(this.program, 'u_bloomIntensity'), this.opts.enableBloom ? (this.opts.bloomIntensity ?? 0.4) : 0.0);

    this.gl.drawArrays(this.gl.TRIANGLES, 0, 6);

    // Copy back to destination 2D canvas
    const ctx = destination.getContext('2d');
    if (ctx) {
      ctx.globalCompositeOperation = 'copy';
      // Cast to CanvasImageSource because OffscreenCanvas types can be tricky
      ctx.drawImage(this.glCanvas as unknown as CanvasImageSource, 0, 0);
      ctx.globalCompositeOperation = 'source-over';
    }

    this.uTime += 0.01;
    return true;
  }
}

export default PostProcessPipeline;
