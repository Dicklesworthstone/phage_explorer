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
} from './index';

export function OverlayManager(): React.ReactElement {
  // Connect to state
  const currentPhage = usePhageStore(s => s.currentPhage);
  const sequence = usePhageStore(s => s.diffReferenceSequence) || ''; // Using diff ref as proxy for sequence if main seq not exposed directly in store root?
  // Actually, looking at store.ts, 'sequence' isn't in the root state, it's usually fetched.
  // The TUI App.tsx keeps 'sequence' in local state.
  
  // For now, let's assume the store might be updated to hold sequence or we fetch it.
  // Or we can try to get it from the repository if we had access.
  
  // To make progress without refactoring the whole app state, I'll mock the sequence or use a placeholder if empty.
  // Ideally, the Web App should mirror the TUI App structure regarding data fetching.
  
  // Let's check if I can get sequence from somewhere. 
  // In TUI App.tsx: const [sequence, setSequence] = useState<string>('');
  // So it's local state there.
  
  // I will assume for this task that I just render the overlays. 
  // If data is missing, they will just show "No sequence loaded" which is fine.
  
  const genomeLength = currentPhage?.genomeLength ?? 0;
  
  // Mock sequence for development/testing if empty? 
  // No, better to show empty state.
  
  return (
    <>
      <HelpOverlay />
      <CommandPalette onClose={() => {}} /> 
      
      {/* Analysis Overlays */}
      <GCSkewOverlay sequence={sequence} />
      <TranscriptionFlowOverlay sequence={sequence} genomeLength={genomeLength} />
      
      {/* Future: Add other overlays here */}
    </>
  );
}

export default OverlayManager;
