import { describe, expect, it } from 'bun:test';
import React from 'react';
import { render, renderToString } from 'ink';
import { PassThrough, Writable } from 'node:stream';
import { stripVTControlCharacters } from 'node:util';
import { importLocalGenomes, makeLysogenySimulation, makePackagingSimulation, packagingStateAt, ribosomeTrafficSimulation, type LysogenyCircuitState, type RibosomeTrafficState, type PackagingMotorState } from '@phage-explorer/core';
import { usePhageStore } from '@phage-explorer/state';
import { SimulationHubOverlay } from './SimulationHubOverlay';
import { SimulationView } from './SimulationView';
import { RibosomeTrafficView } from './RibosomeTrafficView';
import { PackagingPressureOverlay } from './PackagingPressureOverlay';

async function fixture() {
  const parsed = await importLocalGenomes({ name: 'translation.gb', text:
    'LOCUS       EXACT 35 bp DNA linear\nFEATURES             Location/Qualifiers\n' +
    '     CDS             complement(join(1..7,12..14))\n' +
    '                     /locus_tag="joined-reverse"\n                     /product="joined protein"\n' +
    '                     /codon_start=2\n                     /transl_table=15\n                     /translation="MQ"\n' +
    '     CDS             18..35\n                     /locus_tag="longer"\n                     /product="longer protein"\n' +
    'ORIGIN\n        1 ttactacggggattcccatgaaaaagaaaaaataa\n//\n' });
  const genome = parsed.genomes[0];
  usePhageStore.setState({ currentPhage: genome.phage, phages: [genome.phage], currentPhageIndex: 0,
    selectedGeneId: genome.phage.genes[0].id, activeSimulationId: null, simulationState: null,
    simulationPaused: true, simulationSpeed: 1, terminalCols: 120, terminalRows: 50, overlays: [] });
  return genome;
}
async function waitFor(predicate: () => boolean) {
  const deadline = Date.now() + 5000;
  while (!predicate()) {
    if (Date.now() > deadline) throw new Error('Terminal simulation did not reach the expected state.');
    await new Promise(resolve => setTimeout(resolve, 10));
  }
}
async function flush() { await new Promise(resolve => setTimeout(resolve, 30)); }
function terminal(element: React.ReactElement) {
  let output = '', ready = false;
  const stdout = Object.assign(new Writable({ write(chunk, _encoding, callback) {
    output += stripVTControlCharacters(chunk.toString()); callback();
  } }), { columns: 120, rows: 50 });
  const stdin = Object.assign(new PassThrough(), { isTTY: true, setRawMode: (_value: boolean) => { ready = true; }, ref() {}, unref() {} });
  const ui = render(element, { stdout: stdout as unknown as NodeJS.WriteStream,
    stderr: stdout as unknown as NodeJS.WriteStream, stdin: stdin as unknown as NodeJS.ReadStream,
    debug: true, patchConsole: false, exitOnCtrlC: false });
  return { ui, ready: () => ready, output: () => output, press: (value: string) => stdin.write(value) };
}

describe('terminal lysogeny source evidence', () => {
  it('launches with the complete selected genome and exposes observed candidates with the model caveat', async () => {
    const previous = usePhageStore.getState(), genome = await fixture();
    const sequence = 'NNNTATCACCGCCAGAGGTANNN';
    const phage = { ...genome.phage, genomeLength: sequence.length, genes: [] };
    usePhageStore.setState({ currentPhage: phage });
    let closed = 0;
    const test = terminal(<SimulationHubOverlay genomeSequence={sequence} onClose={() => { closed++; }} />);
    try {
      await waitFor(test.ready); test.press('\r');
      await waitFor(() => usePhageStore.getState().activeSimulationId === 'lysogeny-circuit');
      const state = usePhageStore.getState().simulationState as LysogenyCircuitState;
      expect(closed).toBe(1);
      expect(state.modelVersion).toBe(3);
      expect(state.circuitInfo?.sequenceLength).toBe(sequence.length);
      expect(state.circuitInfo?.operators[0]).toMatchObject({ position: 3, direction: '+', sequence: 'TATCACCGCCAGAGGTA' });
      const output = stripVTControlCharacters(renderToString(<SimulationView onClose={() => {}} />, { columns: 120 }));
      expect(output).toContain('1 OR1-reference');
      expect(output).toContain('teaching score=');
      expect(output).toContain('fate score are uncalibrated');
      expect(output).not.toContain('P(lyso)');
    } finally { test.ui.unmount(); usePhageStore.setState(previous); }
  });

  it('preserves an accepted run when selected genome loading fails and launches after the source arrives', async () => {
    const previous = usePhageStore.getState(), genome = await fixture();
    const accepted = makeLysogenySimulation().init(null);
    usePhageStore.setState({ activeSimulationId: 'lysogeny-circuit', simulationState: accepted });
    let closed = 0;
    const test = terminal(<SimulationHubOverlay genomeSequence={null} onClose={() => { closed++; }} />);
    try {
      await waitFor(test.ready); test.press('\r');
      await waitFor(() => test.output().includes('complete selected genome'));
      expect(closed).toBe(0);
      expect(usePhageStore.getState().simulationState).toBe(accepted);
      test.ui.rerender(<SimulationHubOverlay genomeSequence={genome.sequence} onClose={() => { closed++; }} />);
      await flush(); test.press('\r'); await waitFor(() => closed === 1);
      const state = usePhageStore.getState().simulationState as LysogenyCircuitState;
      expect(state.circuitInfo?.sequenceStatus).toBe('scanned');
      expect(state.circuitInfo?.sequenceLength).toBe(genome.sequence.length);
      expect(state.circuitInfo?.operators).toEqual([]);
    } finally { test.ui.unmount(); usePhageStore.setState(previous); }
  });
});

