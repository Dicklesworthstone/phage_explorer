import { describe, expect, it } from 'bun:test';
import { predictVirionStability, predictVirionStabilityFromPhage } from './virion-stability';

describe('Virion stability', () => {
  it('predictVirionStability > returns robust under ideal cold + isotonic conditions for a stable dsDNA morphology', () => {
    const estimate = predictVirionStability(
      {
        genomeLength: 45_000,
        gcContent: 70,
        morphology: 'Myoviridae',
        baltimoreGroup: 'I',
        pdbIds: ['1abc'],
      },
      { temperatureC: 4, saltMilliMolar: 100 }
    );

    expect(estimate.status).toBe('robust');
    expect(estimate.integrity).toBeGreaterThanOrEqual(0.65);
    expect(estimate.temperatureFactor).toBe(1);
    expect(estimate.saltFactor).toBe(1);
    expect(estimate.warnings).toEqual([]);
    expect(estimate.notes).toEqual([]);
  });

  it('predictVirionStability > degrades under high temperature and emits warnings', () => {
    const estimate = predictVirionStability(
      {
        genomeLength: 150_000,
        gcContent: 40,
        morphology: 'Inoviridae',
        baltimoreGroup: 'V',
        pdbIds: [],
      },
      { temperatureC: 45, saltMilliMolar: 20 }
    );

    expect(estimate.status).toBe('fragile');
    expect(estimate.integrity).toBeLessThan(0.5);
    expect(estimate.warnings.join(' ')).toContain('Handling above 37°C');
    expect(estimate.warnings.join(' ')).toContain('Very low salt');
    expect(estimate.notes.join(' ')).toContain('No PDB models linked');
  });

  it('predictVirionStabilityFromPhage > handles null phage', () => {
    const estimate = predictVirionStabilityFromPhage(null, { temperatureC: 4, saltMilliMolar: 100 });
    expect(estimate.integrity).toBeGreaterThanOrEqual(0);
    expect(estimate.integrity).toBeLessThanOrEqual(1);
  });
});

/**
 * Storage advice must not be a constant wearing a recommendation's clothes.
 *
 * `recommendedStorage` returned `{ 4 °C, 100 mM }` for every phage in the
 * catalogue and both overlays presented it as a per-phage recommendation. This
 * overlay sits inside the phage-therapy screening story the README tells, so it
 * is exactly the kind of output a wet-lab user might act on, and a constant is
 * indistinguishable from a computed one.
 */
describe('storage advice is derived or absent, never constant', () => {
  const env = { temperatureC: 20, saltMilliMolar: 100 };
  const base = { genomeLength: 48000, gcContent: 50, morphology: '' };

  it('gives no recommendation for a phage with nothing to base one on', () => {
    const r = predictVirionStability({ ...base, family: 'Siphoviridae' }, env);
    expect(r.recommendedStorage).toBeNull();
  });

  it('gives a recommendation for lipid-containing virions, with a reason', () => {
    // PRD1, PM2 and phi6 are in this catalogue and genuinely differ in
    // handling: they lose infectivity on freezing and on solvent contact.
    for (const family of ['Tectiviridae', 'Corticoviridae', 'Cystoviridae']) {
      const r = predictVirionStability({ ...base, family }, env);
      expect(r.recommendedStorage).not.toBeNull();
      expect(r.recommendedStorage!.rationale).toContain('Lipid-containing');
    }
  });

  it('does not give every phage the same answer', () => {
    // The discrimination check, and the exact defect being fixed. If this ever
    // passes for all families again, the constant is back.
    const lipid = predictVirionStability({ ...base, family: 'Tectiviridae' }, env);
    const other = predictVirionStability({ ...base, family: 'Myoviridae' }, env);
    expect(lipid.recommendedStorage).not.toEqual(other.recommendedStorage);
  });

  it('still varies its composition-derived metrics with the genome', () => {
    // Guards against over-correction: removing the constant must not flatten
    // the metrics that were always real.
    const lowGc = predictVirionStability({ ...base, gcContent: 38 }, env);
    const highGc = predictVirionStability({ ...base, gcContent: 66 }, env);
    expect(highGc.meltingTempC).toBeGreaterThan(lowGc.meltingTempC);
    expect(highGc.baseIndex).toBeGreaterThan(lowGc.baseIndex);
  });
});
