import { describe, expect, it } from 'bun:test';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { generateDemoProvenanceData } from './environmental-provenance';
import { analyzeEnvironmentalDataset, createEnvironmentalAnalysisRecord, validateEnvironmentalDataset,
  type EnvironmentalDataset } from './environmental-evidence';
import { EnvironmentalEvidenceResults, environmentalSourceLabel } from '../../../web/src/components/overlays/EnvironmentalProvenanceOverlay';
import { DEFAULT_THEME } from '../../../web/src/theme/themes';

const OVERLAY = readFileSync(join(import.meta.dir, '../../../web/src/components/overlays/EnvironmentalProvenanceOverlay.tsx'), 'utf8');

function suppliedDataset(kind: EnvironmentalDataset['source']['kind'] = 'local'): EnvironmentalDataset {
  return validateEnvironmentalDataset({
    format: 'phage-explorer-environmental', version: 1, name: 'Analytical observation fixture',
    query: { id: 'taxon:fixture', label: 'Synthetic test taxon', accession: null },
    source: { kind, study: 'Hand-constructed regression fixture, not empirical observations', reference: null, version: '1', license: 'CC0' },
    measurement: { type: 'counts', method: 'Declared fixture counts', normalization: 'none' },
    samples: [
      { id: 'positive', accession: 'fixture:1', biome: 'freshwater', country: 'Test', location: { latitude: 42, longitude: -70, uncertaintyKm: 12 },
        collectionDate: '2024', occurrence: 'detected', abundance: 6 },
      { id: 'zero', accession: null, biome: 'freshwater', country: 'USA', location: null, collectionDate: '2024-02', occurrence: 'not-detected', abundance: 0 },
      { id: 'missing', accession: null, biome: 'wastewater', country: 'Germany', location: null, collectionDate: null, occurrence: 'not-assayed', abundance: null },
    ],
  });
}

async function render(kind: EnvironmentalDataset['source']['kind'], view: 'overview' | 'biomes' | 'geography' | 'observations', dataset = suppliedDataset(kind), page = 0): Promise<string> {
  const analysis = analyzeEnvironmentalDataset(dataset);
  const record = await createEnvironmentalAnalysisRecord(dataset, analysis);
  return renderToStaticMarkup(createElement(EnvironmentalEvidenceResults, { dataset, analysis, record, view, page, colors: DEFAULT_THEME.colors }));
}

/** Render actual accepted evidence: component call counts cannot establish scientific labelling. */
describe('environmental evidence preserves the meaning of supplied observations', () => {
  it('keeps detected, measured zero and unassayed observations distinct in the live result surface', async () => {
    const html = await render('local', 'observations');
    expect(html).toContain('Detected');
    expect(html).toContain('Not detected in this assay');
    expect(html).toContain('Not assayed');
    expect(html).toContain('<td>0</td>');
    expect(html).toContain('Not measured');
    expect(html).toContain('2024 (year only)');
    expect(html).toContain('2024-02 (month precision)');
    expect(html).toContain('Coordinates not reported');
    expect(html).toContain('12 km stated uncertainty');
    expect(html.match(/data-testid="environmental-observation"/g)?.length).toBe(3);
  });

  it('does not turn an unassayed biome into zero detection or a specialized habitat', async () => {
    const dataset = suppliedDataset();
    const analysis = analyzeEnvironmentalDataset(dataset);
    expect(analysis.totals).toEqual({ samples: 3, assayed: 2, detected: 1, notDetected: 1, notAssayed: 1, located: 1, dated: 2 });
    const html = await render('local', 'biomes', dataset);
    expect(html).toContain('50.0%');
    expect(html).toContain('Unavailable — no assays');
    expect(html).not.toContain('specialized for');
    expect(html).not.toContain('Novelty Score:');
    expect(html).not.toContain('PRIMARY HABITAT');
  });

  it('plots only reported coordinates, retaining unlocated samples in the observation table', async () => {
    const map = await render('local', 'geography');
    expect(map.match(/data-sample-id=/g)?.length).toBe(1);
    expect(map).toContain('data-sample-id="positive"');
    expect(map).not.toContain('data-sample-id="zero"');
    expect(map).not.toContain('data-sample-id="missing"');
    expect(map).toContain('2 remain in the table without a map position');
    expect(map).toContain('uncertainty 12 km');
    const table = await render('local', 'observations');
    expect(table).toContain('USA');
    expect(table).toContain('Germany');
    expect(table).toContain('missing');
  });

  it('does not invent precision for an unknown coordinate uncertainty or collection date', async () => {
    const dataset = suppliedDataset();
    dataset.samples[0].location!.uncertaintyKm = null;
    dataset.samples[0].collectionDate = null;
    const html = await render('local', 'observations', dataset);
    expect(html).toContain('Uncertainty not reported');
    expect(html).toContain('Not reported');
    expect(html).not.toContain('0 km stated uncertainty');
  });

  it('renders imported markup as literal sample and source text', async () => {
    const dataset = suppliedDataset();
    dataset.query.label = '<script>query</script>';
    dataset.samples[0].id = '<b>literal sample</b>';
    dataset.source.study = '<img src=x onerror=alert(1)>';
    const html = await render('local', 'observations', dataset);
    expect(html).toContain('&lt;b&gt;literal sample&lt;/b&gt;');
    expect(html).toContain('&lt;img');
    expect(html).not.toContain('<script>');
    expect(html).not.toContain('<img');
    expect(html).not.toContain('<b>literal sample');
  });

  it('allows later observation pages without silently truncating the dataset', async () => {
    const dataset = suppliedDataset();
    dataset.samples = Array.from({ length: 57 }, (_, index) => ({ ...dataset.samples[0], id: `sample-${index}` }));
    const html = await render('local', 'observations', dataset, 1);
    expect(html.match(/data-testid="environmental-observation"/g)?.length).toBe(7);
    expect(html).toContain('sample-56');
    expect(html).not.toContain('sample-49');
    expect(dataset.samples.length).toBe(57);
  });
});

