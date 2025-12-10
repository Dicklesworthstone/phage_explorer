import React, { useMemo, useState } from 'react';
import { AMINO_ACIDS, CODON_TABLE, type AminoAcidInfo } from '@phage-explorer/core';

type Base = 'A' | 'C' | 'G' | 'T';

const BASES: Base[] = ['A', 'C', 'G', 'T'];

const baseColors: Record<Base, string> = {
  A: '#22c55e',
  C: '#3b82f6',
  G: '#f97316',
  T: '#ef4444',
};

interface RingSpec {
  radiusInner: number;
  radiusOuter: number;
  onSelect: (base: Base) => void;
  selected: Base;
}

function polarToCartesian(cx: number, cy: number, r: number, angleRad: number) {
  return {
    x: cx + r * Math.cos(angleRad),
    y: cy + r * Math.sin(angleRad),
  };
}

function arcPath(cx: number, cy: number, r1: number, r2: number, start: number, end: number) {
  const largeArc = end - start > Math.PI ? 1 : 0;
  const p1 = polarToCartesian(cx, cy, r2, start);
  const p2 = polarToCartesian(cx, cy, r2, end);
  const p3 = polarToCartesian(cx, cy, r1, end);
  const p4 = polarToCartesian(cx, cy, r1, start);
  return [
    `M ${p1.x} ${p1.y}`,
    `A ${r2} ${r2} 0 ${largeArc} 1 ${p2.x} ${p2.y}`,
    `L ${p3.x} ${p3.y}`,
    `A ${r1} ${r1} 0 ${largeArc} 0 ${p4.x} ${p4.y}`,
    'Z',
  ].join(' ');
}

function Ring({ radiusInner, radiusOuter, onSelect, selected }: RingSpec): JSX.Element {
  const cx = 200;
  const cy = 200;
  const sweep = (2 * Math.PI) / BASES.length;

  return (
    <>
      {BASES.map((base, idx) => {
        const start = -Math.PI / 2 + idx * sweep;
        const end = start + sweep;
        const mid = start + sweep / 2;
        const labelPos = polarToCartesian(cx, cy, (radiusInner + radiusOuter) / 2, mid);
        const isActive = selected === base;
        return (
          <g key={`${base}-${idx}`} className="codon-wheel__segment">
            <path
              d={arcPath(cx, cy, radiusInner, radiusOuter, start, end)}
              fill={baseColors[base]}
              fillOpacity={isActive ? 0.45 : 0.22}
              stroke={isActive ? baseColors[base] : 'rgba(255,255,255,0.08)'}
              strokeWidth={isActive ? 3 : 1}
              onClick={() => onSelect(base)}
            />
            <text
              x={labelPos.x}
              y={labelPos.y}
              textAnchor="middle"
              dominantBaseline="middle"
              className={`codon-wheel__label ${isActive ? 'active' : ''}`}
            >
              {base}
            </text>
          </g>
        );
      })}
    </>
  );
}

export function CodonWheelVisualizer(): JSX.Element {
  const [first, setFirst] = useState<Base>('A');
  const [second, setSecond] = useState<Base>('A');
  const [third, setThird] = useState<Base>('A');

  const codon = `${first}${second}${third}`;
  const amino = CODON_TABLE[codon] ?? 'X';
  const info: AminoAcidInfo | undefined = AMINO_ACIDS[amino as keyof typeof AMINO_ACIDS];
  const isStart = codon === 'ATG';
  const isStop = amino === '*';

  const propertyLabel = useMemo(() => {
    if (!info) return 'Unknown';
    switch (info.property) {
      case 'hydrophobic':
        return 'Hydrophobic';
      case 'polar':
        return 'Polar';
      case 'acidic':
        return 'Acidic (negative)';
      case 'basic':
        return 'Basic (positive)';
      case 'special':
        return 'Special';
      case 'stop':
        return 'Stop';
      default:
        return info.property;
    }
  }, [info]);

  return (
    <div className="codon-wheel">
      <div className="codon-wheel__header">
        <div>
          <p className="text-dim">Genetic Code Wheel</p>
          <p className="text-strong">Click rings to pick bases</p>
        </div>
        <div className="codon-wheel__badges">
          {isStart && <span className="badge success">Start</span>}
          {isStop && <span className="badge error">Stop</span>}
        </div>
      </div>

      <div className="codon-wheel__layout">
        <svg viewBox="0 0 400 400" className="codon-wheel__svg" role="presentation">
          <Ring radiusInner={140} radiusOuter={190} onSelect={setFirst} selected={first} />
          <Ring radiusInner={90} radiusOuter={135} onSelect={setSecond} selected={second} />
          <Ring radiusInner={40} radiusOuter={85} onSelect={setThird} selected={third} />
          <circle cx="200" cy="200" r="34" className="codon-wheel__center" />
          <text x="200" y="195" textAnchor="middle" className="codon-wheel__codon">
            {codon}
          </text>
          <text x="200" y="220" textAnchor="middle" className="codon-wheel__codon-sub">
            {amino === 'X' ? '—' : info?.name ?? 'Unknown'}
          </text>
        </svg>

        <div className="codon-wheel__panel">
          <div className="codon-wheel__codon-chip">
            <span className="mono">{codon}</span>
            <span className="chip">{amino === 'X' ? 'Unknown' : info?.threeCode ?? '?'}</span>
          </div>
          <div className="codon-wheel__details">
            <div>
              <p className="label">Amino acid</p>
              <p className="value">{info?.name ?? 'Unknown'}</p>
            </div>
            <div>
              <p className="label">Property</p>
              <p className="value">{propertyLabel}</p>
            </div>
          </div>
          <p className="text-dim codon-wheel__hint">
            Start: ATG · Stops: TAA / TAG / TGA
          </p>
        </div>
      </div>
    </div>
  );
}

export default CodonWheelVisualizer;
