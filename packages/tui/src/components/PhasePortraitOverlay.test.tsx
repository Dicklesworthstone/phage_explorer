import { describe, expect, it } from 'bun:test';
import React from 'react';
import { renderToString } from 'ink';
import { stripVTControlCharacters } from 'node:util';
import { importLocalGenomes } from '@phage-explorer/core';
import { usePhageStore } from '@phage-explorer/state';
import { PhasePortraitOverlay } from './PhasePortraitOverlay';

describe('terminal exact-CDS phase portrait', () => {
  it('shows the reconstructed reverse, joined, recoded CDS and its short-protein state', async () => {
    const { genomes } = await importLocalGenomes({
      name: 'joined.gb',
      text: 'LOCUS       JOINED 14 bp DNA linear\nFEATURES             Location/Qualifiers\n' +
        '     gene            1..14\n     CDS             complement(join(1..7,12..14))\n' +
        '                     /locus_tag="recoded"\n                     /codon_start=2\n' +
        '                     /transl_table=15\n                     /translation="MQ"\n' +
        'ORIGIN\n        1 ttactacggggatt\n//\n',
    });
    const previous = usePhageStore.getState();
    try {
      usePhageStore.setState({ currentPhage: genomes[0].phage });
      const output = stripVTControlCharacters(renderToString(
        React.createElement(PhasePortraitOverlay, { sequence: genomes[0].sequence }), { columns: 120 },
      ));
      expect(output).toContain('CDS 1/1');
      expect(output).toContain('2 aa');
      expect(output).toContain('NCBI table 15');
      expect(output).toContain('codon_start 2');
      expect(output).toContain('Protein is shorter than the selected window');
      expect(output).not.toContain('CDS unavailable');
    } finally { usePhageStore.setState(previous); }
  });

  it('does not translate an unannotated genome as a protein', async () => {
    const { genomes } = await importLocalGenomes({ name: 'unannotated.fa', text: '>raw\n' + 'ATG'.repeat(50) });
    const previous = usePhageStore.getState();
    try {
      usePhageStore.setState({ currentPhage: genomes[0].phage });
      const output = stripVTControlCharacters(renderToString(
        React.createElement(PhasePortraitOverlay, { sequence: genomes[0].sequence }), { columns: 120 },
      ));
      expect(output).toContain('No annotated CDS is available');
      expect(output).toContain('0 aa');
      expect(output).not.toContain('50 aa');
    } finally { usePhageStore.setState(previous); }
  });
});
