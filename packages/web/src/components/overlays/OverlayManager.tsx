/**
 * OverlayManager
 *
 * Orchestrates the rendering of available overlays.
 * Connects overlays to the application state.
 */

import React from 'react';
import type { PhageFull } from '@phage-explorer/core';
import type { PhageRepository } from '../../db';
import { SearchOverlay } from './SearchOverlay';
import { SimulationHub } from './SimulationHub';
import SimulationView from '../SimulationView';
import { TropismOverlay } from './TropismOverlay';

interface OverlayManagerProps {
  repository: PhageRepository | null;
  currentPhage: PhageFull | null;
}

export function OverlayManager({ repository, currentPhage }: OverlayManagerProps): React.ReactElement | null {
  return (
    <>
      <SearchOverlay repository={repository} currentPhage={currentPhage} />
      <TropismOverlay repository={repository} phage={currentPhage} />
      <SimulationHub />
      <SimulationView />
    </>
  );
}

export default OverlayManager;
