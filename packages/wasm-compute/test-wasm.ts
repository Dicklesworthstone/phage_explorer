import init, { levenshtein_distance, analyze_kmers, render_ascii_model, Model3D, min_hash_jaccard } from './pkg/wasm_compute.js';
import { file } from 'bun';
import path from 'path';

// Calculate the absolute path to the wasm file
const wasmPath = path.resolve(import.meta.dir, 'pkg/wasm_compute_bg.wasm');

console.log(`Loading Wasm from: ${wasmPath}`);

const wasmBuffer = await file(wasmPath).arrayBuffer();
await init(wasmBuffer);

console.log("Wasm initialized!");

// Test Levenshtein
const s1 = "kitten";
const s2 = "sitting";
const dist = levenshtein_distance(s1, s2);
console.log(`Levenshtein distance between '${s1}' and '${s2}' is: ${dist}`);

if (dist !== 3) {
    console.error(`FAILURE: Expected 3, got ${dist}`);
    process.exit(1);
}

// Test K-mer Analysis
const seqA = "ATGCATGC";
const seqB = "ATGCATGG"; // Last char different
const k = 3;

const result = analyze_kmers(seqA, seqB, k);

console.log("K-mer Analysis Result:");
console.log(`Jaccard Index: ${result.jaccard_index}`);

if (Math.abs(result.jaccard_index - 0.8) < 0.0001) {
    console.log("SUCCESS: K-mer analysis calculation is correct.");
} else {
    console.error(`FAILURE: Expected Jaccard 0.8, got ${result.jaccard_index}`);
    result.free(); 
    process.exit(1);
}

result.free();

// Test MinHash
console.log("Testing MinHash...");
const minHashScore = min_hash_jaccard(seqA, seqB, k, 100);
console.log(`MinHash Score: ${minHashScore}`);
if (minHashScore >= 0 && minHashScore <= 1) {
    console.log("SUCCESS: MinHash returned a valid probability.");
}

// Test 3D Renderer
// Simple Tetrahedron
// Vertices (x, y, z)
const vertices = new Float64Array([
    1.0, 1.0, 1.0,
    -1.0, -1.0, 1.0,
    -1.0, 1.0, -1.0,
    1.0, -1.0, -1.0
]);

// Edges (indices)
const edges = new Uint32Array([
    0, 1, 0, 2, 0, 3,
    1, 2, 1, 3,
    2, 3
]);

const model = new Model3D(vertices, edges);
console.log("Model created.");

const render = render_ascii_model(model, 0.5, 0.5, 0, 40, 20, "medium");

console.log("Rendered Frame:");
console.log(render);

if (render.length > 0) {
    console.log("SUCCESS: 3D Renderer produced output.");
} else {
    console.error("FAILURE: 3D Renderer produced empty output.");
    model.free();
    process.exit(1);
}

model.free();