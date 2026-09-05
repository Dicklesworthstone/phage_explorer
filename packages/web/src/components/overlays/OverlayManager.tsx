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
import { useOverlay, type OverlayId } from './OverlayProvider';
import { ActionRegistryList } from '../../keyboard/actionRegistry';
import { Overlay } from './Overlay';
import ErrorBoundary from '../layout/ErrorBoundary';

let overlayTitleById: Map<string, string> | null = null;
function getOverlayTitleMap(): Map<string, string> {
  if (!overlayTitleById) {
    overlayTitleById = new Map<string, string>();
    for (const action of ActionRegistryList) {
      if (action.overlayId && action.overlayAction) {
        overlayTitleById.set(action.overlayId, action.title);
      }
    }
  }
  return overlayTitleById;
}

function formatOverlayTitle(id: OverlayId): string {
  return getOverlayTitleMap().get(id) ?? id;
}

// ============================================================================
// EAGER-LOADED OVERLAYS (essential for core UX, frequently accessed)
// ============================================================================
import { SearchOverlay } from './SearchOverlay';
import { AnalysisMenu } from './AnalysisMenu';
import { CommandPalette } from './CommandPalette';
import { HelpOverlay } from './HelpOverlay';
import { WelcomeModal } from './WelcomeModal';
import { SettingsOverlay } from './SettingsOverlay';
import { GotoOverlay } from './GotoOverlay';
import { AAKeyOverlay } from './AAKeyOverlay';
import { AALegend } from './AALegend';
import { FeatureTour } from './FeatureTour';

// ============================================================================
// LAZY-LOADED OVERLAYS (heavy analysis components, loaded on-demand)
// ============================================================================

// Simulation & Comparison
const SimulationHub = lazy(() => import('./SimulationHub').then(m => ({ default: m.SimulationHub })));
const SimulationView = lazy(() => import('../SimulationView'));
const ComparisonOverlay = lazy(() => import('./ComparisonOverlay').then(m => ({ default: m.ComparisonOverlay })));
const GenomeImportOverlay = lazy(() => import('./GenomeImportOverlay').then(m => ({ default: m.GenomeImportOverlay })));
const CollaborationOverlay = lazy(() => import('./CollaborationOverlay').then(m => ({ default: m.CollaborationOverlay })));
const ResistanceEvolutionOverlay = lazy(() => import('./ResistanceEvolutionOverlay').then(m => ({ default: m.ResistanceEvolutionOverlay })));

// Sequence analysis overlays
const GCSkewOverlay = lazy(() => import('./GCSkewOverlay').then(m => ({ default: m.GCSkewOverlay })));
const ComplexityOverlay = lazy(() => import('./ComplexityOverlay').then(m => ({ default: m.ComplexityOverlay })));
const BendabilityOverlay = lazy(() => import('./BendabilityOverlay').then(m => ({ default: m.BendabilityOverlay })));
const PromoterOverlay = lazy(() => import('./PromoterOverlay').then(m => ({ default: m.PromoterOverlay })));
const RepeatsOverlay = lazy(() => import('./RepeatsOverlay').then(m => ({ default: m.RepeatsOverlay })));
const KmerAnomalyOverlay = lazy(() => import('./KmerAnomalyOverlay').then(m => ({ default: m.KmerAnomalyOverlay })));
const TranscriptionFlowOverlay = lazy(() => import('./TranscriptionFlowOverlay').then(m => ({ default: m.TranscriptionFlowOverlay })));

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
const LatentSpaceAtlasOverlay = lazy(() => import('./LatentSpaceAtlasOverlay').then(m => ({ default: m.LatentSpaceAtlasOverlay })));
const RNAStructureOverlay = lazy(() => import('./RNAStructureOverlay').then(m => ({ default: m.RNAStructureOverlay })));

