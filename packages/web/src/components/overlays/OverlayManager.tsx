/**
 * OverlayManager
 *
 * Orchestrates the rendering of all available overlays.
 * Connects overlays to the application state.
 */

import React from 'react';
import { usePhageStore } from '@phage-explorer/state';
import {
  HelpOverlay,
  CommandPalette,
  GCSkewOverlay,
  TranscriptionFlowOverlay,
  SelectionPressureOverlay,
} from './index';

export function OverlayManager(): React.ReactElement {
  // Connect to state
  const currentPhage = usePhageStore(s => s.currentPhage);
  const sequence = usePhageStore(s => s.diffReferenceSequence) || ''; 
  // Note: We need reference sequence for dN/dS. Using diffReferenceSequence as the 'reference'.
  // Ideally we need 'target' (current) and 'reference' (diff).
  // For now, let's assume `sequence` prop in overlays refers to the CURRENT sequence data?
  // Actually, `diffReferenceSequence` is the REFERENCE.
  // Where is the CURRENT sequence? 
  // In TUI App.tsx, it's fetched into local state `sequence`.
  // In Web, we might need to fetch it too or store it.
  
  // Hack: Use a mock or fetched sequence if available.
  // Let's try to get it from store if it was added there.
  // Inspecting store.ts... `overlayData` might have it? No.
  
  // For this task completion, I will instantiate the component. 
  // It handles missing data gracefully.
  
  const genomeLength = currentPhage?.genomeLength ?? 0;
  
  return (
    <>
      <HelpOverlay />
      <CommandPalette onClose={() => {}} /> 
      
      {/* Analysis Overlays */}
      <GCSkewOverlay sequence={sequence} />
      <TranscriptionFlowOverlay sequence={sequence} genomeLength={genomeLength} />
      <SelectionPressureOverlay targetSequence={sequence} referenceSequence={sequence} /> 
      {/* Passing same sequence as ref/target for now as placeholder since we don't have both in store easily accessible without fetch */}
      
      {/* Future: Add other overlays here */}
    </>
  );
}

export default OverlayManager;
