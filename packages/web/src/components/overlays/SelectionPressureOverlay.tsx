import React from 'react';
import type { PhageFull } from '@phage-explorer/core';
import type { PhageRepository } from '../../db';
import { Overlay } from './Overlay';
import { useOverlay } from './OverlayProvider';
import { CodonSelectionPanel } from './CodonSelectionPanel';
import { HowDoIKnowThis } from './primitives/HowDoIKnowThis';

/** Raw diff genomes are not codon alignments. Keep the canonical entry point,
 * but require explicit homologous CDS input for the actual estimator.
 */
export function SelectionPressureOverlay(_props: { repository: PhageRepository | null; currentPhage: PhageFull | null }): React.ReactElement | null {
  const { isOpen } = useOverlay();
  if (!isOpen('selectionPressure')) return null;
  return <Overlay id="selectionPressure" title="ALIGNED CDS · dN/dS" size="xl">
    <HowDoIKnowThis
      title="Aligned coding-sequence dN/dS"
      computation="NG86-style equal codon opportunities and mean sense-only shortest paths; counts are pooled before JC69 correction. No selection-significance test is fitted."
      inputs={[
        { label: 'Required input', value: 'User-supplied homologous codon alignment in coding 5′→3′ orientation.' },
        { label: 'Accepted inputs and settings', value: 'Inspect the coding panel and exported analysis record for the actual alignment, genetic code, interval and deletion masks.' },
      ]}
      implementation={{ engine: 'JavaScript', details: 'Coding-alignment worker with explicit genetic code and deletion masks.' }}
      citation={`Phage Explorer estimates coding-sequence dN/dS using NG86-style equal opportunities, mean sense-only shortest paths and pooled JC69 correction. Inputs are explicitly aligned homologous coding sequences with a declared genetic code. These descriptive ratios are not selection-significance tests.`}
    />
    <CodonSelectionPanel />
  </Overlay>;
}