// Host & phage interaction overlays
const TropismOverlay = lazy(() => import('./TropismOverlay').then(m => ({ default: m.TropismOverlay })));
const DefenseArmsRaceOverlay = lazy(() => import('./DefenseArmsRaceOverlay').then(m => ({ default: m.DefenseArmsRaceOverlay })));
const AMGPathwayOverlay = lazy(() => import('./AMGPathwayOverlay').then(m => ({ default: m.AMGPathwayOverlay })));
const HostInteractionOverlay = lazy(() => import('./HostInteractionOverlay').then(m => ({ default: m.HostInteractionOverlay })));
const CocktailCompatibilityOverlay = lazy(() => import('./CocktailCompatibilityOverlay').then(m => ({ default: m.CocktailCompatibilityOverlay })));

// Structure & stability overlays
const StructureConstraintOverlay = lazy(() => import('./StructureConstraintOverlay').then(m => ({ default: m.StructureConstraintOverlay })));
const VirionStabilityOverlay = lazy(() => import('./VirionStabilityOverlay').then(m => ({ default: m.VirionStabilityOverlay })));
const PackagingPressureOverlay = lazy(() => import('./PackagingPressureOverlay').then(m => ({ default: m.PackagingPressureOverlay })));

// Module analysis overlays
const ModuleOverlay = lazy(() => import('./ModuleOverlay').then(m => ({ default: m.ModuleOverlay })));

// Epistasis & fitness landscape
const EpistasisOverlay = lazy(() => import('./EpistasisOverlay').then(m => ({ default: m.EpistasisOverlay })));

// Benchmark & diagnostic
const GpuWasmBenchmarkOverlay = lazy(() => import('./GpuWasmBenchmarkOverlay').then(m => ({ default: m.GpuWasmBenchmarkOverlay })));

// Metagenomic niche analysis
const NicheNetworkOverlay = lazy(() => import('./NicheNetworkOverlay').then(m => ({ default: m.NicheNetworkOverlay })));

// Phylodynamic trajectory analysis
const PhylodynamicsOverlay = lazy(() => import('./PhylodynamicsOverlay').then(m => ({ default: m.PhylodynamicsOverlay })));

// Environmental provenance analysis
const EnvironmentalProvenanceOverlay = lazy(() => import('./EnvironmentalProvenanceOverlay').then(m => ({ default: m.EnvironmentalProvenanceOverlay })));

// Pan-Phage Graph Pangenome & Variant Cards (Roadmap Top-10 #3)
const PangenomeGraphOverlay = lazy(() => import('./PangenomeGraphOverlay').then(m => ({ default: m.PangenomeGraphOverlay })));

interface OverlayManagerProps {
  onSelectPhage: (index: number) => Promise<void>;
  reloadDatabase: () => Promise<void>;
  databaseFetching: boolean;
  repository: PhageRepository | null;
  currentPhage: PhageFull | null;
}

/**
 * Suspense fallback - show an instant shell so opening an overlay always feels responsive
 */
function OverlayFallback({ id }: { id: OverlayId }): React.ReactElement {
  const { isMobile } = useOverlay();
  // On mobile, prefer a half-height sheet during the load to avoid covering the entire UI.
  const size = isMobile ? 'sm' : 'lg';
  return (
    <Overlay id={id} title={formatOverlayTitle(id)} size={size}>
      <div aria-busy="true" aria-label="Loading overlay" style={{ display: 'flex', flexDirection: 'column', gap: 'var(--space-4)' }}>
        <div className="skeleton skeleton-text skeleton--pulse" style={{ width: '44%' }} />
        <div className="skeleton skeleton-text skeleton--pulse" style={{ width: '76%' }} />
        <div className="skeleton skeleton-card skeleton--pulse" />
      </div>
    </Overlay>
  );
}

/**
 * Simple error fallback that doesn't depend on the Overlay/BottomSheet components.
 * This ensures the fallback renders even if mobile sheet rendering is broken.
 */