describe('environmental provenance travels with every actual figure', () => {
  for (const kind of ['local', 'external', 'demo'] as const) {
    it(`labels all four views according to their accepted ${kind} source`, async () => {
      const dataset = suppliedDataset(kind);
      for (const view of ['overview', 'biomes', 'geography', 'observations'] as const) {
        const html = await render(kind, view, dataset);
        expect(html).toContain(environmentalSourceLabel(dataset));
        expect(html).toContain(dataset.query.label);
        expect(html).toContain('data-testid="environmental-figure-source"');
        expect(html).not.toContain('REAL DATA');
      }
    });
  }

  it('embeds the synthetic stamp inside both exported SVG figures and never stamps local observations as synthetic', async () => {
    for (const view of ['biomes', 'geography'] as const) {
      const demo = (await render('demo', view)).match(/<svg[\s\S]*?<\/svg>/)?.[0];
      const local = (await render('local', view)).match(/<svg[\s\S]*?<\/svg>/)?.[0];
      expect(demo).toBeDefined();
      expect(local).toBeDefined();
      expect(demo).toContain('DEMO DATA — synthetic sample set');
      expect(local).toContain('LOCAL INPUT');
      expect(local).not.toContain('DEMO DATA');
    }
  });

  it('has no name-hash score, automatic lookup or automatic synthetic replacement in the overlay', () => {
    expect(OVERLAY.length).toBeGreaterThan(1000);
    const code = OVERLAY.split('\n').filter(line => !/^\s*(?:\/\/|\*|\/\*)/.test(line)).join('\n');
    expect(code).not.toContain('seededUnit(');
    expect(code).not.toContain('hashString(');
    expect(code).not.toContain('searchPhageRelated(');
    expect(code).not.toContain('generateDemoProvenanceData(');
    // These user actions retain both public metadata and demonstrations without
    // silently invoking either when a private dataset or a selected phage changes.
    expect(code).toContain('Fetch public phage-family context');
    expect(code).toContain('Load synthetic environmental example');
    expect(code).toContain('SRA metadata carries no sequence');
  });
});

describe('legacy demo identifiers cannot be mistaken for real accessions', () => {
  const hits = generateDemoProvenanceData('lambda', () => 0.42);
  it('retains unambiguous demo identifiers even for callers of the legacy generator', () => {
    expect(hits.length).toBeGreaterThan(0);
    for (const hit of hits) {
      expect(hit.metagenomeId.startsWith('DEMO-')).toBe(true);
      expect(/^(IMG\/VR|MGnify|VIROME)_\d+$/.test(hit.metagenomeId)).toBe(false);
    }
    expect(/^(IMG\/VR|MGnify|VIROME)_\d+$/.test('IMG/VR_20230001')).toBe(true);
    expect(/^(IMG\/VR|MGnify|VIROME)_\d+$/.test('DEMO-IMG/VR_20230001')).toBe(false);
  });
});
