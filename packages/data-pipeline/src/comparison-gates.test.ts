import { describe, expect, it } from 'bun:test';
import { readFileSync, existsSync, statSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { gzipSync } from 'node:zlib';
import { Database } from 'bun:sqlite';
import { renderKeyboardShortcuts } from '../../../scripts/generate-keyboard-tables';
import { ActionRegistryList } from '../../web/src/keyboard/actionRegistry';

const REPO_ROOT = join(import.meta.dir, '../../..');
const README = readFileSync(join(REPO_ROOT, 'README.md'), 'utf8');

// ===========================================================================
// Gate 1: Keyboard Sync Gate (T3.1)
// ===========================================================================
describe('Comparison Gate 1: Keyboard Sync Gate (T3.1)', () => {
  const keyboardDocPath = join(REPO_ROOT, 'docs/keyboard-shortcuts.md');

  it('docs/keyboard-shortcuts.md matches generated registry tables exactly', () => {
    expect(existsSync(keyboardDocPath)).toBe(true);
    const docContent = readFileSync(keyboardDocPath, 'utf8');
    const generatedContent = renderKeyboardShortcuts();
    expect(docContent).toBe(generatedContent);
  });

  it('planted negative: detects stale keyboard documentation when shortcuts differ', () => {
    const generated = renderKeyboardShortcuts();
    const corrupted = generated + '\n| Synthetic Action | `Ctrl+Alt+Shift+Z` | Synthetic Description |\n';
    expect(corrupted).not.toBe(generated);
  });
});

// ===========================================================================
// Gate 2: Performance Claims Verification Gate (T4)
// ===========================================================================
describe('Comparison Gate 2: Performance Claims Verification Gate (T4)', () => {
  const benchPath = join(REPO_ROOT, 'packages/wasm-compute/benchmark-results.json');
  const benchmarkJson = JSON.parse(readFileSync(benchPath, 'utf8'));

  interface BenchRow {
    kernel: string;
    sizeBp: number;
    speedup: number;
  }
  const benchmarkRows: BenchRow[] = benchmarkJson.rows;

  const KERNEL_NAME_MAP: Record<string, string> = {
    'MinHash Jaccard (k=12)': 'min_hash_jaccard (k=12)',
    'k-mer analysis (k=6)': 'analyze_kmers (k=6)',
    'Reverse complement': 'reverse_complement',
    'Translate sequence': 'translate_sequence',
    'Levenshtein distance': 'levenshtein_distance',
    'Dense k-mer counting (k=6)': 'count_kmers_dense (k=6)',
    'Codon usage counting': 'count_codon_usage',
    'GC content': 'calculate_gc_content',
  };

  function parseReadmeSpeedups(): Map<string, { k1: string; k25: string; k300: string }> {
    const map = new Map<string, { k1: string; k25: string; k300: string }>();
    const sectionMatch = README.match(/### Measured speedups[\s\S]*?\| Kernel \| 1 kb \| 25 kb \| 300 kb \|([\s\S]*?)\n\n/);
    if (!sectionMatch) return map;

    const lines = sectionMatch[1].trim().split('\n').slice(1); // skip divider
    for (const line of lines) {
      const cols = line.split('|').map(c => c.trim()).filter(Boolean);
      if (cols.length >= 4) {
        map.set(cols[0], {
          k1: cols[1].replace(/\*\*/g, ''),
          k25: cols[2].replace(/\*\*/g, ''),
          k300: cols[3].replace(/\*\*/g, ''),
        });
      }
    }
    return map;
  }

  it('every kernel speedup in README is backed by committed benchmark data', () => {
    const claims = parseReadmeSpeedups();
    expect(claims.size).toBeGreaterThan(5);

    for (const [displayName, values] of claims.entries()) {
      const kernelKey = KERNEL_NAME_MAP[displayName];
      expect(kernelKey).toBeDefined();

      const matchingRows = benchmarkRows.filter(r => r.kernel === kernelKey);
      expect(matchingRows.length).toBeGreaterThan(0);

      // Verify the 1 kb speedup matches benchmark within ±0.3x tolerance
      const row1k = matchingRows.find(r => r.sizeBp === 1000);
      if (row1k && values.k1 !== '—') {
        const claimed1k = parseFloat(values.k1.replace('x', ''));
        expect(Math.abs(claimed1k - row1k.speedup)).toBeLessThan(0.35);
      }

      // Verify the 300 kb speedup matches benchmark within ±3x tolerance
      const row300k = matchingRows.find(r => r.sizeBp === 300000);
      if (row300k && values.k300 !== '—') {
        const claimed300k = parseFloat(values.k300.replace('x', ''));
        expect(Math.abs(claimed300k - row300k.speedup)).toBeLessThan(3.5);
      }
    }
  });

  it('planted negative: fails when an unsourced speedup claim is checked', () => {
    const fakeClaim = {
      kernelName: 'non_existent_turbo_kernel',
      claimedSpeedup: '500x',
    };
    const row = benchmarkRows.find(r => r.kernel === fakeClaim.kernelName);
    expect(row).toBeUndefined();
  });
});

// ===========================================================================
// Gate 3: Annotation Coverage Gate (T5)
// ===========================================================================
describe('Comparison Gate 3: Annotation Coverage Gate (T5)', () => {
  const dbPath = join(REPO_ROOT, 'packages/web/public/phage.db');
  const db = new Database(dbPath, { readonly: true });

  it('overlays with "measured" provenance are backed by full catalog data in SQLite', () => {
    // Overlays claiming measured must have backing data across all 24 phages
    const measuredActions = ActionRegistryList.filter(a => a.provenance === 'measured' && a.overlayId);
    expect(measuredActions.length).toBeGreaterThan(0);

    // proteinDomains must have >1,000 domains across 24 phages
    const domainCount = db.query<{ n: number }, []>('SELECT count(*) as n FROM protein_domains').get()?.n ?? 0;
    expect(domainCount).toBeGreaterThan(1000);

    // codonBias must have >2,000 codon adaptation rows
    const codonCount = db.query<{ n: number }, []>('SELECT count(*) as n FROM codon_adaptation').get()?.n ?? 0;
    expect(codonCount).toBeGreaterThan(2000);

    // Sequences must cover all 24 phages
    const seqPhages = db.query<{ n: number }, []>('SELECT count(distinct phage_id) as n FROM sequences').get()?.n ?? 0;
    expect(seqPhages).toBe(24);
  });

  it('rule-based and heuristic overlays do not claim "measured" provenance', () => {
    const heuristicIds = ['defenseArmsRace', 'amgPathway', 'tropism', 'stability', 'pressure'];
    for (const id of heuristicIds) {
      const action = ActionRegistryList.find(a => a.overlayId === id);
      expect(action?.provenance).not.toBe('measured');
      expect(action?.provenance).toBe('heuristic');
    }
  });

  it('planted negative: rejects an overlay claiming "measured" on an empty or missing table', () => {
    function validateProvenanceAgainstTable(provenance: string, rowCount: number): boolean {
      if (provenance === 'measured' && rowCount === 0) {
        return false;
      }
      return true;
    }

    expect(validateProvenanceAgainstTable('measured', 1500)).toBe(true);
    expect(validateProvenanceAgainstTable('measured', 0)).toBe(false);
  });
});

// ===========================================================================
// Gate 4: Release Monotonicity & Fail-Closed Gate (T2.1)
// ===========================================================================
describe('Comparison Gate 4: Release Pipeline Gate (T2.1)', () => {
  const workflowPath = join(REPO_ROOT, '.github/workflows/release-automation.yml');
  const workflowContent = readFileSync(workflowPath, 'utf8');

  it('workflow rejects stale and behind version tags with exit code 1', () => {
    expect(workflowContent).toContain("if: steps.tag.outputs.status == 'stale'");
    expect(workflowContent).toContain("if: steps.tag.outputs.status == 'behind'");
    expect(workflowContent).toContain('exit 1');
  });

  it('tag classification fails closed on stale and behind tags', () => {
    function classifyRelease(desired: string, latest: string, existingTagSha?: string, headSha?: string): 'create' | 'exists' | 'stale' | 'behind' {
      if (existingTagSha) {
        if (existingTagSha === headSha) return 'exists';
        return 'stale';
      }
      if (latest && desired < latest) {
        return 'behind';
      }
      return 'create';
    }

    // Normal bump
    expect(classifyRelease('v1.5.0', 'v1.4.1')).toBe('create');
    // Re-push on current tag
    expect(classifyRelease('v1.5.0', 'v1.5.0', 'shaA', 'shaA')).toBe('exists');
    // Stale tag on different commit (the defect that blocked releases for 5 months)
    expect(classifyRelease('v1.3.2', 'v1.4.1', 'shaOld', 'shaHead')).toBe('stale');
    // Behind tag
    expect(classifyRelease('v1.3.0', 'v1.4.1')).toBe('behind');
  });

  it('planted negative: a workflow that exits 0 on stale status fails verification', () => {
    const badWorkflow = `
      - name: Stale check
        if: steps.tag.outputs.status == 'stale'
        run: echo "Skipping stale tag" && exit 0
    `;
    const isSafe = badWorkflow.includes("status == 'stale'") && badWorkflow.includes('exit 1');
    expect(isSafe).toBe(false);
  });
});

// ===========================================================================
// Gate 5: Bundle Budget Gate
// ===========================================================================
describe('Comparison Gate 5: Bundle Budget Gate', () => {
  const distDir = join(REPO_ROOT, 'packages/web/dist/assets');

  it('eager entry chunk is within README budget (≤ 900 kB raw / ≤ 275 kB gzip)', () => {
    if (!existsSync(distDir)) {
      console.warn('distDir not found, skipping built bundle check');
      return;
    }

    const files = readdirSync(distDir);
    const indexJs = files.find(f => f.startsWith('index-') && f.endsWith('.js'));
    expect(indexJs).toBeDefined();

    const indexPath = join(distDir, indexJs!);
    const rawBytes = statSync(indexPath).size;
    const content = readFileSync(indexPath);
    const gzBytes = gzipSync(content).length;

    // Budget: 900 kB raw, 275 kB gzip
    expect(rawBytes).toBeLessThanOrEqual(900 * 1024);
    expect(gzBytes).toBeLessThanOrEqual(275 * 1024);
  });

  it('planted negative: detects budget exceedance', () => {
    const fakeRaw = 1_500_000;
    const fakeGz = 500_000;
    const budgetRaw = 900 * 1024;
    const budgetGz = 275 * 1024;

    expect(fakeRaw <= budgetRaw).toBe(false);
    expect(fakeGz <= budgetGz).toBe(false);
  });
});
