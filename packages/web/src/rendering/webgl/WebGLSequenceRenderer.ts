/**
 * WebGLSequenceRenderer - GPU-Accelerated Sequence Renderer
 *
 * Renders genome sequences using WebGL with IDENTICAL visual output to Canvas 2D.
 * Uses the same GlyphAtlas as the Canvas renderer to ensure pixel-perfect matching.
 *
 * Performance benefits:
 * - Instanced rendering: 100K+ cells in a single draw call
 * - GPU texture: Sequence data on GPU, no CPU transfer during scroll
 * - Uniform-based scroll: No geometry updates during scroll
 */

import type { Theme, ViewMode, ReadingFrame } from '@phage-explorer/core';
import { VirtualScroller, type VisibleRange } from '../VirtualScroller';
import { GlyphAtlas } from '../GlyphAtlas';
import { createSequenceProgram, createSequenceProgramWebGL1 } from './shaders';
import {
  createSequenceTexture,
  disposeSequenceTexture,
  type SequenceTextureData,
} from './SequenceTexture';

export type { VisibleRange };

export interface WebGLRendererOptions {
  canvas: HTMLCanvasElement;
  theme: Theme;
  cellWidth?: number;
  cellHeight?: number;
  viewportWidth?: number;
  viewportHeight?: number;
  devicePixelRatio?: number;
  zoomScale?: number;
  enablePinchZoom?: boolean;
  snapToCodon?: boolean;
  onZoomChange?: (scale: number) => void;
  onVisibleRangeChange?: (range: VisibleRange) => void;
}

export interface WebGLRenderState {
  sequence: string;
  aminoSequence: string | null;
  viewMode: ViewMode;
  readingFrame: ReadingFrame;
  diffSequence: string | null;
  diffEnabled: boolean;
  diffMask: Uint8Array | null;
}

// WebGL capability detection
export function detectWebGLSupport(): {
  webgl2: boolean;
  webgl1: boolean;
  maxTextureSize: number;
  maxInstances: number;
} {
  const result = {
    webgl2: false,
    webgl1: false,
    maxTextureSize: 0,
    maxInstances: 0,
  };

  try {
    const testCanvas = document.createElement('canvas');
    const gl2 = testCanvas.getContext('webgl2');
    if (gl2) {
      result.webgl2 = true;
      result.maxTextureSize = gl2.getParameter(gl2.MAX_TEXTURE_SIZE);
      result.maxInstances = 1000000;
      const loseContext = gl2.getExtension('WEBGL_lose_context');
      loseContext?.loseContext();
    }
  } catch {
    // WebGL 2 not available
  }

  if (!result.webgl2) {
    try {
      const testCanvas = document.createElement('canvas');
      const gl1 = testCanvas.getContext('webgl');
      if (gl1) {
        result.webgl1 = true;
        result.maxTextureSize = gl1.getParameter(gl1.MAX_TEXTURE_SIZE);
        const ext = gl1.getExtension('ANGLE_instanced_arrays');
        result.maxInstances = ext ? 65536 : 0;
        const loseContext = gl1.getExtension('WEBGL_lose_context');
        loseContext?.loseContext();
      }
    } catch {
      // WebGL 1 not available
    }
  }

  return result;
}

/**
 * Main WebGL Sequence Renderer
 */
export class WebGLSequenceRenderer {
  private canvas: HTMLCanvasElement;
  private gl: WebGL2RenderingContext | WebGLRenderingContext | null = null;
  private isWebGL2: boolean = false;
  private theme: Theme;

  // Shader program
  private program: WebGLProgram | null = null;
  private locations: Record<string, number | WebGLUniformLocation | null> = {};

  // Geometry buffers
  private quadVAO: WebGLVertexArrayObject | null = null;
  private quadBuffer: WebGLBuffer | null = null;
  private instanceBuffer: WebGLBuffer | null = null;

  // Textures - using GlyphAtlas (same as Canvas renderer)
  private glyphAtlas: GlyphAtlas | null = null;
  private glyphAtlasTexture: WebGLTexture | null = null;
  private atlasSize: { cols: number; rows: number } = { cols: 8, rows: 4 };
  private sequenceTexture: SequenceTextureData | null = null;

  // Virtual scroller for visible range calculation
  private scroller: VirtualScroller;

