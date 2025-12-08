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
  ModuleOverlay,
  WelcomeModal,
  CollaborationOverlay,
  FeatureTour,
} from './index';
import { useOverlay } from './OverlayProvider';
import { useWebPreferences } from '../../store/createWebStore';
import { useEffect } from 'react';

export function OverlayManager(): React.ReactElement {
  // Connect to state
  const currentPhage = usePhageStore(s => s.currentPhage);
  const { open, isOpen } = useOverlay();
  const hasSeenWelcome = useWebPreferences(s => s.hasSeenWelcome);

  // Trigger welcome modal on first run
  useEffect(() => {
    if (!hasSeenWelcome && !isOpen('welcome')) {
      open('welcome', { blocking: true, closeOnBackdrop: false });
    }
  }, [hasSeenWelcome, open, isOpen]);

  const sequence = usePhageStore(s => s.diffReferenceSequence) || '';
  const genomeLength = currentPhage?.genomeLength ?? 0;
  
  return (
    <>
      <WelcomeModal />
      <HelpOverlay />
      <CollaborationOverlay />
      <FeatureTour />
      <CommandPalette onClose={() => {}} /> 
      
      {/* Analysis Overlays */}
      <GCSkewOverlay sequence={sequence} />
      <TranscriptionFlowOverlay sequence={sequence} genomeLength={genomeLength} />
      <ModuleOverlay />
      
      {/* Future: Add other overlays here */}
    </>
  );
}

export default OverlayManager;
