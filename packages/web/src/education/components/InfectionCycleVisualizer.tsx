/**
 * InfectionCycleVisualizer
 *
 * Animated walkthrough of the phage lifecycle from attachment to lysis.
 * Shows both lytic and lysogenic pathways with animated SVG diagrams
 * and a timeline scrubber for exploration.
 */

import React, { useCallback, useEffect, useMemo, useState } from 'react';
import { useTheme } from '../../hooks/useTheme';
import type { ThemePalette } from '../../theme/types';

type LifecycleStage = {
  id: string;
  name: string;
  shortName: string;
  description: string;
  duration: number; // relative duration for timing
  pathway: 'shared' | 'lytic' | 'lysogenic';
};

type Pathway = 'lytic' | 'lysogenic';

const LIFECYCLE_STAGES: LifecycleStage[] = [
  {
    id: 'attachment',
    name: 'Attachment',
    shortName: 'Attach',
    description: 'Tail fibers recognize and bind to specific receptors on the bacterial surface. This determines host range.',
    duration: 1,
    pathway: 'shared',
  },
  {
    id: 'injection',
    name: 'DNA Injection',
    shortName: 'Inject',
    description: 'The tail contracts, puncturing the cell membrane. Phage DNA is injected into the cytoplasm while the capsid remains outside.',
    duration: 1,
    pathway: 'shared',
  },
  {
    id: 'decision',
    name: 'Lytic/Lysogenic Decision',
    shortName: 'Decide',
    description: 'Regulatory circuits sense host conditions. Stress favors lysis; good conditions may favor lysogeny (for temperate phages).',
    duration: 1,
    pathway: 'shared',
  },
  // Lytic pathway
  {
    id: 'takeover',
    name: 'Host Takeover',
    shortName: 'Takeover',
    description: 'Phage genes hijack host ribosomes and enzymes. Host DNA may be degraded. Early genes express.',
    duration: 2,
    pathway: 'lytic',
  },
  {
    id: 'replication',
    name: 'Genome Replication',
    shortName: 'Replicate',
    description: 'Dozens to hundreds of phage genome copies are synthesized using host nucleotides.',
    duration: 2,
    pathway: 'lytic',
  },
  {
    id: 'assembly',
    name: 'Virion Assembly',
    shortName: 'Assemble',
    description: 'Capsid proteins self-assemble. DNA is packaged by a molecular motor. Tails attach to form complete virions.',
    duration: 2,
    pathway: 'lytic',
  },
  {
    id: 'lysis',
    name: 'Lysis & Release',
    shortName: 'Lyse',
    description: 'Holins and endolysins destroy the cell wall. The bacterium bursts, releasing 50-200+ new phages.',
    duration: 1,
    pathway: 'lytic',
  },
  // Lysogenic pathway
  {
    id: 'integration',
    name: 'Genome Integration',
    shortName: 'Integrate',
    description: 'Integrase enzyme inserts phage DNA into the bacterial chromosome at specific att sites.',
    duration: 2,
    pathway: 'lysogenic',
  },
  {
    id: 'prophage',
    name: 'Prophage State',
    shortName: 'Prophage',
    description: 'Phage DNA replicates passively with the host. Repressor proteins keep lytic genes silent. Host gains immunity.',
    duration: 3,
    pathway: 'lysogenic',
  },
  {
    id: 'induction',
    name: 'Induction',
    shortName: 'Induce',
    description: 'DNA damage or stress triggers prophage excision. The phage enters the lytic cycle.',
    duration: 1,
    pathway: 'lysogenic',
  },
];

interface InfectionCycleVisualizerProps {
  initialPathway?: Pathway;
  speedMs?: number;
  autoPlay?: boolean;
  title?: string;
}

function getStagesForPathway(pathway: Pathway): LifecycleStage[] {
  return LIFECYCLE_STAGES.filter(
    (s) => s.pathway === 'shared' || s.pathway === pathway
  );
}

