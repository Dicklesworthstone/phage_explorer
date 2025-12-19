/**
 * OverlayManager
 *
 * Orchestrates the rendering of available overlays.
 * Connects overlays to the application state.
 *
 * PERFORMANCE: Heavy analysis overlays are lazy-loaded to reduce initial bundle.
 * Essential overlays (search, command palette, help) remain eager for instant access.
 */

import React, { Suspense, lazy } from 'react';
import type { PhageFull } from '@phage-explorer/core';
import type { PhageRepository } from '../../db';

// ============================================================================
// EAGER-LOADED OVERLAYS (essential for core UX, frequently accessed)
// ============================================================================
import { SearchOverlay } from './SearchOverlay';
import { AnalysisMenu } from './AnalysisMenu';
import { CommandPalette } from './CommandPalette';
import { HelpOverlay } from './HelpOverlay';
import { WelcomeModal } from './WelcomeModal';
import { SettingsOverlay } from './SettingsOverlay';
import { AAKeyOverlay } from './AAKeyOverlay';
import { AALegend } from './AALegend';

// ============================================================================
// LAZY-LOADED OVERLAYS (heavy analysis components, loaded on-demand)
// ============================================================================

// Simulation & Comparison
const SimulationHub = lazy(() => import('./SimulationHub').then(m => ({ default: m.SimulationHub })));
const SimulationView = lazy(() => import('../SimulationView'));
const ComparisonOverlay = lazy(() => import('./ComparisonOverlay').then(m => ({ default: m.ComparisonOverlay })));
const CollaborationOverlay = lazy(() => import('./CollaborationOverlay').then(m => ({ default: m.CollaborationOverlay })));

// Sequence analysis overlays
const GCSkewOverlay = lazy(() => import('./GCSkewOverlay').then(m => ({ default: m.GCSkewOverlay })));
const ComplexityOverlay = lazy(() => import('./ComplexityOverlay').then(m => ({ default: m.ComplexityOverlay })));
const BendabilityOverlay = lazy(() => import('./BendabilityOverlay').then(m => ({ default: m.BendabilityOverlay })));
const PromoterOverlay = lazy(() => import('./PromoterOverlay').then(m => ({ default: m.PromoterOverlay })));
const RepeatsOverlay = lazy(() => import('./RepeatsOverlay').then(m => ({ default: m.RepeatsOverlay })));
const KmerAnomalyOverlay = lazy(() => import('./KmerAnomalyOverlay').then(m => ({ default: m.KmerAnomalyOverlay })));

// Visualization overlays
const CGROverlay = lazy(() => import('./CGROverlay').then(m => ({ default: m.CGROverlay })));
const HilbertOverlay = lazy(() => import('./HilbertOverlay').then(m => ({ default: m.HilbertOverlay })));
const DotPlotOverlay = lazy(() => import('./DotPlotOverlay').then(m => ({ default: m.DotPlotOverlay })));
const SyntenyOverlay = lazy(() => import('./SyntenyOverlay').then(m => ({ default: m.SyntenyOverlay })));
const PhasePortraitOverlay = lazy(() => import('./PhasePortraitOverlay').then(m => ({ default: m.PhasePortraitOverlay })));
const GelOverlay = lazy(() => import('./GelOverlay').then(m => ({ default: m.GelOverlay })));
const LogoOverlay = lazy(() => import('./LogoOverlay').then(m => ({ default: m.LogoOverlay })));
const PeriodicityOverlay = lazy(() => import('./PeriodicityOverlay').then(m => ({ default: m.PeriodicityOverlay })));
const MosaicRadarOverlay = lazy(() => import('./MosaicRadarOverlay').then(m => ({ default: m.MosaicRadarOverlay })));
const IllustrationOverlay = lazy(() => import('./IllustrationOverlay').then(m => ({ default: m.IllustrationOverlay })));

// Genomic analysis overlays
const HGTOverlay = lazy(() => import('./HGTOverlay').then(m => ({ default: m.HGTOverlay })));
const CRISPROverlay = lazy(() => import('./CRISPROverlay').then(m => ({ default: m.CRISPROverlay })));
const NonBDNAOverlay = lazy(() => import('./NonBDNAOverlay').then(m => ({ default: m.NonBDNAOverlay })));
const AnomalyOverlay = lazy(() => import('./AnomalyOverlay').then(m => ({ default: m.AnomalyOverlay })));
const GenomicSignaturePCAOverlay = lazy(() => import('./GenomicSignaturePCAOverlay').then(m => ({ default: m.GenomicSignaturePCAOverlay })));
const ProphageExcisionOverlay = lazy(() => import('./ProphageExcisionOverlay').then(m => ({ default: m.ProphageExcisionOverlay })));

// Codon & protein analysis overlays
const CodonBiasOverlay = lazy(() => import('./CodonBiasOverlay').then(m => ({ default: m.CodonBiasOverlay })));
const CodonAdaptationOverlay = lazy(() => import('./CodonAdaptationOverlay').then(m => ({ default: m.CodonAdaptationOverlay })));
const SelectionPressureOverlay = lazy(() => import('./SelectionPressureOverlay').then(m => ({ default: m.SelectionPressureOverlay })));
const BiasDecompositionOverlay = lazy(() => import('./BiasDecompositionOverlay').then(m => ({ default: m.BiasDecompositionOverlay })));
const ProteinDomainOverlay = lazy(() => import('./ProteinDomainOverlay').then(m => ({ default: m.ProteinDomainOverlay })));
const FoldQuickviewOverlay = lazy(() => import('./FoldQuickviewOverlay').then(m => ({ default: m.FoldQuickviewOverlay })));

