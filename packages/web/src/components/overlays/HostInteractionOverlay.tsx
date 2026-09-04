import React, { useMemo, useState } from 'react';
import { useHotkey } from '../../hooks';
import { useTheme } from '../../hooks/useTheme';
import { ActionIds } from '../../keyboard';
import { Overlay } from './Overlay';
import { useOverlay } from './OverlayProvider';
import { usePhageStore } from '../../store';
import {
  analyzeHostInteractions,
  type PredictedHostInteraction,
  type InteractionFunctionalRole,
} from '@phage-explorer/core';
import {
  OverlayDescription,
  OverlayEmptyState,
  OverlaySection,
  OverlaySectionHeader,
  OverlayStack,
  OverlayStatCard,
  OverlayStatGrid,
} from './primitives';

const ROLE_COLORS: Record<InteractionFunctionalRole, string> = {
  'receptor-binding': '#10b981', // Emerald
  'anti-defense': '#ef4444',     // Rose
  'transcription-takeover': '#f59e0b', // Amber
  'metabolic-reprogramming': '#8b5cf6', // Purple
  'translation-hijacking': '#06b6d4',  // Cyan
};

const ROLE_LABELS: Record<InteractionFunctionalRole, string> = {
  'receptor-binding': 'Receptor Binding',
  'anti-defense': 'Anti-Defense',
  'transcription-takeover': 'Transcription Takeover',
  'metabolic-reprogramming': 'Metabolic Reprogramming',
  'translation-hijacking': 'Translation Hijacking',
};