export function InfectionCycleVisualizer({
  initialPathway = 'lytic',
  speedMs = 2000,
  autoPlay = false,
  title = 'Phage Infection Cycle',
}: InfectionCycleVisualizerProps): React.ReactElement {
  const { theme } = useTheme();
  const colors = theme.colors;

  const [pathway, setPathway] = useState<Pathway>(initialPathway);
  const [stageIndex, setStageIndex] = useState(0);
  const [isPlaying, setIsPlaying] = useState(autoPlay);

  const stages = useMemo(() => getStagesForPathway(pathway), [pathway]);
  const currentStage = stages[stageIndex];

  const progress = stages.length > 1 ? stageIndex / (stages.length - 1) : 0;

  const advance = useCallback(() => {
    setStageIndex((prev) => {
      if (prev >= stages.length - 1) {
        return prev;
      }
      return prev + 1;
    });
  }, [stages.length]);

  const goToStage = useCallback((index: number) => {
    setStageIndex(Math.max(0, Math.min(index, stages.length - 1)));
  }, [stages.length]);

  const reset = useCallback(() => {
    setStageIndex(0);
    setIsPlaying(false);
  }, []);

  const togglePathway = useCallback(() => {
    setPathway((p) => (p === 'lytic' ? 'lysogenic' : 'lytic'));
    setStageIndex(0);
    setIsPlaying(false);
  }, []);

  useEffect(() => {
    if (stageIndex >= stages.length - 1 && isPlaying) {
      setIsPlaying(false);
    }
  }, [stageIndex, stages.length, isPlaying]);

  useEffect(() => {
    if (!isPlaying) return;
    if (stageIndex >= stages.length - 1) return;
    const duration = (currentStage?.duration ?? 1) * speedMs;
    const timer = setTimeout(advance, duration);
    return () => clearTimeout(timer);
  }, [advance, currentStage?.duration, isPlaying, speedMs, stageIndex, stages.length]);

  // Reset stage index when pathway changes
  useEffect(() => {
    setStageIndex(0);
  }, [pathway]);

  const pathwayColor = pathway === 'lytic' ? '#ef4444' : '#8b5cf6';
  const pathwayLabel = pathway === 'lytic' ? 'Lytic Cycle' : 'Lysogenic Cycle';

  return (
    <div className="infection-cycle-viz">
      {/* Header */}
      <div className="infection-cycle-viz__header">
        <div>
          <p className="text-dim">{title}</p>
          <p className="text-strong">{pathwayLabel}</p>
        </div>
        <div className="infection-cycle-viz__controls" role="group" aria-label="Playback controls">
          <button
            type="button"
            className="btn btn-ghost"
            onClick={togglePathway}
            style={{ borderColor: pathwayColor, color: pathwayColor }}
          >
            Switch to {pathway === 'lytic' ? 'Lysogenic' : 'Lytic'}
          </button>
          <button
            type="button"
            className="btn btn-ghost"
            onClick={() => setIsPlaying((v) => !v)}
            aria-pressed={isPlaying}
          >
            {isPlaying ? 'Pause' : 'Play'}
          </button>
          <button type="button" className="btn btn-ghost" onClick={advance} disabled={stageIndex >= stages.length - 1}>
            Step
          </button>
          <button type="button" className="btn btn-ghost" onClick={reset}>
            Reset
          </button>
        </div>
      </div>

      {/* Main visualization area */}
      <div className="infection-cycle-viz__layout">
        {/* Stage diagram */}
        <div
          className="infection-cycle-viz__diagram"
          style={{
            background: `linear-gradient(135deg, ${pathwayColor}11, ${colors.backgroundAlt})`,
            border: `1px solid ${colors.borderLight}`,
            borderRadius: 12,
            padding: '1.5rem',
            minHeight: 280,
            display: 'flex',
            alignItems: 'center',
            justifyContent: 'center',
          }}
        >
          <StageDiagram stage={currentStage} pathway={pathway} colors={colors} />
        </div>

        {/* Stage info panel */}
        <div
          className="infection-cycle-viz__info"
          style={{
            background: colors.backgroundAlt,
            border: `1px solid ${colors.borderLight}`,
            borderRadius: 12,
            padding: '1.25rem',
          }}
        >
          <div style={{ marginBottom: '0.75rem' }}>
            <span
              className="badge"
              style={{
                background: pathwayColor,
                color: '#fff',
                marginRight: '0.5rem',
              }}
            >
              Stage {stageIndex + 1} of {stages.length}
            </span>
            <span
              className="badge badge-ghost"
              style={{ borderColor: pathwayColor, color: pathwayColor }}
            >
              {currentStage?.pathway === 'shared' ? 'Both Pathways' : pathwayLabel}
            </span>
          </div>

          <h3 style={{ margin: '0 0 0.5rem', color: colors.text }}>
            {currentStage?.name}
          </h3>

          <p style={{ color: colors.textMuted, lineHeight: 1.6, margin: 0 }}>
            {currentStage?.description}
          </p>

          {/* Key points for each stage */}
          <StageKeyPoints stage={currentStage} colors={colors} />
        </div>
      </div>

      {/* Timeline scrubber */}
      <div
        className="infection-cycle-viz__timeline"
        style={{
          marginTop: '1rem',
          background: colors.backgroundAlt,
          border: `1px solid ${colors.borderLight}`,
          borderRadius: 8,
          padding: '0.75rem 1rem',
        }}
      >
        <div
          style={{
            display: 'flex',
            alignItems: 'center',
            gap: '0.5rem',
            marginBottom: '0.5rem',
          }}
        >
          <span style={{ color: colors.textMuted, fontSize: '0.85rem' }}>Timeline</span>
          <div
            style={{
              flex: 1,
              height: 4,
              background: colors.border,
              borderRadius: 2,
              position: 'relative',
            }}
          >
            <div
              style={{
                position: 'absolute',
                left: 0,
                top: 0,
                height: '100%',
                width: `${progress * 100}%`,
                background: pathwayColor,
                borderRadius: 2,
                transition: 'width 0.3s ease',
              }}
            />
          </div>
        </div>

        <div
          style={{
            display: 'flex',
            justifyContent: 'space-between',
            gap: '0.25rem',
          }}
          role="group"
          aria-label="Timeline stages"
        >
          {stages.map((stage, idx) => (
            <button
              key={stage.id}
              type="button"
              onClick={() => goToStage(idx)}
              aria-current={idx === stageIndex ? 'step' : undefined}
              style={{
                flex: 1,
                padding: '0.5rem 0.25rem',
                border: 'none',
                borderRadius: 6,
                background: idx === stageIndex ? pathwayColor : 'transparent',
                color: idx === stageIndex ? '#fff' : idx < stageIndex ? pathwayColor : colors.textMuted,
                fontSize: '0.75rem',
                fontWeight: idx === stageIndex ? 600 : 400,
                cursor: 'pointer',
                transition: 'all 0.2s ease',
                whiteSpace: 'nowrap',
                overflow: 'hidden',
                textOverflow: 'ellipsis',
              }}
              title={stage.name}
            >
              {stage.shortName}
            </button>
          ))}
        </div>
      </div>
    </div>
  );
}