// Host & phage interaction overlays
const TropismOverlay = lazy(() => import('./TropismOverlay').then(m => ({ default: m.TropismOverlay })));
const DefenseArmsRaceOverlay = lazy(() => import('./DefenseArmsRaceOverlay').then(m => ({ default: m.DefenseArmsRaceOverlay })));
const AMGPathwayOverlay = lazy(() => import('./AMGPathwayOverlay').then(m => ({ default: m.AMGPathwayOverlay })));

// Structure & stability overlays
const StructureConstraintOverlay = lazy(() => import('./StructureConstraintOverlay').then(m => ({ default: m.StructureConstraintOverlay })));
const VirionStabilityOverlay = lazy(() => import('./VirionStabilityOverlay').then(m => ({ default: m.VirionStabilityOverlay })));
const PackagingPressureOverlay = lazy(() => import('./PackagingPressureOverlay').then(m => ({ default: m.PackagingPressureOverlay })));

// Benchmark & diagnostic
const GpuWasmBenchmarkOverlay = lazy(() => import('./GpuWasmBenchmarkOverlay').then(m => ({ default: m.GpuWasmBenchmarkOverlay })));

interface OverlayManagerProps {
  repository: PhageRepository | null;
  currentPhage: PhageFull | null;
}

/**
 * Suspense fallback - minimal to avoid layout shift
 */
function OverlayFallback(): null {
  return null;
}

export function OverlayManager({ repository, currentPhage }: OverlayManagerProps): React.ReactElement | null {
  return (
    <>
      {/* EAGER: Essential overlays that must be instantly available */}
      <WelcomeModal />
      <HelpOverlay />
      <AnalysisMenu />
      <SearchOverlay repository={repository} currentPhage={currentPhage} />
      <AAKeyOverlay />
      <AALegend />
      <SettingsOverlay />
      <CommandPalette />

      {/* LAZY: Analysis overlays loaded on-demand */}
      <Suspense fallback={<OverlayFallback />}>
        {/* Simulation & Comparison */}
        <SimulationHub />
        <SimulationView />
        <ComparisonOverlay repository={repository} />
        <CollaborationOverlay />

        {/* Sequence analysis */}
        <GCSkewOverlay repository={repository} currentPhage={currentPhage} />
        <ComplexityOverlay repository={repository} currentPhage={currentPhage} />
        <BendabilityOverlay repository={repository} currentPhage={currentPhage} />
        <PromoterOverlay repository={repository} currentPhage={currentPhage} />
        <RepeatsOverlay repository={repository} currentPhage={currentPhage} />
        <KmerAnomalyOverlay repository={repository} currentPhage={currentPhage} />

        {/* Visualizations */}
        <CGROverlay repository={repository} currentPhage={currentPhage} />
        <HilbertOverlay repository={repository} currentPhage={currentPhage} />
        <DotPlotOverlay repository={repository} currentPhage={currentPhage} />
        <SyntenyOverlay repository={repository} currentPhage={currentPhage} />
        <PhasePortraitOverlay repository={repository} currentPhage={currentPhage} />
        <GelOverlay repository={repository} currentPhage={currentPhage} />
        <LogoOverlay repository={repository} currentPhage={currentPhage} />
        <PeriodicityOverlay repository={repository} currentPhage={currentPhage} />
        <MosaicRadarOverlay repository={repository} currentPhage={currentPhage} />
        <IllustrationOverlay />

        {/* Genomic analysis */}
        <HGTOverlay repository={repository} currentPhage={currentPhage} />
        <CRISPROverlay repository={repository} phage={currentPhage} />
        <NonBDNAOverlay repository={repository} currentPhage={currentPhage} />
        <AnomalyOverlay repository={repository} currentPhage={currentPhage} />
        <GenomicSignaturePCAOverlay repository={repository} currentPhage={currentPhage} />
        <ProphageExcisionOverlay repository={repository} currentPhage={currentPhage} />

        {/* Codon & protein */}
        <CodonBiasOverlay repository={repository} currentPhage={currentPhage} />
        <CodonAdaptationOverlay repository={repository} currentPhage={currentPhage} />
        <SelectionPressureOverlay repository={repository} currentPhage={currentPhage} />
        <BiasDecompositionOverlay repository={repository} currentPhage={currentPhage} />
        <ProteinDomainOverlay repository={repository} currentPhage={currentPhage} />
        <FoldQuickviewOverlay repository={repository} currentPhage={currentPhage} />

        {/* Host interactions */}
        <TropismOverlay repository={repository} phage={currentPhage} />
        <DefenseArmsRaceOverlay repository={repository} currentPhage={currentPhage} />
        <AMGPathwayOverlay repository={repository} currentPhage={currentPhage} />

        {/* Structure & stability */}
        <StructureConstraintOverlay repository={repository} currentPhage={currentPhage} />
        <VirionStabilityOverlay />
        <PackagingPressureOverlay />

        {/* Benchmark */}
        <GpuWasmBenchmarkOverlay repository={repository} currentPhage={currentPhage} />
      </Suspense>
    </>
  );
}

export default OverlayManager;