function SimpleOverlayErrorFallback({
  id,
  error,
  errorInfo,
  reset,
  close,
}: {
  id: OverlayId;
  error: Error | null;
  errorInfo: React.ErrorInfo | null;
  reset: () => void;
  close: () => void;
}): React.ReactElement {
  return (
    <div
      style={{
        position: 'fixed',
        inset: 0,
        zIndex: 600,
        display: 'flex',
        alignItems: 'center',
        justifyContent: 'center',
        backgroundColor: 'rgba(0, 0, 0, 0.7)',
        padding: '1rem',
      }}
      onClick={(e) => {
        if (e.target === e.currentTarget) close();
      }}
    >
      <div
        style={{
          backgroundColor: 'var(--color-background-elevated, #1a1a2e)',
          borderRadius: '8px',
          padding: '1.5rem',
          maxWidth: '400px',
          width: '100%',
          color: 'var(--color-text, #e0e0e0)',
        }}
      >
        <h3 style={{ margin: '0 0 1rem', color: 'var(--color-error, #ef4444)' }}>
          {formatOverlayTitle(id)} Error
        </h3>
        <p style={{ margin: '0 0 1rem', fontSize: '0.9rem', opacity: 0.8 }}>
          This overlay encountered an error and couldn&apos;t load.
        </p>
        {import.meta.env.DEV && (error || errorInfo) && (
          <details style={{ marginBottom: '1rem', fontSize: '0.8rem' }}>
            <summary style={{ cursor: 'pointer', opacity: 0.7 }}>Error details</summary>
            <pre style={{ overflow: 'auto', maxHeight: '150px', marginTop: '0.5rem', fontSize: '0.75rem' }}>
              {formatOverlayErrorDetails(error, errorInfo)}
            </pre>
          </details>
        )}
        <div style={{ display: 'flex', gap: '0.5rem', justifyContent: 'flex-end' }}>
          <button
            type="button"
            onClick={close}
            style={{
              padding: '0.5rem 1rem',
              border: '1px solid var(--color-border, #333)',
              borderRadius: '4px',
              background: 'transparent',
              color: 'inherit',
              cursor: 'pointer',
            }}
          >
            Close
          </button>
          <button
            type="button"
            onClick={reset}
            style={{
              padding: '0.5rem 1rem',
              border: 'none',
              borderRadius: '4px',
              background: 'var(--color-primary, #3b82f6)',
              color: 'white',
              cursor: 'pointer',
            }}
          >
            Retry
          </button>
        </div>
      </div>
    </div>
  );
}

/**
 * Wrapper for eager overlays - provides isolated error handling so a single
 * overlay crash doesn't take down the whole app.
 *
 * Uses SimpleOverlayErrorFallback instead of Overlay to avoid cascading failures
 * if the Overlay/BottomSheet component itself is the source of the error.
 */
function EagerOverlayBoundary({
  id,
  children,
}: {
  id: OverlayId;
  children: React.ReactNode;
}): React.ReactElement {
  const { close } = useOverlay();
  return (
    <ErrorBoundary
      fallback={({ error, errorInfo, reset }) => (
        <SimpleOverlayErrorFallback
          id={id}
          error={error}
          errorInfo={errorInfo}
          reset={reset}
          close={() => close(id)}
        />
      )}
    >
      {children}
    </ErrorBoundary>
  );
}

/**
 * Wrapper for lazy overlays - same error isolation as EagerOverlayBoundary.
 */
function LazyOverlayBoundary({
  id,
  children,
}: {
  id: OverlayId;
  children: React.ReactNode;
}): React.ReactElement {
  const { close } = useOverlay();
  return (
    <ErrorBoundary
      fallback={({ error, errorInfo, reset }) => (
        <SimpleOverlayErrorFallback
          id={id}
          error={error}
          errorInfo={errorInfo}
          reset={reset}
          close={() => close(id)}
        />
      )}
    >
      {children}
    </ErrorBoundary>
  );
}

