import { describe, expect, it } from 'bun:test';
import React from 'react';
import { render, renderToString } from 'ink';
import { PassThrough, Writable } from 'node:stream';
import { stripVTControlCharacters } from 'node:util';
import { importLocalGenomes, ribosomeTrafficSimulation, type RibosomeTrafficState } from '@phage-explorer/core';
import { usePhageStore } from '@phage-explorer/state';
import { SimulationHubOverlay } from './SimulationHubOverlay';
import { SimulationView } from './SimulationView';
import { RibosomeTrafficView } from './RibosomeTrafficView';

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