/**
 * Stage-specific SVG diagrams
 */
function StageDiagram({
  stage,
  pathway,
  colors,
}: {
  stage: LifecycleStage | undefined;
  pathway: Pathway;
  colors: ThemePalette;
}): React.ReactElement {
  if (!stage) {
    return <div style={{ color: colors.textMuted }}>Select a stage</div>;
  }

  const pathwayColor = pathway === 'lytic' ? '#ef4444' : '#8b5cf6';

  // Common colors
  const capsidColor = '#8b5cf6';
  const tailColor = '#22c55e';
  const fiberColor = '#f97316';
  const dnaColor = '#3b82f6';
  const bacteriaColor = '#fbbf24';
  const bacteriaStroke = '#d97706';

  return (
    <svg
      viewBox="0 0 300 200"
      role="img"
      aria-label={`${stage.name} diagram`}
      style={{ width: '100%', maxWidth: 400, height: 'auto' }}
    >
      <defs>
        <linearGradient id="bacteriaGrad" x1="0" x2="1" y1="0" y2="1">
          <stop stopColor={bacteriaColor} offset="0%" />
          <stop stopColor="#fcd34d" offset="100%" />
        </linearGradient>
        <linearGradient id="capsidGrad" x1="0" x2="0" y1="0" y2="1">
          <stop stopColor="#a855f7" offset="0%" />
          <stop stopColor={capsidColor} offset="100%" />
        </linearGradient>
        <pattern id="dnaPattern" patternUnits="userSpaceOnUse" width="8" height="4">
          <line x1="0" y1="0" x2="4" y2="4" stroke={dnaColor} strokeWidth="1" />
        </pattern>
      </defs>

      {/* Bacterium (rod-shaped) */}
      <ellipse
        cx="150"
        cy="130"
        rx="100"
        ry="50"
        fill="url(#bacteriaGrad)"
        stroke={bacteriaStroke}
        strokeWidth="2"
        opacity="0.9"
      />

      {/* Stage-specific elements */}
      {stage.id === 'attachment' && (
        <>
          {/* Phage above bacterium */}
          <PhageIcon x={130} y={20} capsidColor={capsidColor} tailColor={tailColor} fiberColor={fiberColor} />
          {/* Receptor markers on bacterium */}
          <circle cx="130" cy="85" r="4" fill={fiberColor} opacity="0.8" />
          <circle cx="150" cy="82" r="4" fill={fiberColor} opacity="0.8" />
          <circle cx="170" cy="85" r="4" fill={fiberColor} opacity="0.8" />
          {/* Arrow showing approach */}
          <path d="M150 55 L150 70" stroke={pathwayColor} strokeWidth="2" markerEnd="url(#arrow)" />
        </>
      )}

      {stage.id === 'injection' && (
        <>
          {/* Phage attached, DNA entering */}
          <PhageIcon x={130} y={40} capsidColor={capsidColor} tailColor={tailColor} fiberColor={fiberColor} attached />
          {/* DNA stream entering cell */}
          <path
            d="M150 80 Q150 100 145 120 Q140 140 150 150"
            stroke={dnaColor}
            strokeWidth="3"
            fill="none"
            strokeDasharray="6 3"
            opacity="0.9"
          />
          <text x="180" y="110" fontSize="10" fill={colors.textMuted}>DNA injection</text>
        </>
      )}

      {stage.id === 'decision' && (
        <>
          {/* DNA inside cell, decision arrows */}
          <circle cx="150" cy="130" r="15" fill={dnaColor} opacity="0.3" />
          <text x="150" y="134" fontSize="10" fill={dnaColor} textAnchor="middle">DNA</text>
          {/* Fork arrows */}
          <path d="M130 100 L100 70" stroke="#ef4444" strokeWidth="2" />
          <text x="70" y="65" fontSize="9" fill="#ef4444">Lytic</text>
          <path d="M170 100 L200 70" stroke="#8b5cf6" strokeWidth="2" />
          <text x="195" y="65" fontSize="9" fill="#8b5cf6">Lysogenic</text>
        </>
      )}

      {stage.id === 'takeover' && (
        <>
          {/* Ribosomes making phage proteins */}
          <circle cx="100" cy="120" r="8" fill={capsidColor} opacity="0.7" />
          <circle cx="130" cy="140" r="8" fill={capsidColor} opacity="0.7" />
          <circle cx="170" cy="130" r="8" fill={capsidColor} opacity="0.7" />
          <circle cx="200" cy="120" r="8" fill={capsidColor} opacity="0.7" />
          {/* Degraded host DNA */}
          <path d="M120 110 L140 125" stroke={bacteriaStroke} strokeWidth="2" opacity="0.4" strokeDasharray="3 3" />
          <text x="150" y="170" fontSize="10" fill={colors.textMuted} textAnchor="middle">Host machinery hijacked</text>
        </>
      )}

      {stage.id === 'replication' && (
        <>
          {/* Multiple DNA copies */}
          {[0, 1, 2, 3, 4].map((i) => (
            <circle
              key={i}
              cx={100 + i * 25}
              cy={125 + (i % 2) * 15}
              r="10"
              fill={dnaColor}
              opacity={0.6 + i * 0.08}
            />
          ))}
          <text x="150" y="170" fontSize="10" fill={colors.textMuted} textAnchor="middle">Genome copies multiply</text>
        </>
      )}

      {stage.id === 'assembly' && (
        <>
          {/* Partially assembled phages */}
          <PhageIcon x={80} y={100} capsidColor={capsidColor} tailColor={tailColor} fiberColor={fiberColor} scale={0.6} />
          <PhageIcon x={140} y={95} capsidColor={capsidColor} tailColor={tailColor} fiberColor={fiberColor} scale={0.6} />
          <PhageIcon x={190} y={105} capsidColor={capsidColor} tailColor={tailColor} fiberColor={fiberColor} scale={0.6} />
          {/* Loose components */}
          <polygon points="120,140 130,150 120,160 110,150" fill={capsidColor} opacity="0.5" />
          <rect x="165" y="145" width="4" height="12" fill={tailColor} opacity="0.5" />
        </>
      )}

      {stage.id === 'lysis' && (
        <>
          {/* Bursting cell */}
          <ellipse
            cx="150"
            cy="130"
            rx="100"
            ry="50"
            fill="none"
            stroke={bacteriaStroke}
            strokeWidth="2"
            strokeDasharray="8 4"
            opacity="0.5"
          />
          {/* Phages escaping */}
          <PhageIcon x={60} y={60} capsidColor={capsidColor} tailColor={tailColor} fiberColor={fiberColor} scale={0.5} />
          <PhageIcon x={100} y={40} capsidColor={capsidColor} tailColor={tailColor} fiberColor={fiberColor} scale={0.5} />
          <PhageIcon x={180} y={50} capsidColor={capsidColor} tailColor={tailColor} fiberColor={fiberColor} scale={0.5} />
          <PhageIcon x={220} y={70} capsidColor={capsidColor} tailColor={tailColor} fiberColor={fiberColor} scale={0.5} />
          <PhageIcon x={140} y={30} capsidColor={capsidColor} tailColor={tailColor} fiberColor={fiberColor} scale={0.5} />
          {/* Burst lines */}
          {[0, 45, 90, 135, 180, 225, 270, 315].map((angle) => (
            <line
              key={angle}
              x1={150 + Math.cos((angle * Math.PI) / 180) * 60}
              y1={130 + Math.sin((angle * Math.PI) / 180) * 35}
              x2={150 + Math.cos((angle * Math.PI) / 180) * 75}
              y2={130 + Math.sin((angle * Math.PI) / 180) * 45}
              stroke={pathwayColor}
              strokeWidth="2"
              opacity="0.7"
            />
          ))}
        </>
      )}

      {stage.id === 'integration' && (
        <>
          {/* DNA integrating into chromosome */}
          <ellipse cx="150" cy="130" rx="70" ry="25" fill="none" stroke={bacteriaStroke} strokeWidth="3" />
          <path
            d="M100 130 Q125 115 150 130 Q175 145 200 130"
            stroke={dnaColor}
            strokeWidth="4"
            fill="none"
          />
          <text x="150" y="170" fontSize="10" fill={colors.textMuted} textAnchor="middle">Integrase inserts phage DNA</text>
        </>
      )}

      {stage.id === 'prophage' && (
        <>
          {/* Prophage in chromosome, cell dividing */}
          <ellipse cx="150" cy="130" rx="70" ry="25" fill="none" stroke={bacteriaStroke} strokeWidth="3" />
          <path d="M110 130 L190 130" stroke={dnaColor} strokeWidth="6" />
          <text x="150" y="134" fontSize="8" fill="#fff" textAnchor="middle">Prophage</text>
          {/* Repressor proteins */}
          <circle cx="130" cy="100" r="6" fill="#10b981" />
          <circle cx="170" cy="100" r="6" fill="#10b981" />
          <text x="150" y="90" fontSize="9" fill="#10b981" textAnchor="middle">Repressors active</text>
        </>
      )}

      {stage.id === 'induction' && (
        <>
          {/* DNA excising */}
          <ellipse cx="150" cy="130" rx="70" ry="25" fill="none" stroke={bacteriaStroke} strokeWidth="3" strokeDasharray="4 4" />
          {/* Excised phage DNA */}
          <circle cx="150" cy="80" r="20" fill={dnaColor} opacity="0.7" />
          <text x="150" y="84" fontSize="8" fill="#fff" textAnchor="middle">Excised</text>
          {/* Lightning bolt for stress */}
          <path d="M250 50 L235 70 L245 70 L230 95" stroke="#fbbf24" strokeWidth="3" fill="none" />
          <text x="240" y="40" fontSize="9" fill="#fbbf24">UV / Stress</text>
        </>
      )}
    </svg>
  );
}