export function OverlayManager({ repository, currentPhage, reloadDatabase, databaseFetching, onSelectPhage }: OverlayManagerProps): React.ReactElement | null {
  const { stack } = useOverlay();

  const lazyOverlays = stack
    .map((item) => item.id)
    .map((id) => {
      return {
        id,
        element: renderLazyOverlay(id, repository, currentPhage),
      };
    })
    .filter((entry): entry is { id: OverlayId; element: React.ReactElement } => Boolean(entry.element));

  return (
    <>
      {/* EAGER: Essential overlays that must be instantly available */}
      {/* Wrapped in ErrorBoundary to isolate failures on mobile where
          BottomSheet rendering can encounter device-specific issues */}
      <EagerOverlayBoundary id="welcome"><WelcomeModal /></EagerOverlayBoundary>
      <EagerOverlayBoundary id="help"><HelpOverlay /></EagerOverlayBoundary>
      <EagerOverlayBoundary id="analysisMenu"><AnalysisMenu /></EagerOverlayBoundary>
      <EagerOverlayBoundary id="search"><SearchOverlay repository={repository} currentPhage={currentPhage} /></EagerOverlayBoundary>
      <EagerOverlayBoundary id="goto"><GotoOverlay /></EagerOverlayBoundary>
      <EagerOverlayBoundary id="aaKey"><AAKeyOverlay /></EagerOverlayBoundary>
      <EagerOverlayBoundary id="aaLegend"><AALegend /></EagerOverlayBoundary>
      <EagerOverlayBoundary id="settings"><SettingsOverlay reloadDatabase={reloadDatabase} databaseFetching={databaseFetching} /></EagerOverlayBoundary>
      <EagerOverlayBoundary id="commandPalette"><CommandPalette repository={repository} onSelectPhage={onSelectPhage} /></EagerOverlayBoundary>
      <EagerOverlayBoundary id="tour"><FeatureTour /></EagerOverlayBoundary>

      {/* LAZY: Analysis overlays loaded only when open */}
      {lazyOverlays.map(({ id, element }) => (
        <LazyOverlayBoundary key={id} id={id}>
          <Suspense fallback={<OverlayFallback id={id} />}>{element}</Suspense>
        </LazyOverlayBoundary>
      ))}
    </>
  );
}

export default OverlayManager;