export function HostInteractionOverlay(): React.ReactElement | null {
  const { isOpen, toggle } = useOverlay();
  const { theme } = useTheme();
  const colors = theme.colors;
  const phage = usePhageStore((s) => s.currentPhage);

  // Keyboard shortcut toggle: Alt+I
  useHotkey(ActionIds.OverlayHostInteractions, () => toggle('hostInteractions'));

  const [activeRoleFilter, setActiveRoleFilter] = useState<InteractionFunctionalRole | 'all'>('all');
  const [selectedOrganism, setSelectedOrganism] = useState<string>('all');
  const [minConfidenceCutoff, setMinConfidenceCutoff] = useState<number>(0.35);
  const [selectedInteractionId, setSelectedInteractionId] = useState<string | null>(null);

  // Run core multi-evidence analysis
  const analysisResult = useMemo(() => {
    if (!phage) return null;
    return analyzeHostInteractions(phage, undefined, {
      hostOrganism: selectedOrganism === 'all' ? undefined : selectedOrganism,
      minConfidence: minConfidenceCutoff,
    });
  }, [phage, selectedOrganism, minConfidenceCutoff]);

  // Filter interactions based on active tab
  const filteredInteractions = useMemo(() => {
    if (!analysisResult) return [];
    if (activeRoleFilter === 'all') return analysisResult.interactions;
    return analysisResult.interactions.filter((i) => i.functionalRole === activeRoleFilter);
  }, [analysisResult, activeRoleFilter]);

  // Selected interaction detail
  const selectedInteraction: PredictedHostInteraction | null = useMemo(() => {
    if (!filteredInteractions || filteredInteractions.length === 0) return null;
    if (selectedInteractionId) {
      const hit = filteredInteractions.find((i) => i.id === selectedInteractionId);
      if (hit) return hit;
    }
    return filteredInteractions[0] ?? null;
  }, [filteredInteractions, selectedInteractionId]);

  if (!isOpen('hostInteractions')) return null;

  if (!phage) {
    return (
      <Overlay
        id="hostInteractions"
        title="Host–Phage Protein Interaction & Effector Docking Map"
        size="lg"
      >
        <OverlayEmptyState
          message="Select a bacteriophage from the sidebar or catalog to view its host effector interactions."
        />
      </Overlay>
    );
  }

  if (!analysisResult || analysisResult.totalInteractions === 0) {
    return (
      <Overlay
        id="hostInteractions"
        title={`Host–Phage Interactions: ${phage.name}`}
        size="lg"
      >
        <OverlayDescription title="Roadmap #35: Multi-Evidence Host-Phage Interaction Network">
          Fuses protein language model embeddings (ESM-2), curated domain interaction priors (iPfam/3did), and structural surface docking complementarity to identify viral effectors targeting bacterial host machinery.
        </OverlayDescription>
        <OverlayEmptyState
          message="No effector interactions exceeded the current confidence threshold. Try lowering the confidence slider or switching host organisms."
        />
      </Overlay>
    );
  }

  return (
    <Overlay
      id="hostInteractions"
      title={`Host–Phage Interaction & Effector Docking Map: ${phage.name}`}
      size="lg"
    >
      <OverlayStack gap="md">
        <OverlayDescription title="Multi-Evidence Bayesian Effector Docking Network">
          {analysisResult.summary}
        </OverlayDescription>

        {/* Global Network Stat Cards */}
        <OverlayStatGrid columns={4}>
          <OverlayStatCard
            label="Total Interactions"
            value={
              <div>
                <div>{analysisResult.totalInteractions}</div>
                <div style={{ fontSize: '0.65rem', color: colors.textDim, fontWeight: 'normal' }}>
                  {analysisResult.interactionsByEvidence.high} high · {analysisResult.interactionsByEvidence.medium} med
                </div>
              </div>
            }
          />
          <OverlayStatCard
            label="Receptor Binding (Tropism)"
            value={
              <div>
                <div>{analysisResult.interactionsByRole['receptor-binding']}</div>
                <div style={{ fontSize: '0.65rem', color: colors.textDim, fontWeight: 'normal' }}>Porins & surface channels</div>
              </div>
            }
          />
          <OverlayStatCard
            label="Anti-Defense Evasion"
            value={
              <div>
                <div>{analysisResult.interactionsByRole['anti-defense']}</div>
                <div style={{ fontSize: '0.65rem', color: colors.textDim, fontWeight: 'normal' }}>CRISPR / R-M inhibitors</div>
              </div>
            }
          />
          <OverlayStatCard
            label="Transcription Takeover"
            value={
              <div>
                <div>{analysisResult.interactionsByRole['transcription-takeover']}</div>
                <div style={{ fontSize: '0.65rem', color: colors.textDim, fontWeight: 'normal' }}>Host RNA pol & sigma</div>
              </div>
            }
          />
        </OverlayStatGrid>

        {/* Filter Controls Bar */}
        <div
          style={{
            display: 'flex',
            flexWrap: 'wrap',
            alignItems: 'center',
            justifyContent: 'space-between',
            gap: '0.75rem',
            padding: '0.6rem 0.8rem',
            backgroundColor: colors.backgroundAlt,
            borderRadius: '6px',
            border: `1px solid ${colors.borderLight}`,
          }}
        >
          {/* Functional Role Tabs */}
          <div style={{ display: 'flex', flexWrap: 'wrap', gap: '0.35rem' }}>
            <button
              type="button"
              onClick={() => setActiveRoleFilter('all')}
              style={{
                padding: '4px 10px',
                fontSize: '0.75rem',
                fontWeight: activeRoleFilter === 'all' ? 700 : 500,
                backgroundColor: activeRoleFilter === 'all' ? colors.primary : 'transparent',
                color: activeRoleFilter === 'all' ? '#fff' : colors.textMuted,
                border: `1px solid ${activeRoleFilter === 'all' ? colors.primary : colors.borderLight}`,
                borderRadius: '4px',
                cursor: 'pointer',
              }}
            >
              All ({analysisResult.totalInteractions})
            </button>

            {(['receptor-binding', 'anti-defense', 'transcription-takeover', 'metabolic-reprogramming'] as InteractionFunctionalRole[]).map((role) => (
              <button
                key={role}
                type="button"
                onClick={() => setActiveRoleFilter(role)}
                style={{
                  padding: '4px 10px',
                  fontSize: '0.75rem',
                  fontWeight: activeRoleFilter === role ? 700 : 500,
                  backgroundColor: activeRoleFilter === role ? `${ROLE_COLORS[role]}25` : 'transparent',
                  color: activeRoleFilter === role ? ROLE_COLORS[role] : colors.textMuted,
                  border: `1px solid ${activeRoleFilter === role ? ROLE_COLORS[role] : colors.borderLight}`,
                  borderRadius: '4px',
                  cursor: 'pointer',
                }}
              >
                {ROLE_LABELS[role]} ({analysisResult.interactionsByRole[role]})
              </button>
            ))}
          </div>

          {/* Controls: Host filter and Confidence slider */}
          <div style={{ display: 'flex', alignItems: 'center', gap: '1rem' }}>
            <div style={{ display: 'flex', alignItems: 'center', gap: '0.4rem', fontSize: '0.75rem', color: colors.textMuted }}>
              <span>Host Target:</span>
              <select
                value={selectedOrganism}
                onChange={(e) => setSelectedOrganism(e.target.value)}
                style={{
                  backgroundColor: colors.background,
                  color: colors.text,
                  border: `1px solid ${colors.borderLight}`,
                  borderRadius: '4px',
                  padding: '2px 6px',
                  fontSize: '0.75rem',
                }}
              >
                <option value="all">All Bacterial Hosts</option>
                <option value="Escherichia coli">E. coli K-12</option>
                <option value="Pseudomonas aeruginosa">P. aeruginosa PAO1</option>
              </select>
            </div>

            <div style={{ display: 'flex', alignItems: 'center', gap: '0.5rem', fontSize: '0.75rem', color: colors.textMuted }}>
              <span>Min Confidence:</span>
              <input
                type="range"
                min="0.30"
                max="0.85"
                step="0.05"
                value={minConfidenceCutoff}
                onChange={(e) => setMinConfidenceCutoff(parseFloat(e.target.value))}
                style={{ width: '80px' }}
              />
              <span style={{ fontWeight: 600, color: colors.text, minWidth: '32px' }}>
                {(minConfidenceCutoff * 100).toFixed(0)}%
              </span>
            </div>
          </div>
        </div>

        {/* Main Split Layout: Bipartite Interaction List & Selected Detail */}
        <div
          style={{
            display: 'grid',
            gridTemplateColumns: 'minmax(320px, 1.3fr) minmax(320px, 1fr)',
            gap: '1rem',
          }}
        >
          {/* Left Column: Interactive Predicted Interactions Table */}
          <div
            style={{
              display: 'flex',
              flexDirection: 'column',
              gap: '0.5rem',
              maxHeight: '440px',
              overflowY: 'auto',
              paddingRight: '4px',
            }}
          >
            <div style={{ fontSize: '0.75rem', fontWeight: 600, color: colors.textMuted, paddingBottom: '2px' }}>
              Showing {filteredInteractions.length} Interactions (Click to inspect docking interface)
            </div>

            {filteredInteractions.map((inter) => {
              const isSelected = selectedInteraction?.id === inter.id;
              const roleColor = ROLE_COLORS[inter.functionalRole];

              return (
                <div
                  key={inter.id}
                  onClick={() => setSelectedInteractionId(inter.id)}
                  style={{
                    padding: '0.6rem 0.8rem',
                    borderRadius: '6px',
                    backgroundColor: isSelected ? `${colors.primary}18` : colors.backgroundAlt,
                    border: `1px solid ${isSelected ? colors.primary : colors.borderLight}`,
                    cursor: 'pointer',
                    transition: 'all 0.15s ease',
                    display: 'flex',
                    flexDirection: 'column',
                    gap: '0.3rem',
                  }}
                >
                  <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
                    <div style={{ display: 'flex', alignItems: 'center', gap: '0.5rem' }}>
                      <span
                        style={{
                          fontWeight: 700,
                          fontSize: '0.85rem',
                          color: colors.text,
                        }}
                      >
                        {inter.phageProteinName}
                      </span>
                      <span style={{ fontSize: '0.75rem', color: colors.textDim }}>↔</span>
                      <span
                        style={{
                          fontWeight: 700,
                          fontSize: '0.85rem',
                          color: roleColor,
                        }}
                      >
                        {inter.hostProteinName.split(' ')[0]}
                      </span>
                    </div>

                    <div style={{ display: 'flex', alignItems: 'center', gap: '0.4rem' }}>
                      <span
                        style={{
                          fontSize: '0.65rem',
                          fontWeight: 600,
                          padding: '1px 5px',
                          borderRadius: '3px',
                          backgroundColor: `${roleColor}25`,
                          color: roleColor,
                        }}
                      >
                        {inter.functionalRole}
                      </span>
                      <span
                        style={{
                          fontSize: '0.75rem',
                          fontWeight: 700,
                          color: inter.confidence >= 0.70 ? colors.success : colors.warning,
                        }}
                      >
                        {(inter.confidence * 100).toFixed(0)}%
                      </span>
                    </div>
                  </div>

                  <div style={{ display: 'flex', justifyContent: 'space-between', fontSize: '0.72rem', color: colors.textMuted }}>
                    <span>{inter.phageProduct}</span>
                    <span>ΔG: {inter.dockingFootprint.estimatedDeltaG_kcal_mol} kcal/mol</span>
                  </div>

                  {inter.supportingPfamPairs.length > 0 && (
                    <div style={{ fontSize: '0.68rem', color: colors.textDim }}>
                      Domain Prior: {inter.supportingPfamPairs[0]}
                    </div>
                  )}
                </div>
              );
            })}
          </div>

          {/* Right Column: Detailed Interaction Inspector & Docking Surface */}
          {selectedInteraction ? (
            <div
              style={{
                backgroundColor: colors.backgroundAlt,
                border: `1px solid ${colors.borderLight}`,
                borderRadius: '8px',
                padding: '0.9rem',
                display: 'flex',
                flexDirection: 'column',
                gap: '0.75rem',
              }}
            >
              {/* Header */}
              <div style={{ borderBottom: `1px solid ${colors.borderLight}`, paddingBottom: '0.5rem' }}>
                <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'flex-start' }}>
                  <div>
                    <div style={{ fontSize: '1rem', fontWeight: 700, color: colors.text }}>
                      {selectedInteraction.phageProteinName} ↔ {selectedInteraction.hostProteinId}
                    </div>
                    <div style={{ fontSize: '0.75rem', color: colors.textMuted }}>
                      {selectedInteraction.hostProteinName} ({selectedInteraction.hostOrganism})
                    </div>
                  </div>
                  <span
                    style={{
                      padding: '2px 8px',
                      borderRadius: '4px',
                      fontSize: '0.75rem',
                      fontWeight: 700,
                      backgroundColor:
                        selectedInteraction.evidenceLevel === 'high' ? `${colors.success}25` : `${colors.warning}25`,
                      color: selectedInteraction.evidenceLevel === 'high' ? colors.success : colors.warning,
                    }}
                  >
                    {selectedInteraction.evidenceLevel.toUpperCase()} CONFIDENCE ({(selectedInteraction.confidence * 100).toFixed(0)}%)
                  </span>
                </div>
              </div>

              {/* Multi-Evidence Breakdown Bars */}
              <div>
                <div style={{ fontSize: '0.75rem', fontWeight: 600, color: colors.textMuted, marginBottom: '0.4rem' }}>
                  Bayesian Evidence Integration
                </div>

                <div style={{ display: 'flex', flexDirection: 'column', gap: '0.4rem', fontSize: '0.72rem' }}>
                  {/* Language Model */}
                  <div>
                    <div style={{ display: 'flex', justifyContent: 'space-between', color: colors.textDim, marginBottom: '2px' }}>
                      <span>Protein Language Model (ESM-2 Cosine Alignment)</span>
                      <span>{(selectedInteraction.embeddingSimilarity * 100).toFixed(0)}%</span>
                    </div>
                    <div style={{ height: '5px', backgroundColor: colors.background, borderRadius: '3px', overflow: 'hidden' }}>
                      <div
                        style={{
                          width: `${selectedInteraction.embeddingSimilarity * 100}%`,
                          height: '100%',
                          backgroundColor: '#3b82f6',
                        }}
                      />
                    </div>
                  </div>

                  {/* Domain Prior */}
                  <div>
                    <div style={{ display: 'flex', justifyContent: 'space-between', color: colors.textDim, marginBottom: '2px' }}>
                      <span>Domain Interaction Compatibility (iPfam / 3did)</span>
                      <span>{(selectedInteraction.domainCompatibility * 100).toFixed(0)}%</span>
                    </div>
                    <div style={{ height: '5px', backgroundColor: colors.background, borderRadius: '3px', overflow: 'hidden' }}>
                      <div
                        style={{
                          width: `${selectedInteraction.domainCompatibility * 100}%`,
                          height: '100%',
                          backgroundColor: '#8b5cf6',
                        }}
                      />
                    </div>
                  </div>

                  {/* Surface Docking Affinity */}
                  <div>
                    <div style={{ display: 'flex', justifyContent: 'space-between', color: colors.textDim, marginBottom: '2px' }}>
                      <span>Surface Electrostatic & Shape Complementarity</span>
                      <span>{(selectedInteraction.dockingAffinityScore * 100).toFixed(0)}%</span>
                    </div>
                    <div style={{ height: '5px', backgroundColor: colors.background, borderRadius: '3px', overflow: 'hidden' }}>
                      <div
                        style={{
                          width: `${selectedInteraction.dockingAffinityScore * 100}%`,
                          height: '100%',
                          backgroundColor: '#10b981',
                        }}
                      />
                    </div>
                  </div>
                </div>
              </div>

              {/* Predicted Docking Footprint & Thermodynamic Energetics */}
              <div
                style={{
                  backgroundColor: colors.background,
                  padding: '0.65rem 0.75rem',
                  borderRadius: '6px',
                  border: `1px solid ${colors.borderLight}`,
                  display: 'flex',
                  flexDirection: 'column',
                  gap: '0.4rem',
                }}
              >
                <div style={{ fontSize: '0.75rem', fontWeight: 600, color: colors.text }}>
                  Docking Surface & Biophysical Parameters
                </div>

                <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: '0.4rem', fontSize: '0.72rem' }}>
                  <div>
                    <span style={{ color: colors.textDim }}>Binding Free Energy: </span>
                    <strong style={{ color: colors.text }}>{selectedInteraction.dockingFootprint.estimatedDeltaG_kcal_mol} kcal/mol</strong>
                  </div>
                  <div>
                    <span style={{ color: colors.textDim }}>Affinity (Kd): </span>
                    <strong style={{ color: colors.text }}>{selectedInteraction.dockingFootprint.estimatedKd_nM} nM</strong>
                  </div>
                  <div>
                    <span style={{ color: colors.textDim }}>Buried Surface Area: </span>
                    <strong style={{ color: colors.text }}>{selectedInteraction.dockingFootprint.buriedSurfaceAreaA2} Å²</strong>
                  </div>
                  <div>
                    <span style={{ color: colors.textDim }}>Compartment: </span>
                    <strong style={{ color: colors.text }}>{selectedInteraction.hostCompartment}</strong>
                  </div>
                </div>

                <div style={{ fontSize: '0.7rem', color: colors.textMuted, marginTop: '2px' }}>
                  <div><strong>Phage Interface:</strong> {selectedInteraction.dockingFootprint.phageResidueWindow}</div>
                  <div><strong>Host Interface:</strong> {selectedInteraction.dockingFootprint.hostResidueWindow}</div>
                </div>
              </div>

              {/* Biological Mechanism */}
              <div style={{ fontSize: '0.72rem', color: colors.textMuted, fontStyle: 'italic' }}>
                {selectedInteraction.mechanisticRationale}
              </div>
            </div>
          ) : (
            <div
              style={{
                display: 'flex',
                alignItems: 'center',
                justifyContent: 'center',
                backgroundColor: colors.backgroundAlt,
                border: `1px solid ${colors.borderLight}`,
                borderRadius: '8px',
                padding: '2rem',
                color: colors.textDim,
                fontSize: '0.85rem',
              }}
            >
              Select an interaction on the left to view detailed docking mechanics.
            </div>
          )}
        </div>

        {/* In-Silico Effector Engineering Simulation Panel */}
        <OverlaySection>
          <OverlaySectionHeader
            title="In-Silico Effector Docking Engineering & Host Range Expansion"
            description="Simulates rational site-directed mutations at effector interfaces to overcome resistant host bacterial variants."
          />

          <div
            style={{
              display: 'grid',
              gridTemplateColumns: 'repeat(auto-fit, minmax(280px, 1fr))',
              gap: '0.6rem',
            }}
          >
            {analysisResult.inSilicoEngineeringCandidates.map((cand) => (
              <div
                key={cand.mutationId}
                style={{
                  padding: '0.65rem 0.8rem',
                  borderRadius: '6px',
                  backgroundColor: colors.backgroundAlt,
                  border: `1px solid ${colors.borderLight}`,
                  display: 'flex',
                  flexDirection: 'column',
                  gap: '0.35rem',
                }}
              >
                <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
                  <span style={{ fontWeight: 700, fontSize: '0.8rem', color: colors.text }}>
                    {cand.phageProtein}: {cand.mutationDescription}
                  </span>
                  <span
                    style={{
                      fontSize: '0.7rem',
                      fontWeight: 700,
                      color: colors.success,
                      backgroundColor: `${colors.success}20`,
                      padding: '1px 5px',
                      borderRadius: '3px',
                    }}
                  >
                    ΔΔG {cand.deltaDeltaG} kcal/mol ({cand.predictedFoldAffinityChange}x)
                  </span>
                </div>

                <div style={{ fontSize: '0.72rem', color: colors.textMuted }}>
                  Target: <strong>{cand.hostProtein}</strong> · Baseline ΔG: {cand.baselineDeltaG} → Engineered ΔG: <strong>{cand.engineeredDeltaG}</strong> kcal/mol
                </div>

                <div style={{ fontSize: '0.7rem', color: colors.textDim }}>
                  {cand.predictedHostRangeShift}
                </div>
              </div>
            ))}
          </div>
        </OverlaySection>

        {/* Hub Target Vulnerabilities */}
        <OverlaySection>
          <OverlaySectionHeader
            title="Top Network Hub Effectors & Host Targets"
            description="Key central viral effectors and their multi-target host convergence points."
          />

          <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: '1rem' }}>
            <div style={{ padding: '0.6rem', backgroundColor: colors.backgroundAlt, borderRadius: '6px', border: `1px solid ${colors.borderLight}` }}>
              <div style={{ fontSize: '0.75rem', fontWeight: 600, color: colors.text, marginBottom: '4px' }}>
                Top Phage Effectors (Hubs)
              </div>
              <div style={{ display: 'flex', flexDirection: 'column', gap: '0.3rem' }}>
                {analysisResult.hubPhageProteins.map((p) => (
                  <div key={p.name} style={{ display: 'flex', justifyContent: 'space-between', fontSize: '0.72rem' }}>
                    <span style={{ fontWeight: 600, color: colors.text }}>{p.name} ({p.product})</span>
                    <span style={{ color: colors.textMuted }}>{p.count} target links</span>
                  </div>
                ))}
              </div>
            </div>

            <div style={{ padding: '0.6rem', backgroundColor: colors.backgroundAlt, borderRadius: '6px', border: `1px solid ${colors.borderLight}` }}>
              <div style={{ fontSize: '0.75rem', fontWeight: 600, color: colors.text, marginBottom: '4px' }}>
                Vulnerable Host Cellular Targets
              </div>
              <div style={{ display: 'flex', flexDirection: 'column', gap: '0.3rem' }}>
                {analysisResult.hubHostProteins.map((h) => (
                  <div key={h.id} style={{ display: 'flex', justifyContent: 'space-between', fontSize: '0.72rem' }}>
                    <span style={{ fontWeight: 600, color: colors.text }}>{h.name}</span>
                    <span style={{ color: colors.textMuted }}>{h.count} effector hits</span>
                  </div>
                ))}
              </div>
            </div>
          </div>
        </OverlaySection>
      </OverlayStack>
    </Overlay>
  );
}
