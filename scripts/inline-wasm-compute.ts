#!/usr/bin/env bun
import { readFileSync, writeFileSync } from "fs";
import { join } from "path";

const pkgDir = join(import.meta.dir, "../packages/wasm-compute/pkg");
const jsPath = join(pkgDir, "wasm_compute.js");
const wasmPath = join(pkgDir, "wasm_compute_bg.wasm");

console.log("Inlining wasm-compute Wasm into JS...");

try {
  const wasmBuffer = readFileSync(wasmPath);
  const wasmBase64 = wasmBuffer.toString("base64");
  let jsContent = readFileSync(jsPath, "utf-8");

  const inject = `// Inlined Wasm bytes
const wasmBase64 = "${wasmBase64}";
const wasmBytes = Uint8Array.from(Buffer.from(wasmBase64, "base64"));
`;

  // Pattern for NodeJS target output
  const nodeFsPattern = /const wasmPath = .*?;[\s\S]*?const wasmBytes = require\('fs'\)\.readFileSync\(wasmPath\);/;
  
  if (nodeFsPattern.test(jsContent)) {
    jsContent = jsContent.replace(nodeFsPattern, inject);
  } else if (!jsContent.includes(searchStr)) {
    // Fallback for Web target or if pattern mismatch (prepend)
    // But check for existing wasmBytes to avoid collision
    if (!jsContent.includes("const wasmBytes =")) {
       jsContent = inject + jsContent;
    } else {
       console.warn("wasmBytes already defined but pattern not matched. Skipping injection.");
    }
  }

  const fallbackRegex = /if \(typeof module_or_path === 'undefined'\) \{\s+module_or_path = new URL\('wasm_compute_bg\.wasm', import\.meta\.url\);\s+\}/;
  if (fallbackRegex.test(jsContent)) {
    jsContent = jsContent.replace(fallbackRegex, `if (typeof module_or_path === 'undefined') {\n    module_or_path = wasmBytes;\n  }`);
  } else {
    console.warn("Could not patch default module_or_path fallback; init() may still fetch from URL.");
  }

  writeFileSync(jsPath, jsContent);
  console.log(`✓ Inlined ${wasmBuffer.length} bytes of wasm-compute.`);
} catch (e) {
  console.error("Error inlining wasm-compute:", e);
  process.exit(1);
}
