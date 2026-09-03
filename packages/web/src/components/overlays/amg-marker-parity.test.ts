import { describe, expect, it } from 'bun:test';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { AMG_MARKER_GENES } from './AMGPathwayOverlay';

/**
 * The AMG empty state must name the genes the pipeline actually searches for.
 *
 * ## Why this test exists
 *
 * The overlay's empty state used to read "AMG detection requires KEGG pathway
 * annotations." That is not what the scanner does. It matches eight gene-name
 * patterns against gene and product strings and ASSIGNS a KEGG ortholog to each
 * hit; KEGG data is an output, not an input. A user seeing an empty overlay was
 * told the database lacked something, when the truth is that none of that
 * phage's genes carried one of eight names.
 *
 * The empty state now lists the eight. That is only an improvement while the
 * list is true, and the list lives in the browser bundle while the rules live in
 * `build-db.ts`, a build-time module the browser cannot import. Duplication with
 * no check is how a helpful message becomes a confidently wrong one.
 *
 * ## What the phage-therapy screening workflow depends on
 *
 * This matters more than a wording nit. AMG annotation is step 2 of the README's
 * screening workflow, and the overlay is empty for 16 of 24 phages. An empty
 * panel that reads as a biological result -- "no auxiliary metabolic genes
 * detected" -- is a claim about the phage. An empty panel that names its own
 * method is a claim about the method. Only the second one is true, because most
 * phage genes in RefSeq are annotated "hypothetical protein" and a name-matching
 * scanner cannot see past that.
 */

const BUILD_DB = join(
  import.meta.dir,
  '../../../../../packages/data-pipeline/src/build-db.ts'
);

/** The marker names in the pipeline's AMG rule table, in declaration order. */
function pipelineMarkerGenes(): string[] {
  const src = readFileSync(BUILD_DB, 'utf8');

  // Each rule looks like:
  //   { pattern: /\bpsba\b|photosystem ii.*d1 protein/i, amgType: '...', ... }
  // Take the first \b-delimited token of each pattern that also declares an
  // amgType, which is what distinguishes AMG rules from the defense ones.
  const names: string[] = [];
  for (const m of src.matchAll(/\{\s*pattern:\s*\/\\b([a-z0-9]+)\\b[^\n]*amgType:/g)) {
    names.push(m[1]!);
  }
  return names;
}

describe('the AMG empty state names the genes the pipeline searches for', () => {
  const fromPipeline = pipelineMarkerGenes();

  it('finds the pipeline rules, so the comparison is not vacuous', () => {
    // A regex that silently matched nothing would make every assertion below
    // pass against an empty list.
    expect(fromPipeline.length).toBeGreaterThan(0);
    expect(fromPipeline).toContain('psba');
  });

  it('lists exactly the pipeline markers, case-insensitively', () => {
    const shown = AMG_MARKER_GENES.map(g => g.toLowerCase()).sort();
    expect(shown).toEqual([...fromPipeline].sort());
  });

  it('is discriminating', () => {
    // Guards the comparison itself: a ninth pipeline rule must fail the test
    // above rather than slip through.
    const withExtra = [...fromPipeline, 'cobs'].sort();
    const shown = AMG_MARKER_GENES.map(g => g.toLowerCase()).sort();
    expect(shown).not.toEqual(withExtra);
  });
});

describe('the empty states describe a method, not a biological result', () => {
  const read = (f: string): string => readFileSync(join(import.meta.dir, f), 'utf8');

  for (const file of ['AMGPathwayOverlay.tsx', 'DefenseArmsRaceOverlay.tsx']) {
    it(`${file} says the search was over names`, () => {
      const src = read(file);
      expect(src).toContain('in gene and product NAMES');
      expect(src).toContain('absence of evidence rather than evidence of absence');
    });

    it(`${file} does not present the empty result as a genome-wide scan`, () => {
      // "Genome scanned across N CDS features; no X were found" reads as a
      // finding about the phage. The scanner cannot support that claim.
      expect(read(file)).not.toContain('Genome scanned across');
    });
  }

  /** Source with block comments removed, so prose about a defect is not read as the defect. */
  const code = (f: string): string => read(f).replace(/\/\*[\s\S]*?\*\//g, '');

  it('AMG no longer claims KEGG annotations are required', () => {
    // The specific false statement this work removed. Checked against the code
    // rather than the file: the docblock above AMG_MARKER_GENES quotes the old
    // wording to explain why it was wrong, and a test that cannot tell an
    // explanation from the thing it explains would forbid documenting the fix.
    expect(code('AMGPathwayOverlay.tsx')).not.toContain('requires KEGG pathway annotations');
  });

  it('is discriminating about comment stripping', () => {
    // The stripper must remove comments and keep code, or the assertion above
    // could pass because it stripped everything.
    const src = code('AMGPathwayOverlay.tsx');
    expect(src).toContain('AMG_MARKER_GENES');
    expect(src).not.toContain('a build-time module the browser cannot import');
  });
});
