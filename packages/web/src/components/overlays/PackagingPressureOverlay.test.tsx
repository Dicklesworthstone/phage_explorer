import React from 'react';
import { describe, expect, it } from 'bun:test';
import { renderToStaticMarkup } from 'react-dom/server';
import { makePackagingSimulation, packagingStateAt } from '@phage-explorer/core';
import { PackagingCursorLoad } from './PackagingPressureOverlay';
import { PackagingMotorVisualizer } from '../simulations/PackagingMotorVisualizer';

describe('packaging evidence at supported and unsupported geometry', () => {
  it('renders the computed load and internal pressure while duplex spacing is supported', () => {
    const state = packagingStateAt(20000, 50000, 'podovirus');
    const html = renderToStaticMarkup(<PackagingCursorLoad state={state} />);
    expect(html).toContain(`${state.forcePn.toFixed(1)} pN`);
    expect(html).toContain(`${state.pressureAtm.toFixed(1)} atm`);
    expect(html).not.toContain('Unavailable');
  });

  it('withholds both physical numbers beyond the non-overlap limit for a large private genome', () => {
    const state = packagingStateAt(1000000, 1000000, 'podovirus');
    expect(state.spacingNm!).toBeLessThan(2);
    const html = renderToStaticMarkup(<PackagingCursorLoad state={state} />);
    expect(html).toContain('DNA spacing below 2 nm');
    expect(html.match(/Unavailable/g)).toHaveLength(2);
    expect(html).not.toContain(`${state.forcePn.toFixed(1)} pN`);
    expect(html).not.toContain(`${state.pressureAtm.toFixed(1)} atm`);
  });

  it('distinguishes the empty capsid from unsupported packed geometry', () => {
    const state = packagingStateAt(0, 50000, 'podovirus');
    expect(state.spacingNm).toBeNull();
    const html = renderToStaticMarkup(<PackagingCursorLoad state={state} />);
    expect(html).toContain('0.0 atm');
    expect(html).not.toContain('Unavailable');
  });

  it('exposes real completion and model assumptions without inventing a stall probability', () => {
    const sim = makePackagingSimulation();
    const final = sim.step(sim.init(null, { genomeKb: 3, capsidRadius: 60, ionic: 200 }), 8);
    const html = renderToStaticMarkup(<PackagingMotorVisualizer state={final} />);
    expect(html).toContain('complete');
    expect(html).toContain('3000.0');
    expect(html).toContain('100.0 percent packaged');
    expect(html).toContain('nominal ATP');
    expect(html).toContain('Uncalibrated dsDNA teaching model');
    expect(html).not.toContain('Stall probability');
  });
});