/**
 * Simple phage icon component
 */
function PhageIcon({
  x,
  y,
  capsidColor,
  tailColor,
  fiberColor,
  scale = 1,
  attached = false,
}: {
  x: number;
  y: number;
  capsidColor: string;
  tailColor: string;
  fiberColor: string;
  scale?: number;
  attached?: boolean;
}): React.ReactElement {
  const s = scale;
  return (
    <g transform={`translate(${x}, ${y}) scale(${s})`}>
      {/* Capsid (icosahedral head) */}
      <polygon
        points="20,0 35,12 30,32 10,32 5,12"
        fill={capsidColor}
        stroke="#d8b4fe"
        strokeWidth={1}
      />
      {/* Tail */}
      <rect x="17" y="32" width="6" height={attached ? 20 : 25} rx="2" fill={tailColor} />
      {/* Baseplate */}
      <rect x="14" y={attached ? 52 : 57} width="12" height="4" rx="1" fill="#0ea5e9" />
      {/* Tail fibers */}
      <line x1="20" y1={attached ? 56 : 61} x2="5" y2={attached ? 66 : 76} stroke={fiberColor} strokeWidth="2" strokeLinecap="round" />
      <line x1="20" y1={attached ? 56 : 61} x2="35" y2={attached ? 66 : 76} stroke={fiberColor} strokeWidth="2" strokeLinecap="round" />
    </g>
  );
}