describe('terminal exact-CDS ribosome simulation', () => {
  it('launches the selected reverse joined CDS and displays the actual coding model', async () => {
    const previous = usePhageStore.getState();
    const genome = await fixture();
    let closed = 0;
    const test = terminal(<SimulationHubOverlay genomeSequence={genome.sequence} onClose={() => { closed++; }} />);
    try {
      await waitFor(test.ready);
      test.press('\u001b[B');
      await waitFor(() => test.output().includes('CDS: joined-reverse'));
      test.press('\r');
      await waitFor(() => usePhageStore.getState().activeSimulationId === 'ribosome-traffic');
      const state = usePhageStore.getState().simulationState as RibosomeTrafficState;
      expect(closed).toBe(1);
      expect(state.transcript?.cds).toBe('ATGTAGTAA');
      expect(state.transcript?.protein).toBe('MQ*');
      expect(state.codonRates).toEqual([1, 1, 1]);
      const output = stripVTControlCharacters(renderToString(<RibosomeTrafficView state={state} />, { columns: 120 }));
      expect(output).toContain('NCBI table 15');
      expect(output).toContain('codon_start 2');
      expect(output).toContain('Track: 3 codons');
      expect(output).toContain('Codon 2 (TAG)');
      expect(output).toContain('not measured tRNA');
      expect(output).not.toContain('Synthetic demonstration');
    } finally { test.ui.unmount(); usePhageStore.setState(previous); }
  });

  it('lets the user choose another CDS before creating the track', async () => {
    const previous = usePhageStore.getState(), genome = await fixture();
    const test = terminal(<SimulationHubOverlay genomeSequence={genome.sequence} onClose={() => {}} />);
    try {
      await waitFor(test.ready); test.press('\u001b[B');
      await waitFor(() => test.output().includes('CDS: joined-reverse'));
      test.press('\u001b[C');
      await waitFor(() => test.output().includes('CDS: longer'));
      test.press('\r'); await waitFor(() => usePhageStore.getState().activeSimulationId === 'ribosome-traffic');
      const state = usePhageStore.getState().simulationState as RibosomeTrafficState;
      expect(state.transcript?.geneId).toBe(genome.phage.genes[1].id);
      expect(state.transcript?.cds).toBe('ATGAAAAAGAAAAAATAA');
      expect(state.codonRates).toEqual([1, 1, 0.4, 1, 1, 1]);
    } finally { test.ui.unmount(); usePhageStore.setState(previous); }
  });

  it('keeps missing sequence failures visible and preserves the previously accepted run', async () => {
    const previous = usePhageStore.getState(), genome = await fixture();
    const accepted = ribosomeTrafficSimulation.init(null, {}, () => 0);
    usePhageStore.setState({ activeSimulationId: 'ribosome-traffic', simulationState: accepted });
    let closed = 0;
    const test = terminal(<SimulationHubOverlay genomeSequence={null} onClose={() => { closed++; }} />);
    try {
      await waitFor(test.ready); test.press('\u001b[B');
      await waitFor(() => test.output().includes('CDS: joined-reverse'));
      test.press('\r'); await waitFor(() => test.output().includes('Load the complete genome sequence'));
      expect(closed).toBe(0);
      expect(usePhageStore.getState().simulationState).toBe(accepted);
      test.ui.rerender(<SimulationHubOverlay genomeSequence={genome.sequence} onClose={() => { closed++; }} />);
      await flush(); test.press('\r'); await waitFor(() => closed === 1);
      expect((usePhageStore.getState().simulationState as RibosomeTrafficState).source).toBe('annotated-cds');
    } finally { test.ui.unmount(); usePhageStore.setState(previous); }
  });

  it('changes the selected parameter, resets occupancy safely, and steps the reset snapshot', async () => {
    const previous = usePhageStore.getState(), genome = await fixture();
    const initial = ribosomeTrafficSimulation.init(genome.phage, { initiationRate: 1, footprint: 1 }, () => 0,
      { genomeSequence: genome.sequence, geneId: genome.phage.genes[1].id });
    usePhageStore.setState({ activeSimulationId: 'ribosome-traffic', simulationState: initial, simulationPaused: true });
    const test = terminal(<SimulationView onClose={() => {}} />);
    try {
      await waitFor(test.ready);
      test.press('.'); await waitFor(() => usePhageStore.getState().simulationState?.time === 1);
      expect((usePhageStore.getState().simulationState as RibosomeTrafficState).ribosomes).toEqual([0]);
      test.press(']'); await flush(); test.press(']'); await flush(); test.press('+');
      await waitFor(() => usePhageStore.getState().simulationState?.params.footprint === 2);
      const changed = usePhageStore.getState().simulationState as RibosomeTrafficState;
      expect(changed.ribosomes).toEqual([]);
      expect(changed.time).toBe(0);
      expect(changed.transcript).toEqual(initial.transcript);
      expect(usePhageStore.getState().simulationSpeed).toBe(1);
      expect(usePhageStore.getState().simulationPaused).toBe(true);
      test.press('-'); await waitFor(() => usePhageStore.getState().simulationState?.params.footprint === 1);
      test.press('.'); await waitFor(() => usePhageStore.getState().simulationState?.time === 1);
      test.press('r'); await waitFor(() => usePhageStore.getState().simulationState?.time === 0);
      test.press('.'); await waitFor(() => usePhageStore.getState().simulationState?.time === 1);
      expect((usePhageStore.getState().simulationState as RibosomeTrafficState).ribosomes).toEqual([0]);
    } finally { test.ui.unmount(); usePhageStore.setState(previous); }
  });
});

