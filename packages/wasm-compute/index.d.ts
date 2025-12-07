declare module '@phage/wasm-compute' {
  /**
   * Initialize the WASM module with the compiled binary.
   */
  export default function init(buffer?: ArrayBuffer | Uint8Array): Promise<void>;

  /**
   * Compute Levenshtein distance using the Rust/WASM implementation.
   */
  export function levenshtein_distance(a: string, b: string): number;
}