/**
 * Key points for each stage
 */
function StageKeyPoints({
  stage,
  colors,
}: {
  stage: LifecycleStage | undefined;
  colors: ThemePalette;
}): React.ReactElement | null {
  if (!stage) return null;

  const keyPoints: Record<string, string[]> = {
    attachment: [
      'Tail fibers act as molecular keys',
      'Host specificity determined here',
      'Reversible until baseplate triggers',
    ],
    injection: [
      'Tail sheath contracts like a syringe',
      'Only DNA/RNA enters the cell',
      'Protein coat stays outside',
    ],
    decision: [
      'CI repressor favors lysogeny',
      'Cro protein favors lysis',
      'MOI and host health influence choice',
    ],
    takeover: [
      'Host sigma factors replaced',
      'Phage promoters activated',
      'Anti-CRISPR proteins deployed',
    ],
    replication: [
      'Rolling circle or theta replication',
      '50-200+ genome copies made',
      'Concatemers form for packaging',
    ],
    assembly: [
      'Procapsids self-assemble',
      'Terminase packs DNA (ATP-powered)',
      'Tails attach last',
    ],
    lysis: [
      'Holin creates membrane pores',
      'Endolysin degrades peptidoglycan',
      'Burst size: 50-200+ phages',
    ],
    integration: [
      'Site-specific recombination',
      'attP meets attB',
      'Integrase catalyzes insertion',
    ],
    prophage: [
      'Lysogenic conversion possible',
      'Immunity to superinfection',
      'Stable inheritance through generations',
    ],
    induction: [
      'SOS response cleaves CI repressor',
      'Excisionase reverses integration',
      'Returns to lytic cycle',
    ],
  };

  const points = keyPoints[stage.id] ?? [];

  if (points.length === 0) return null;

  return (
    <ul
      style={{
        marginTop: '1rem',
        paddingLeft: '1.25rem',
        color: colors.text,
        fontSize: '0.9rem',
        lineHeight: 1.7,
      }}
    >
      {points.map((point, idx) => (
        <li key={idx} style={{ marginBottom: '0.25rem' }}>
          {point}
        </li>
      ))}
    </ul>
  );
}

export default InfectionCycleVisualizer;