  // Rendering state
  private currentState: WebGLRenderState | null = null;
  private cellWidth: number;
  private cellHeight: number;
  private zoomScale: number = 1.0;
  private dpr: number;
  private viewportWidth: number;
  private viewportHeight: number;

  // Animation
  private animationFrameId: number | null = null;
  private isRendering = false;
  private needsRedraw = true;
  private paused = false;
  private contextLost = false;
  private readonly onContextLost = (event: Event): void => {
    // Without preventDefault(), Safari never restores the context and the canvas stays black.
    event.preventDefault();
    this.contextLost = true;
    if (this.animationFrameId !== null) {
      cancelAnimationFrame(this.animationFrameId);
      this.animationFrameId = null;
    }
  };
  private readonly onContextRestored = (): void => {
    this.contextLost = false;
    this.paused = false;
    this.rebuildGpuResources();
    this.needsRedraw = true;
    this.scheduleRender();
  };

  // Scroll state
  private isScrolling = false;
  private scrollEndTimer: ReturnType<typeof setTimeout> | null = null;

  // Callbacks
  private onZoomChange?: (scale: number) => void;
  private onVisibleRangeChange?: (range: VisibleRange) => void;

  // Pinch zoom state
  private isPinching = false;
  private pinchStartDistance = 0;
  private pinchStartScale = 1.0;
  private enablePinchZoom: boolean;
  private snapToCodon: boolean;

  // Instance buffer size
  private maxInstances = 100000;
  private instanceIndices: Float32Array | null = null;

  private getRowHeight(viewMode: ViewMode): number {
    return viewMode === 'dual' ? this.cellHeight * 2 : this.cellHeight;
  }

  constructor(options: WebGLRendererOptions) {
    this.canvas = options.canvas;
    this.theme = options.theme;
    this.cellWidth = options.cellWidth ?? 12;
    this.cellHeight = options.cellHeight ?? 14;
    this.zoomScale = options.zoomScale ?? 1.0;
    this.dpr = options.devicePixelRatio ?? window.devicePixelRatio;
    this.viewportWidth = options.viewportWidth ?? this.canvas.clientWidth;
    this.viewportHeight = options.viewportHeight ?? this.canvas.clientHeight;
    this.enablePinchZoom = options.enablePinchZoom ?? true;
    this.snapToCodon = options.snapToCodon ?? false;
    this.onZoomChange = options.onZoomChange;
    this.onVisibleRangeChange = options.onVisibleRangeChange;

    if (!this.initWebGL()) {
      throw new Error('WebGL not available');
    }

    this.scroller = new VirtualScroller({
      totalItems: 0,
      itemWidth: this.cellWidth,
      itemHeight: this.cellHeight,
      viewportWidth: this.viewportWidth,
      viewportHeight: this.viewportHeight,
      overscan: 50,
    });

    this.scroller.onScroll((range) => {
      this.isScrolling = true;
      if (this.scrollEndTimer) {
        clearTimeout(this.scrollEndTimer);
      }
      this.scrollEndTimer = setTimeout(() => {
        this.scrollEndTimer = null;
        this.isScrolling = false;
        this.scheduleRender();
      }, 400);

      this.onVisibleRangeChange?.(range);
      this.scheduleRender();
    });

    this.initShaders();
    this.initBuffers();
    this.initGlyphAtlas();
    this.resize(this.viewportWidth, this.viewportHeight);
    this.bindContextLossHandlers();
  }

  private bindContextLossHandlers(): void {
    this.canvas.addEventListener('webglcontextlost', this.onContextLost, false);
    this.canvas.addEventListener('webglcontextrestored', this.onContextRestored, false);
  }

  private rebuildGpuResources(): void {
    const gl = this.gl;
    if (!gl || this.contextLost) return;

    this.program = null;
    this.locations = {};
    this.quadVAO = null;
    this.quadBuffer = null;
    this.instanceBuffer = null;
    this.glyphAtlasTexture = null;
    this.sequenceTexture = null;

    this.initShaders();
    this.initBuffers();
    if (this.glyphAtlas) {
      this.uploadAtlasTexture();
    } else {
      this.initGlyphAtlas();
    }

    if (this.currentState?.sequence) {
      this.sequenceTexture = createSequenceTexture(gl, this.currentState.sequence, {
        readingFrame: this.currentState.readingFrame,
        diffMask: this.currentState.diffMask,
      });
    }

    gl.viewport(0, 0, this.canvas.width, this.canvas.height);
    this.clearToBackground();
  }

