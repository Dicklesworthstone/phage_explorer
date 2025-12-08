/**
 * PostProcessPipeline
 *
 * Placeholder WebGL2-friendly pipeline for scanlines/bloom/aberration effects.
 * Currently a no-op pass that simply exposes a consistent interface so we can
 * wire effect toggles and reduced-motion handling without breaking 2D rendering.
 * Future work: allocate FBOs, upload canvas as texture, run fragment shaders.
 */

export interface PostProcessOptions {
  reducedMotion?: boolean;
  enableScanlines?: boolean;
  enableBloom?: boolean;
  enableChromaticAberration?: boolean;
}

export class PostProcessPipeline {
  private readonly opts: PostProcessOptions;

  constructor(opts: PostProcessOptions = {}) {
    this.opts = opts;
  }

  updateOptions(opts: PostProcessOptions): void {
    Object.assign(this.opts, opts);
  }

  /**
   * Process a rendered 2D canvas. Currently a no-op to keep compatibility;
   * intended to become a WebGL2 pass that composites effects into the target.
   */
  process(source: HTMLCanvasElement): void {
    // Reduced-motion short-circuit
    if (this.opts.reducedMotion) return;

    // No-op placeholder for now. Future: copy to WebGL texture and run shader chain.
    void source;
  }
}

export default PostProcessPipeline;

