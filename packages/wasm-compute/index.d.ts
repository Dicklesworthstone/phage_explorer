/**
 * Type declarations for @phage/wasm-compute.
 *
 * Re-exports the generated wasm-bindgen declaration surface directly from
 * `./pkg/wasm_compute.d.ts` and `./pkg-simd/wasm_compute.d.ts` to prevent
 * drift between the built artifacts and TypeScript declarations.
 *
 * @see phage_explorer-zzqa
 */

export * from './pkg/wasm_compute';
import init from './pkg/wasm_compute';
export default init;

declare module '@phage/wasm-compute' {
  export * from './pkg/wasm_compute';
  import init from './pkg/wasm_compute';
  export default init;
}

declare module '@phage/wasm-compute/simd' {
  export * from './pkg-simd/wasm_compute';
  import init from './pkg-simd/wasm_compute';
  export default init;
}
