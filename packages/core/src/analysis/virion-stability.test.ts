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