describe('terminal packaging cursor uses the shared physical model', () => {
  it.each([
    { viewMode: 'dna' as const, scrollPosition: 20000, morphology: 'podovirus', bp: 20000 },
    { viewMode: 'aa' as const, scrollPosition: 6000, morphology: 'myovirus', bp: 18000 },
  ])('uses exact bp and morphology in $viewMode view', async ({ viewMode, scrollPosition, morphology, bp }) => {
    const previous = usePhageStore.getState(), genome = await fixture();
    usePhageStore.setState({ currentPhage: { ...genome.phage, genomeLength: 50000, morphology },
      scrollPosition, viewMode });
    const expected = packagingStateAt(bp, 50000, morphology, 0.1);
    const test = terminal(<PackagingPressureOverlay />);
    try {
      await waitFor(test.ready);
      expect(test.output()).toContain(`Position: ${bp.toLocaleString()} / 50,000 bp`);
      expect(test.output()).toContain(`Force: ${expected.forcePn.toFixed(1)} pN`);
      expect(test.output()).toContain(`Model pressure: ${expected.pressureAtm.toFixed(1)} atm`);
      expect(test.output()).toContain(`Nominal ATP: ${expected.atpCount.toLocaleString()}`);
      expect(test.output()).toContain('Ionic strength: 0.10 M');
      expect(test.output()).toContain(`Assumed radius: ${expected.capsidRadiusNm.toFixed(1)} nm`);
      expect(test.output()).not.toContain('Unavailable');
      expect(test.output()).not.toContain('warn above 50 atm');
    } finally { test.ui.unmount(); usePhageStore.setState(previous); }
  });

  it('shows zero internal pressure and no DNA lattice at the empty capsid', async () => {
    const previous = usePhageStore.getState(), genome = await fixture();
    usePhageStore.setState({ currentPhage: { ...genome.phage, genomeLength: 50000, morphology: 'podovirus' },
      scrollPosition: 0, viewMode: 'dna' });
    const expected = packagingStateAt(0, 50000, 'podovirus', 0.1);
    const test = terminal(<PackagingPressureOverlay />);
    try {
      await waitFor(test.ready);
      expect(test.output()).toContain(`Force: ${expected.forcePn.toFixed(1)} pN`);
      expect(test.output()).toContain('Model pressure: 0.0 atm');
      expect(test.output()).toContain('Nominal ATP: 0');
      expect(test.output()).toContain('Implied DNA spacing: empty capsid');
      expect(test.output()).not.toContain('Unavailable');
    } finally { test.ui.unmount(); usePhageStore.setState(previous); }
  });

  it('withholds physical load and pressure beyond the dsDNA non-overlap limit', async () => {
    const previous = usePhageStore.getState(), genome = await fixture();
    usePhageStore.setState({ currentPhage: { ...genome.phage, genomeLength: 1000000, morphology: 'podovirus' },
      scrollPosition: 1000000, viewMode: 'dna' });
    const extrapolation = packagingStateAt(1000000, 1000000, 'podovirus', 0.1);
    expect(extrapolation.spacingNm!).toBeLessThan(2);
    const test = terminal(<PackagingPressureOverlay />);
    try {
      await waitFor(test.ready);
      expect(test.output()).toContain('Force: Unavailable');
      expect(test.output()).toContain('Model pressure: Unavailable');
      expect(test.output()).toContain('DNA spacing below 2 nm');
      expect(test.output()).not.toContain(`${extrapolation.forcePn.toFixed(1)} pN`);
      expect(test.output()).not.toContain(`${extrapolation.pressureAtm.toFixed(1)} atm`);
      expect(test.output()).not.toContain('Model pressure gauge');
    } finally { test.ui.unmount(); usePhageStore.setState(previous); }
  });
});