  private clearToBackground(): void {
    const gl = this.gl;
    if (!gl || this.contextLost) return;
    const bgColor = this.hexToRgb(this.theme.colors.background);
    gl.clearColor(bgColor.r, bgColor.g, bgColor.b, 1.0);
    gl.clear(gl.COLOR_BUFFER_BIT);
  }

  private initWebGL(): boolean {
    try {
      const gl2 = this.canvas.getContext('webgl2', {
        alpha: false,
        antialias: false,
        depth: false,
        stencil: false,
        powerPreference: 'high-performance',
        preserveDrawingBuffer: true,
      }) as WebGL2RenderingContext | null;

      if (gl2) {
        this.gl = gl2;
        this.isWebGL2 = true;
        return true;
      }
    } catch {
      // WebGL 2 not available
    }

    try {
      const gl1 = this.canvas.getContext('webgl', {
        alpha: false,
        antialias: false,
        depth: false,
        stencil: false,
        powerPreference: 'high-performance',
        preserveDrawingBuffer: true,
      }) as WebGLRenderingContext | null;

      if (gl1) {
        const instanceExt = gl1.getExtension('ANGLE_instanced_arrays');
        if (!instanceExt) {
          console.warn('ANGLE_instanced_arrays not available');
          return false;
        }
        this.gl = gl1;
        this.isWebGL2 = false;
        return true;
      }
    } catch {
      // WebGL 1 not available
    }

    return false;
  }

  private initShaders(): void {
    const gl = this.gl;
    if (!gl) return;

    try {
      if (this.isWebGL2) {
        const { program, locations } = createSequenceProgram(gl as WebGL2RenderingContext);
        this.program = program;
        this.locations = locations;
      } else {
        const { program, locations } = createSequenceProgramWebGL1(gl as WebGLRenderingContext);
        this.program = program;
        this.locations = locations;
      }
    } catch (error) {
      console.error('Failed to initialize shaders:', error);
      throw error;
    }
  }

  private initBuffers(): void {
    const gl = this.gl;
    if (!gl) return;

    // Unit quad vertices
    const quadVertices = new Float32Array([
      0, 0, 0, 0,
      1, 0, 1, 0,
      0, 1, 0, 1,
      1, 1, 1, 1,
    ]);

    this.quadBuffer = gl.createBuffer();
    gl.bindBuffer(gl.ARRAY_BUFFER, this.quadBuffer);
    gl.bufferData(gl.ARRAY_BUFFER, quadVertices, gl.STATIC_DRAW);

    this.instanceIndices = new Float32Array(this.maxInstances);
    for (let i = 0; i < this.maxInstances; i++) {
      this.instanceIndices[i] = i;
    }

    this.instanceBuffer = gl.createBuffer();
    gl.bindBuffer(gl.ARRAY_BUFFER, this.instanceBuffer);
    gl.bufferData(gl.ARRAY_BUFFER, this.instanceIndices, gl.DYNAMIC_DRAW);

    if (this.isWebGL2) {
      const gl2 = gl as WebGL2RenderingContext;
      this.quadVAO = gl2.createVertexArray();
      gl2.bindVertexArray(this.quadVAO);
      this.setupVertexAttributes();
      gl2.bindVertexArray(null);
    }
  }

  private setupVertexAttributes(): void {
    const gl = this.gl;
    if (!gl || !this.program) return;

    const positionLoc = this.locations.a_position as number;
    const texCoordLoc = this.locations.a_texCoord as number;
    const instanceLoc = this.locations.a_instanceIndex as number;

    gl.bindBuffer(gl.ARRAY_BUFFER, this.quadBuffer);

    gl.enableVertexAttribArray(positionLoc);
    gl.vertexAttribPointer(positionLoc, 2, gl.FLOAT, false, 16, 0);

    gl.enableVertexAttribArray(texCoordLoc);
    gl.vertexAttribPointer(texCoordLoc, 2, gl.FLOAT, false, 16, 8);

    gl.bindBuffer(gl.ARRAY_BUFFER, this.instanceBuffer);
    gl.enableVertexAttribArray(instanceLoc);
    gl.vertexAttribPointer(instanceLoc, 1, gl.FLOAT, false, 0, 0);

    if (this.isWebGL2) {
      (gl as WebGL2RenderingContext).vertexAttribDivisor(instanceLoc, 1);
    } else {
      const ext = gl.getExtension('ANGLE_instanced_arrays');
      ext?.vertexAttribDivisorANGLE(instanceLoc, 1);
    }
  }

