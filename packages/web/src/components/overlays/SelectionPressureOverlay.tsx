import React from 'react';
import type { PhageFull } from '@phage-explorer/core';
import type { PhageRepository } from '../../db';
import { Overlay } from './Overlay';
import { useOverlay } from './OverlayProvider';
import { CodonSelectionPanel } from './CodonSelectionPanel';

/** Raw diff genomes are not codon alignments. Keep the canonical entry point,
 * but require explicit homologous CDS input for the actual estimator.
 */
export function SelectionPressureOverlay(_props: { repository: PhageRepository | null; currentPhage: PhageFull | null }): React.ReactElement | null {
  const { isOpen } = useOverlay();
  if (!isOpen('selectionPressure')) return null;
  return <Overlay id="selectionPressure" title="ALIGNED CDS · dN/dS" size="xl"><CodonSelectionPanel /></Overlay>;
}