describe('terminal physical packaging motor', () => {
  it('steps, edits salt and presets, applies speed once and resets using the current controls', async () => {
    const previous = usePhageStore.getState();
    await fixture();
    const sim = makePackagingSimulation(), initial = sim.init();
    usePhageStore.setState({ activeSimulationId: 'packaging-motor', simulationState: initial,
      simulationPaused: true, simulationSpeed: 1 });
    const test = terminal(<SimulationView onClose={() => {}} />);
    try {
      await waitFor(test.ready); test.press('.');
      await waitFor(() => usePhageStore.getState().simulationState?.time === 1);
      test.press(']'); await flush(); test.press(']'); await flush(); test.press('+');
      await waitFor(() => usePhageStore.getState().simulationState?.params.ionic === 55);
      const changed = usePhageStore.getState().simulationState as PackagingMotorState;
      expect(changed.bpPackaged).toBe(0); expect(changed.time).toBe(0);
      expect(changed.params.genomeKb).toBe(50);
      test.press(']'); await flush(); test.press('+');
      await waitFor(() => usePhageStore.getState().simulationState?.params.mode === 'phi29');
      const restarted = usePhageStore.getState().simulationState as PackagingMotorState;
      expect(restarted.motorStallForcePn).toBe(57);
      test.press('\u001b[C'); await waitFor(() => usePhageStore.getState().simulationSpeed === 2);
      test.press('.'); await waitFor(() => usePhageStore.getState().simulationState?.time === 2);
      const advanced = usePhageStore.getState().simulationState as PackagingMotorState;
      expect(advanced.bpPackaged).toBe(sim.step(restarted, 2).bpPackaged);
      expect(test.output()).toContain('Nominal ATP');
      expect(test.output()).toMatch(/no per-genome[\s║]*calibration/);
      expect(test.output()).not.toContain('Stall probability');
      test.press('r'); await waitFor(() => usePhageStore.getState().simulationState?.time === 0);
      expect(usePhageStore.getState().simulationState?.params).toEqual(restarted.params);
      test.press('.'); await waitFor(() => usePhageStore.getState().simulationState?.time === 2);
      expect((usePhageStore.getState().simulationState as PackagingMotorState).bpPackaged).toBe(advanced.bpPackaged);
    } finally { test.ui.unmount(); usePhageStore.setState(previous); }
  });

  it('stops playback at completion, ignores resume and further steps, and can reset', async () => {
    const previous = usePhageStore.getState();
    await fixture();
    const initial = makePackagingSimulation().init(null, { genomeKb: 3, capsidRadius: 60, ionic: 200 });
    usePhageStore.setState({ activeSimulationId: 'packaging-motor', simulationState: initial,
      simulationPaused: false, simulationSpeed: 8 });
    const test = terminal(<SimulationView onClose={() => {}} />);
    try {
      await waitFor(test.ready);
      await waitFor(() => (usePhageStore.getState().simulationState as PackagingMotorState).status === 'complete');
      const final = usePhageStore.getState().simulationState as PackagingMotorState;
      expect(final.bpPackaged).toBe(3000);
      expect(usePhageStore.getState().simulationPaused).toBe(true);
      test.press(' '); await flush(); test.press('.'); await flush();
      expect(usePhageStore.getState().simulationState).toBe(final);
      expect(usePhageStore.getState().simulationPaused).toBe(true);
      test.press('r'); await waitFor(() => usePhageStore.getState().simulationState?.time === 0);
      expect((usePhageStore.getState().simulationState as PackagingMotorState).status).toBe('packaging');
    } finally { test.ui.unmount(); usePhageStore.setState(previous); }
  });
});