  /**
   * Initialize glyph atlas - uses the SAME GlyphAtlas class as Canvas renderer
   * This ensures pixel-perfect identical rendering
   */
  private initGlyphAtlas(): void {
    const gl = this.gl;
    if (!gl) return;

    // Create GlyphAtlas with current cell size (same as Canvas renderer)
    this.glyphAtlas = new GlyphAtlas(this.theme, {
      cellWidth: this.cellWidth,
      cellHeight: this.cellHeight,
      devicePixelRatio: this.dpr,
    });

    // Upload the atlas canvas to GPU as a texture
    this.uploadAtlasTexture();
  }

  /**
   * Upload the GlyphAtlas canvas to WebGL texture
   */
  private uploadAtlasTexture(): void {
    const gl = this.gl;
    if (!gl || !this.glyphAtlas) return;

    // Delete old texture if exists
    if (this.glyphAtlasTexture) {
      gl.deleteTexture(this.glyphAtlasTexture);
    }

    this.glyphAtlasTexture = gl.createTexture();
    if (!this.glyphAtlasTexture) return;

    const atlasCanvas = this.glyphAtlas.getCanvas();

    gl.bindTexture(gl.TEXTURE_2D, this.glyphAtlasTexture);

    // Upload atlas canvas to GPU
    gl.texImage2D(
      gl.TEXTURE_2D,
      0,
      gl.RGBA,
      gl.RGBA,
      gl.UNSIGNED_BYTE,
      atlasCanvas as TexImageSource
    );

    // Use NEAREST filtering to match Canvas drawImage exactly (no interpolation)
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.NEAREST);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.NEAREST);

    gl.bindTexture(gl.TEXTURE_2D, null);

    // Calculate atlas grid size (8 columns, rows based on total glyphs)
    // Nucleotides: 5 (A,C,G,T,N) + Amino acids: 22 = 27 total
    const totalGlyphs = 5 + 22;
    this.atlasSize = {
      cols: 8,
      rows: Math.ceil(totalGlyphs / 8),
    };
  }

  resize(width: number, height: number): void {
    this.viewportWidth = width;
    this.viewportHeight = height;

    // Never smash the drawing buffer to 0×0 — Safari URL-bar resizes can
    // momentarily report 0 and a 0×0 buffer stays black until the next valid size.
    if (!(width > 0) || !(height > 0)) {
      this.needsRedraw = true;
      return;
    }

    const pixelWidth = Math.max(1, Math.round(width * this.dpr));
    const pixelHeight = Math.max(1, Math.round(height * this.dpr));

    this.canvas.width = pixelWidth;
    this.canvas.height = pixelHeight;

    if (this.gl && !this.contextLost) {
      this.gl.viewport(0, 0, pixelWidth, pixelHeight);
      // Setting canvas.width clears the buffer to opaque black (alpha:false).
      // Fill immediately so iOS URL-bar resizes don't flash black while rAF is delayed.
      this.clearToBackground();
    }

    const viewMode = this.currentState?.viewMode ?? 'dna';
    this.scroller.updateOptions({
      viewportWidth: width,
      viewportHeight: height,
      itemWidth: this.cellWidth,
      itemHeight: this.getRowHeight(viewMode),
    });

    this.needsRedraw = true;
    this.scheduleRender();
  }

  setState(state: Partial<WebGLRenderState>): void {
    const gl = this.gl;
    if (!gl) return;

    const prevState = this.currentState;
    this.currentState = { ...this.currentState, ...state } as WebGLRenderState;

    if (state.viewMode !== undefined && state.viewMode !== prevState?.viewMode) {
      this.scroller.updateOptions({
        itemHeight: this.getRowHeight(state.viewMode),
      });
    }

    if (state.sequence !== undefined && state.sequence !== prevState?.sequence) {
      if (this.sequenceTexture) {
        disposeSequenceTexture(gl, this.sequenceTexture);
      }

      this.sequenceTexture = createSequenceTexture(gl as WebGL2RenderingContext, state.sequence, {
        readingFrame: this.currentState.readingFrame,
        diffMask: this.currentState.diffMask,
      });

      this.scroller.updateOptions({
        totalItems: state.sequence.length,
      });
    }

    this.needsRedraw = true;
    this.scheduleRender();
  }

  private scheduleRender(): void {
    if (this.animationFrameId !== null || this.paused || this.contextLost) return;

    this.animationFrameId = requestAnimationFrame(() => {
      this.animationFrameId = null;
      if (!this.paused && !this.contextLost) {
        this.render();
      }
    });
  }

  private render(): void {
    const gl = this.gl;
    if (!gl || !this.program || this.isRendering || this.paused || this.contextLost) return;

    this.isRendering = true;

    try {
      // Clear with background color
      const bgColor = this.hexToRgb(this.theme.colors.background);
      gl.clearColor(bgColor.r, bgColor.g, bgColor.b, 1.0);
      gl.clear(gl.COLOR_BUFFER_BIT);

      if (!this.currentState?.sequence || !this.sequenceTexture || !this.glyphAtlasTexture) {
        this.isRendering = false;
        return;
      }

      gl.useProgram(this.program);

      const range = this.scroller.getRenderRange();
      const cols = this.scroller.getLayout().cols;
      const { scrollX, scrollY } = this.scroller.getScrollState();

      const startCell = range.startRow * cols;
      const endCell = Math.min(range.endRow * cols, this.currentState.sequence.length);
      const instanceCount = Math.min(endCell - startCell, this.maxInstances);

      if (instanceCount <= 0) {
        this.isRendering = false;
        return;
      }

      // Set uniforms
      gl.uniform2f(this.locations.u_resolution as WebGLUniformLocation, this.viewportWidth, this.viewportHeight);
      gl.uniform2f(this.locations.u_cellSize as WebGLUniformLocation, this.cellWidth, this.cellHeight);
      gl.uniform2f(this.locations.u_scrollOffset as WebGLUniformLocation, scrollX, scrollY);
      gl.uniform1f(this.locations.u_cols as WebGLUniformLocation, cols);
      gl.uniform1f(this.locations.u_totalCells as WebGLUniformLocation, this.currentState.sequence.length);
      gl.uniform1f(this.locations.u_startIndex as WebGLUniformLocation, startCell);
      gl.uniform2f(this.locations.u_sequenceSize as WebGLUniformLocation, this.sequenceTexture.width, this.sequenceTexture.height);
      gl.uniform1f(this.locations.u_viewMode as WebGLUniformLocation, this.currentState.viewMode === 'dual' ? 1.0 : 0.0);

      // Atlas size uniforms
      gl.uniform2f(this.locations.u_atlasSize as WebGLUniformLocation, this.atlasSize.cols, this.atlasSize.rows);
      if (this.locations.u_nucleotideCount) {
        gl.uniform1f(this.locations.u_nucleotideCount as WebGLUniformLocation, 5.0);
      }

      // Bind sequence data texture
      gl.activeTexture(gl.TEXTURE0);
      gl.bindTexture(gl.TEXTURE_2D, this.sequenceTexture.texture);
      gl.uniform1i(this.locations.u_sequenceData as WebGLUniformLocation, 0);

      // Bind glyph atlas texture
      gl.activeTexture(gl.TEXTURE1);
      gl.bindTexture(gl.TEXTURE_2D, this.glyphAtlasTexture);
      gl.uniform1i(this.locations.u_glyphAtlas as WebGLUniformLocation, 1);

      // Bind VAO or set up attributes
      if (this.isWebGL2 && this.quadVAO) {
        (gl as WebGL2RenderingContext).bindVertexArray(this.quadVAO);
      } else {
        this.setupVertexAttributes();
      }

      // Draw instanced quads
      if (this.isWebGL2) {
        (gl as WebGL2RenderingContext).drawArraysInstanced(gl.TRIANGLE_STRIP, 0, 4, instanceCount);
      } else {
        const ext = gl.getExtension('ANGLE_instanced_arrays');
        ext?.drawArraysInstancedANGLE(gl.TRIANGLE_STRIP, 0, 4, instanceCount);
      }

      if (this.isWebGL2 && this.quadVAO) {
        (gl as WebGL2RenderingContext).bindVertexArray(null);
      }
    } finally {
      this.isRendering = false;
      this.needsRedraw = false;
    }
  }

  private hexToRgb(hex: string): { r: number; g: number; b: number } {
    const result = /^#?([a-f\d]{2})([a-f\d]{2})([a-f\d]{2})$/i.exec(hex);
    if (!result) return { r: 0, g: 0, b: 0 };
    return {
      r: parseInt(result[1], 16) / 255,
      g: parseInt(result[2], 16) / 255,
      b: parseInt(result[3], 16) / 255,
    };
  }

  // ========== Public API ==========

  setTheme(theme: Theme): void {
    this.theme = theme;

    // Recreate glyph atlas with new theme (same as Canvas renderer does)
    if (this.glyphAtlas) {
      this.glyphAtlas.dispose();
    }
    this.glyphAtlas = new GlyphAtlas(theme, {
      cellWidth: this.cellWidth,
      cellHeight: this.cellHeight,
      devicePixelRatio: this.dpr,
    });
    this.uploadAtlasTexture();

    this.needsRedraw = true;
    this.scheduleRender();
  }

  setZoomScale(scale: number): void {
    this.zoomScale = Math.max(0.1, Math.min(4.0, scale));

    const baseWidth = 12;
    const baseHeight = 14;
    this.cellWidth = Math.round(baseWidth * this.zoomScale);
    this.cellHeight = Math.round(baseHeight * this.zoomScale);

    // Recreate glyph atlas at new size
    if (this.glyphAtlas) {
      this.glyphAtlas.dispose();
    }
    this.glyphAtlas = new GlyphAtlas(this.theme, {
      cellWidth: this.cellWidth,
      cellHeight: this.cellHeight,
      devicePixelRatio: this.dpr,
    });
    this.uploadAtlasTexture();

    const viewMode = this.currentState?.viewMode ?? 'dna';
    this.scroller.updateOptions({
      itemWidth: this.cellWidth,
      itemHeight: this.getRowHeight(viewMode),
    });

    this.onZoomChange?.(this.zoomScale);
    this.onVisibleRangeChange?.(this.scroller.getVisibleRange());

    this.needsRedraw = true;
    this.scheduleRender();
  }

  getZoomScale(): number {
    return this.zoomScale;
  }

  zoomIn(factor = 1.3): void {
    this.setZoomScale(this.zoomScale * factor);
  }

  zoomOut(factor = 1.3): void {
    this.setZoomScale(this.zoomScale / factor);
  }

  setZoomLevel(level: 'genome' | 'micro' | 'region' | 'codon' | 'base'): void {
    const ZOOM_LEVEL_SCALES: Record<string, number> = {
      genome: 0.1,
      region: 0.4,
      micro: 0.75,
      codon: 1.0,
      base: 1.5,
    };
    this.setZoomScale(ZOOM_LEVEL_SCALES[level] ?? 1.0);
  }

  handleWheel(event: WheelEvent): void {
    this.scroller.handleWheel(event);
  }

  handleWheelDelta(deltaX: number, deltaY: number, deltaMode: 0 | 1 | 2 = 0): void {
    this.scroller.handleWheelDelta(deltaX, deltaY, deltaMode);
  }

  handleTouchStart(event: TouchEvent): void {
    if (event.touches.length === 2 && this.enablePinchZoom) {
      this.handlePinchStart(event);
      return;
    }
    if (event.touches.length === 1) {
      this.scroller.handleTouchStart(event);
    }
  }

  handleTouchMove(event: TouchEvent): void {
    if (event.touches.length === 2 && this.isPinching) {
      this.handlePinchMove(event);
      return;
    }
    if (event.touches.length === 1) {
      this.scroller.handleTouchMove(event);
    }
  }

  handleTouchEnd(_event?: TouchEvent): void {
    if (this.isPinching) {
      this.handlePinchEnd();
      return;
    }
    this.scroller.handleTouchEnd();
  }

  private handlePinchStart(event: TouchEvent): void {
    if (event.touches.length !== 2) return;
    this.isPinching = true;
    this.pinchStartScale = this.zoomScale;
    const dx = event.touches[0].clientX - event.touches[1].clientX;
    const dy = event.touches[0].clientY - event.touches[1].clientY;
    this.pinchStartDistance = Math.sqrt(dx * dx + dy * dy);
    this.scroller.stopMomentum();
  }

  private handlePinchMove(event: TouchEvent): void {
    if (!this.isPinching || event.touches.length !== 2) return;
    const dx = event.touches[0].clientX - event.touches[1].clientX;
    const dy = event.touches[0].clientY - event.touches[1].clientY;
    const distance = Math.sqrt(dx * dx + dy * dy);
    const scale = this.pinchStartScale * (distance / this.pinchStartDistance);
    this.setZoomScale(scale);
  }

  private handlePinchEnd(): void {
    this.isPinching = false;
  }

  scrollToPosition(position: number, center = true): void {
    this.scroller.scrollToIndex(position, center);
  }

  scrollToStart(): void {
    this.scroller.scrollToStart();
  }

  scrollToEnd(): void {
    this.scroller.scrollToEnd();
  }

  getVisibleRange(): VisibleRange {
    return this.scroller.getVisibleRange();
  }

  getScrollPosition(): number {
    const state = this.scroller.getScrollState();
    const layout = this.scroller.getLayout();
    const viewMode = this.currentState?.viewMode ?? 'dna';
    const rowHeight = Math.max(1, this.getRowHeight(viewMode));
    const row = Math.floor(state.scrollY / rowHeight);
    return row * layout.cols;
  }

  getLayout(): { cols: number; rows: number; totalHeight: number; totalWidth: number } {
    const layout = this.scroller.getLayout();
    return {
      cols: layout.cols,
      rows: layout.rows,
      totalHeight: layout.totalHeight,
      totalWidth: layout.totalWidth,
    };
  }

  getCellMetrics(): { cellWidth: number; cellHeight: number; rowHeight: number } {
    const rowHeight = this.currentState?.viewMode === 'dual' ? this.cellHeight * 2 : this.cellHeight;
    return { cellWidth: this.cellWidth, cellHeight: this.cellHeight, rowHeight };
  }

  getIndexAtPoint(x: number, y: number): number | null {
    return this.scroller.getIndexAtPoint(x, y);
  }

  pause(): void {
    this.paused = true;
    if (this.animationFrameId !== null) {
      cancelAnimationFrame(this.animationFrameId);
      this.animationFrameId = null;
    }
  }

  resume(): void {
    this.paused = false;
    this.needsRedraw = true;
    this.scheduleRender();
  }

  isPaused(): boolean {
    return this.paused;
  }

  markDirty(): void {
    this.needsRedraw = true;
    this.scheduleRender();
  }

  setDiffMode(refSequence: string | null, enabled: boolean, diffMask?: Uint8Array | null): void {
    this.setState({
      diffSequence: refSequence,
      diffEnabled: enabled,
      diffMask: diffMask ?? null,
    });
  }

  setSnapToCodon(enabled: boolean): void {
    this.snapToCodon = enabled;
    this.scroller.updateOptions({
      snapToMultiple: enabled ? 3 : null,
    });
  }

  dispose(): void {
    this.canvas.removeEventListener('webglcontextlost', this.onContextLost);
    this.canvas.removeEventListener('webglcontextrestored', this.onContextRestored);

    if (this.animationFrameId !== null) {
      cancelAnimationFrame(this.animationFrameId);
      this.animationFrameId = null;
    }

    if (this.scrollEndTimer) {
      clearTimeout(this.scrollEndTimer);
      this.scrollEndTimer = null;
    }

    const gl = this.gl;
    if (!gl) return;

    if (this.glyphAtlas) {
      this.glyphAtlas.dispose();
      this.glyphAtlas = null;
    }

    if (this.glyphAtlasTexture) {
      gl.deleteTexture(this.glyphAtlasTexture);
      this.glyphAtlasTexture = null;
    }

    if (this.sequenceTexture) {
      disposeSequenceTexture(gl, this.sequenceTexture);
      this.sequenceTexture = null;
    }

    if (this.quadBuffer) {
      gl.deleteBuffer(this.quadBuffer);
      this.quadBuffer = null;
    }

    if (this.instanceBuffer) {
      gl.deleteBuffer(this.instanceBuffer);
      this.instanceBuffer = null;
    }

    if (this.isWebGL2 && this.quadVAO) {
      (gl as WebGL2RenderingContext).deleteVertexArray(this.quadVAO);
      this.quadVAO = null;
    }

    if (this.program) {
      gl.deleteProgram(this.program);
      this.program = null;
    }

    this.scroller.dispose();

    const loseContext = gl.getExtension('WEBGL_lose_context');
    loseContext?.loseContext();

    this.gl = null;
  }
}

export default WebGLSequenceRenderer;