function renderLazyOverlay(
  id: OverlayId,
  repository: PhageRepository | null,
  currentPhage: PhageFull | null
): React.ReactElement | null {
  if (currentPhage?.localGenome && (id === 'phylodynamics' || id === 'environmentalProvenance')) {
    return <Overlay id={id} title={formatOverlayTitle(id)} size="lg"><p>Reference data unavailable for this local genome. Its name and sequence are not sent to external reference services. Sequence analyses remain available.</p></Overlay>;
  }
  switch (id) {
    case 'genomeImport':
      return <GenomeImportOverlay />;
    // Simulation & comparison
    case 'simulationHub':
      return <SimulationHub />;
    case 'simulationView':
      return <SimulationView />;
    case 'comparison':
      return <ComparisonOverlay repository={repository} />;
    case 'collaboration':
      return <CollaborationOverlay />;
    case 'resistanceEvolution':
      return <ResistanceEvolutionOverlay />;

    // Sequence analysis
    case 'gcSkew':
      return <GCSkewOverlay repository={repository} currentPhage={currentPhage} />;
    case 'complexity':
      return <ComplexityOverlay repository={repository} currentPhage={currentPhage} />;
    case 'bendability':
      return <BendabilityOverlay repository={repository} currentPhage={currentPhage} />;
    case 'promoter':
      return <PromoterOverlay repository={repository} currentPhage={currentPhage} />;
    case 'repeats':
      return <RepeatsOverlay repository={repository} currentPhage={currentPhage} />;
    case 'kmerAnomaly':
      return <KmerAnomalyOverlay repository={repository} currentPhage={currentPhage} />;
    case 'transcriptionFlow':
      return <TranscriptionFlowOverlay repository={repository} currentPhage={currentPhage} />;

    // Visualizations
    case 'cgr':
      return <CGROverlay repository={repository} currentPhage={currentPhage} />;
    case 'hilbert':
      return <HilbertOverlay repository={repository} currentPhage={currentPhage} />;
    case 'dotPlot':
      return <DotPlotOverlay repository={repository} currentPhage={currentPhage} />;
    case 'synteny':
      return <SyntenyOverlay repository={repository} currentPhage={currentPhage} />;
    case 'phasePortrait':
      return <PhasePortraitOverlay repository={repository} currentPhage={currentPhage} />;
    case 'gel':
      return <GelOverlay repository={repository} currentPhage={currentPhage} />;
    case 'logo':
      return <LogoOverlay repository={repository} currentPhage={currentPhage} />;
    case 'periodicity':
      return <PeriodicityOverlay repository={repository} currentPhage={currentPhage} />;
    case 'mosaicRadar':
      return <MosaicRadarOverlay repository={repository} currentPhage={currentPhage} />;
    case 'illustration':
      return <IllustrationOverlay />;

    // Genomic analysis
    case 'hgt':
      return <HGTOverlay repository={repository} currentPhage={currentPhage} />;
    case 'crispr':
      return <CRISPROverlay repository={repository} phage={currentPhage} />;
    case 'nonBDNA':
      return <NonBDNAOverlay repository={repository} currentPhage={currentPhage} />;
    case 'anomaly':
      return <AnomalyOverlay repository={repository} currentPhage={currentPhage} />;
    case 'genomicSignaturePCA':
      return <GenomicSignaturePCAOverlay repository={repository} currentPhage={currentPhage} />;
    case 'prophageExcision':
      return <ProphageExcisionOverlay repository={repository} currentPhage={currentPhage} />;

    // Codon & protein
    case 'codonBias':
      return <CodonBiasOverlay repository={repository} currentPhage={currentPhage} />;
    case 'codonAdaptation':
      return <CodonAdaptationOverlay repository={repository} currentPhage={currentPhage} />;
    case 'selectionPressure':
      return <SelectionPressureOverlay repository={repository} currentPhage={currentPhage} />;
    case 'biasDecomposition':
      return <BiasDecompositionOverlay repository={repository} currentPhage={currentPhage} />;
    case 'proteinDomains':
      return <ProteinDomainOverlay repository={repository} currentPhage={currentPhage} />;
    case 'foldQuickview':
      return <FoldQuickviewOverlay repository={repository} currentPhage={currentPhage} />;
    case 'latentSpaceAtlas':
      return <LatentSpaceAtlasOverlay repository={repository} currentPhage={currentPhage} />;
    case 'rnaStructure':
      return <RNAStructureOverlay repository={repository} currentPhage={currentPhage} />;

    // Host interactions
    case 'tropism':
      return <TropismOverlay repository={repository} phage={currentPhage} />;
    case 'defenseArmsRace':
      return <DefenseArmsRaceOverlay repository={repository} currentPhage={currentPhage} />;
    case 'amgPathway':
      return <AMGPathwayOverlay repository={repository} currentPhage={currentPhage} />;
    case 'cocktailCompatibility':
      return <CocktailCompatibilityOverlay repository={repository} currentPhage={currentPhage} />;

    // Structure & stability
    case 'structureConstraint':
      return <StructureConstraintOverlay repository={repository} currentPhage={currentPhage} />;
    case 'stability':
      return <VirionStabilityOverlay />;
    case 'pressure':
      return <PackagingPressureOverlay />;

    // Module analysis
    case 'modules':
      return <ModuleOverlay repository={repository} currentPhage={currentPhage} />;

    // Epistasis & fitness landscape
    case 'epistasis':
      return <EpistasisOverlay repository={repository} currentPhage={currentPhage} />;

    // Benchmark & diagnostic
    case 'gpuWasmBenchmark':
      return <GpuWasmBenchmarkOverlay repository={repository} currentPhage={currentPhage} />;

    // Metagenomic niche analysis
    case 'nicheNetwork':
      return <NicheNetworkOverlay />;

    // Phylodynamic trajectory analysis
    case 'phylodynamics':
      return <PhylodynamicsOverlay repository={repository} currentPhage={currentPhage} />;

    // Environmental provenance analysis
    case 'environmentalProvenance':
      return <EnvironmentalProvenanceOverlay repository={repository} currentPhage={currentPhage} />;

    // Host-Phage Interaction & Effector Docking Map (Roadmap #35)
    case 'hostInteractions':
      return <HostInteractionOverlay />;

    // Pan-Phage Graph Pangenome & Variant Cards (Roadmap Top-10 #3)
    case 'pangenomeGraph':
      return <PangenomeGraphOverlay />;

    // Feature Tour Onboarding
    case 'tour':
      return <FeatureTour />;

    default:
      return null;
  }
}

function formatOverlayErrorDetails(error: Error | null, errorInfo: React.ErrorInfo | null): string {
  const message = error ? error.toString() : 'Unknown error';
  const stack = errorInfo?.componentStack?.trim();
  if (!stack) return message;
  return `${message}\n${stack}`;
}
