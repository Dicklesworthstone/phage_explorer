import React, { useState, useMemo, useCallback } from 'react';
import { useBeginnerMode } from '../hooks/useBeginnerMode';
import { CodonWheelVisualizer } from '../components/CodonWheelVisualizer';
import type { ModuleId } from '../types';

const MODULE_ID: ModuleId = 'genetic-code';

type Base = 'A' | 'C' | 'G' | 'T';
const BASES: Base[] = ['A', 'C', 'G', 'T'];

// Amino acid short codes for display
const CODON_TO_AA: Record<string, string> = {
  TTT: 'F', TTC: 'F', TTA: 'L', TTG: 'L',
  TCT: 'S', TCC: 'S', TCA: 'S', TCG: 'S',
  TAT: 'Y', TAC: 'Y', TAA: '*', TAG: '*',
  TGT: 'C', TGC: 'C', TGA: '*', TGG: 'W',
  CTT: 'L', CTC: 'L', CTA: 'L', CTG: 'L',
  CCT: 'P', CCC: 'P', CCA: 'P', CCG: 'P',
  CAT: 'H', CAC: 'H', CAA: 'Q', CAG: 'Q',
  CGT: 'R', CGC: 'R', CGA: 'R', CGG: 'R',
  ATT: 'I', ATC: 'I', ATA: 'I', ATG: 'M',
  ACT: 'T', ACC: 'T', ACA: 'T', ACG: 'T',
  AAT: 'N', AAC: 'N', AAA: 'K', AAG: 'K',
  AGT: 'S', AGC: 'S', AGA: 'R', AGG: 'R',
  GTT: 'V', GTC: 'V', GTA: 'V', GTG: 'V',
  GCT: 'A', GCC: 'A', GCA: 'A', GCG: 'A',
  GAT: 'D', GAC: 'D', GAA: 'E', GAG: 'E',
  GGT: 'G', GGC: 'G', GGA: 'G', GGG: 'G',
};

const AA_NAMES: Record<string, string> = {
  A: 'Alanine', R: 'Arginine', N: 'Asparagine', D: 'Aspartate',
  C: 'Cysteine', Q: 'Glutamine', E: 'Glutamate', G: 'Glycine',
  H: 'Histidine', I: 'Isoleucine', L: 'Leucine', K: 'Lysine',
  M: 'Methionine', F: 'Phenylalanine', P: 'Proline', S: 'Serine',
  T: 'Threonine', W: 'Tryptophan', Y: 'Tyrosine', V: 'Valine',
  '*': 'Stop',
};

// Example sequence for reading frame demo
const DEMO_SEQUENCE = 'ATGGCTTACGAATGCAAGTGA';

interface DegeneracyGroup {
  aa: string;
  name: string;
  codons: string[];
  count: number;
}

function buildDegeneracyGroups(): DegeneracyGroup[] {
  const groups: Record<string, string[]> = {};
  for (const [codon, aa] of Object.entries(CODON_TO_AA)) {
    if (!groups[aa]) groups[aa] = [];
    groups[aa].push(codon);
  }
  return Object.entries(groups)
    .map(([aa, codons]) => ({
      aa,
      name: AA_NAMES[aa] || 'Unknown',
      codons,
      count: codons.length,
    }))
    .sort((a, b) => b.count - a.count);
}

function DegeneracyChart(): JSX.Element {
  const groups = useMemo(() => buildDegeneracyGroups(), []);
  const maxCount = Math.max(...groups.map((g) => g.count));

  return (
    <div
      style={{
        display: 'grid',
        gap: 6,
        maxHeight: 280,
        overflowY: 'auto',
        padding: '4px 0',
      }}
    >
      {groups.map((group) => (
        <div
          key={group.aa}
          style={{
            display: 'grid',
            gridTemplateColumns: '60px 1fr auto',
            alignItems: 'center',
            gap: 10,
          }}
        >
          <div style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
            <span
              style={{
                fontFamily: 'monospace',
                fontWeight: 700,
                fontSize: 16,
                color: group.aa === '*' ? '#ef4444' : '#22c55e',
              }}
            >
              {group.aa}
            </span>
            <span style={{ fontSize: 12, color: 'var(--color-text-muted)' }}>
              {group.name.slice(0, 3)}
            </span>
          </div>
          <div
            style={{
              height: 18,
              background: 'var(--color-surface-1)',
              borderRadius: 4,
              overflow: 'hidden',
              position: 'relative',
            }}
          >
            <div
              style={{
                height: '100%',
                width: `${(group.count / maxCount) * 100}%`,
                background:
                  group.aa === '*'
                    ? 'linear-gradient(90deg, #ef4444, #dc2626)'
                    : 'linear-gradient(90deg, #22c55e, #16a34a)',
                borderRadius: 4,
              }}
            />
          </div>
          <span
            style={{
              fontFamily: 'monospace',
              fontSize: 13,
              color: 'var(--color-text-muted)',
              minWidth: 24,
              textAlign: 'right',
            }}
          >
            {group.count}
          </span>
        </div>
      ))}
    </div>
  );
}

interface ReadingFrameDemoProps {
  sequence: string;
}

function ReadingFrameDemo({ sequence }: ReadingFrameDemoProps): JSX.Element {
  const [frame, setFrame] = useState<0 | 1 | 2>(0);

  const translated = useMemo(() => {
    const results: { frame: number; codons: { codon: string; aa: string }[] }[] = [];
    for (let f = 0; f < 3; f++) {
      const codons: { codon: string; aa: string }[] = [];
      for (let i = f; i + 3 <= sequence.length; i += 3) {
        const codon = sequence.slice(i, i + 3);
        const aa = CODON_TO_AA[codon] || '?';
        codons.push({ codon, aa });
      }
      results.push({ frame: f + 1, codons });
    }
    return results;
  }, [sequence]);

  const baseColors: Record<string, string> = {
    A: '#22c55e',
    C: '#3b82f6',
    G: '#f97316',
    T: '#ef4444',
  };

  return (
    <div
      style={{
        border: '1px solid var(--color-border-subtle)',
        borderRadius: 14,
        padding: 14,
        background: 'var(--color-surface-1)',
      }}
    >
      <div style={{ display: 'flex', gap: 8, marginBottom: 12 }}>
        {[0, 1, 2].map((f) => (
          <button
            key={f}
            type="button"
            className={`btn ${frame === f ? 'btn-primary' : ''}`}
            onClick={() => setFrame(f as 0 | 1 | 2)}
            style={{ flex: 1 }}
          >
            Frame +{f}
          </button>
        ))}
      </div>

      <div
        style={{
          fontFamily: 'monospace',
          fontSize: 14,
          letterSpacing: 1,
          marginBottom: 10,
          overflowX: 'auto',
          whiteSpace: 'nowrap',
        }}
      >
        {sequence.split('').map((base, idx) => {
          const inFrame = idx >= frame && (idx - frame) % 3 < 3;
          const isCodonBoundary = (idx - frame) % 3 === 0 && idx >= frame;
          return (
            <span
              key={idx}
              style={{
                color: baseColors[base] || '#888',
                opacity: idx < frame ? 0.3 : 1,
                fontWeight: inFrame ? 700 : 400,
                marginLeft: isCodonBoundary && idx > frame ? 4 : 0,
              }}
            >
              {base}
            </span>
          );
        })}
      </div>

      <div
        style={{
          display: 'flex',
          gap: 4,
          flexWrap: 'wrap',
          marginTop: 8,
        }}
      >
        {translated[frame].codons.map((item, idx) => (
          <div
            key={idx}
            style={{
              display: 'flex',
              flexDirection: 'column',
              alignItems: 'center',
              padding: '4px 8px',
              borderRadius: 6,
              background:
                item.aa === 'M'
                  ? 'rgba(34, 197, 94, 0.2)'
                  : item.aa === '*'
                    ? 'rgba(239, 68, 68, 0.2)'
                    : 'rgba(255,255,255,0.05)',
              border:
                item.aa === 'M'
                  ? '1px solid #22c55e'
                  : item.aa === '*'
                    ? '1px solid #ef4444'
                    : '1px solid var(--color-border-subtle)',
            }}
          >
            <span style={{ fontFamily: 'monospace', fontSize: 11, color: 'var(--color-text-muted)' }}>
              {item.codon}
            </span>
            <span
              style={{
                fontFamily: 'monospace',
                fontWeight: 700,
                fontSize: 16,
                color: item.aa === 'M' ? '#22c55e' : item.aa === '*' ? '#ef4444' : 'inherit',
              }}
            >
              {item.aa}
            </span>
          </div>
        ))}
      </div>

      <p style={{ marginTop: 10, fontSize: 13, color: 'var(--color-text-muted)' }}>
        <strong>Frame +{frame}</strong>: The reading frame determines which triplets become codons.
        {frame > 0 && ` Skipping the first ${frame} base(s) shifts the entire reading.`}
      </p>
    </div>
  );
}

function CodonTableMini(): JSX.Element {
  const [hoveredAA, setHoveredAA] = useState<string | null>(null);

  const allCodons = useMemo(() => {
    const result: { first: Base; second: Base; third: Base; codon: string; aa: string }[] = [];
    for (const first of BASES) {
      for (const second of BASES) {
        for (const third of BASES) {
          const codon = `${first}${second}${third}`;
          result.push({ first, second, third, codon, aa: CODON_TO_AA[codon] || '?' });
        }
      }
    }
    return result;
  }, []);

  const grouped = useMemo(() => {
    const map: Record<string, Record<string, { codon: string; aa: string }[]>> = {};
    for (const base1 of BASES) {
      map[base1] = {};
      for (const base2 of BASES) {
        map[base1][base2] = allCodons.filter((c) => c.first === base1 && c.second === base2);
      }
    }
    return map;
  }, [allCodons]);

  const baseColors: Record<string, string> = {
    A: '#22c55e',
    C: '#3b82f6',
    G: '#f97316',
    T: '#ef4444',
  };

  return (
    <div style={{ overflowX: 'auto' }}>
      <table
        style={{
          borderCollapse: 'collapse',
          fontSize: 11,
          fontFamily: 'monospace',
          width: '100%',
          minWidth: 400,
        }}
      >
        <thead>
          <tr>
            <th style={{ padding: 4 }}>1st</th>
            <th style={{ padding: 4 }}>2nd</th>
            {BASES.map((b) => (
              <th key={b} style={{ padding: 4, color: baseColors[b] }}>
                {b}
              </th>
            ))}
          </tr>
        </thead>
        <tbody>
          {BASES.map((first) =>
            BASES.map((second, secIdx) => (
              <tr key={`${first}${second}`}>
                {secIdx === 0 && (
                  <td
                    rowSpan={4}
                    style={{
                      padding: 4,
                      fontWeight: 700,
                      color: baseColors[first],
                      verticalAlign: 'middle',
                      borderRight: '1px solid var(--color-border-subtle)',
                    }}
                  >
                    {first}
                  </td>
                )}
                <td
                  style={{
                    padding: 4,
                    fontWeight: 600,
                    color: baseColors[second],
                    borderRight: '1px solid var(--color-border-subtle)',
                  }}
                >
                  {second}
                </td>
                {grouped[first][second].map((item) => {
                  const isStart = item.codon === 'ATG';
                  const isStop = item.aa === '*';
                  const isHovered = hoveredAA === item.aa;
                  return (
                    <td
                      key={item.codon}
                      onMouseEnter={() => setHoveredAA(item.aa)}
                      onMouseLeave={() => setHoveredAA(null)}
                      style={{
                        padding: '3px 5px',
                        textAlign: 'center',
                        cursor: 'default',
                        background: isHovered
                          ? 'rgba(139, 92, 246, 0.25)'
                          : isStart
                            ? 'rgba(34, 197, 94, 0.15)'
                            : isStop
                              ? 'rgba(239, 68, 68, 0.15)'
                              : 'transparent',
                        border: '1px solid var(--color-border-subtle)',
                        borderRadius: 4,
                      }}
                      title={`${item.codon} → ${item.aa} (${AA_NAMES[item.aa] || 'Unknown'})`}
                    >
                      <span style={{ fontWeight: 700, color: isStop ? '#ef4444' : isStart ? '#22c55e' : 'inherit' }}>
                        {item.aa}
                      </span>
                    </td>
                  );
                })}
              </tr>
            ))
          )}
        </tbody>
      </table>
      <p style={{ marginTop: 8, fontSize: 12, color: 'var(--color-text-muted)' }}>
        Hover over amino acids to highlight all codons that encode it. <span style={{ color: '#22c55e' }}>■</span> Start
        (ATG) · <span style={{ color: '#ef4444' }}>■</span> Stop (TAA, TAG, TGA)
      </p>
    </div>
  );
}

interface CodonBiasExampleProps {
  organism: string;
  leucineCodons: { codon: string; percent: number }[];
  accent: string;
}

function CodonBiasExample({ organism, leucineCodons, accent }: CodonBiasExampleProps): JSX.Element {
  return (
    <div
      style={{
        padding: 12,
        borderRadius: 12,
        border: `1px solid ${accent}44`,
        background: `${accent}11`,
      }}
    >
      <p style={{ fontWeight: 700, marginBottom: 8 }}>{organism}</p>
      <div style={{ display: 'grid', gap: 4 }}>
        {leucineCodons.map((item) => (
          <div key={item.codon} style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
            <span style={{ fontFamily: 'monospace', fontWeight: 600, minWidth: 36 }}>{item.codon}</span>
            <div
              style={{
                flex: 1,
                height: 12,
                background: 'rgba(255,255,255,0.1)',
                borderRadius: 6,
                overflow: 'hidden',
              }}
            >
              <div
                style={{
                  height: '100%',
                  width: `${item.percent}%`,
                  background: accent,
                  borderRadius: 6,
                }}
              />
            </div>
            <span style={{ fontFamily: 'monospace', fontSize: 12, minWidth: 32, textAlign: 'right' }}>
              {item.percent}%
            </span>
          </div>
        ))}
      </div>
    </div>
  );
}

function CodonBiasSection(): JSX.Element {
  // Simplified example data for E. coli vs phage T7
  const ecoliLeucine = [
    { codon: 'CTG', percent: 52 },
    { codon: 'CTC', percent: 11 },
    { codon: 'CTT', percent: 10 },
    { codon: 'CTA', percent: 4 },
    { codon: 'TTA', percent: 13 },
    { codon: 'TTG', percent: 10 },
  ];

  const t7Leucine = [
    { codon: 'CTG', percent: 28 },
    { codon: 'CTC', percent: 8 },
    { codon: 'CTT', percent: 22 },
    { codon: 'CTA', percent: 12 },
    { codon: 'TTA', percent: 18 },
    { codon: 'TTG', percent: 12 },
  ];

  return (
    <div
      style={{
        display: 'grid',
        gridTemplateColumns: 'repeat(auto-fit, minmax(220px, 1fr))',
        gap: 12,
      }}
    >
      <CodonBiasExample organism="E. coli (host)" leucineCodons={ecoliLeucine} accent="#3b82f6" />
      <CodonBiasExample organism="Phage T7" leucineCodons={t7Leucine} accent="#22c55e" />
    </div>
  );
}

function KeyConceptCard({
  title,
  value,
  description,
  color,
}: {
  title: string;
  value: string;
  description: string;
  color: string;
}): JSX.Element {
  return (
    <div
      className="panel panel-compact"
      style={{
        borderColor: `${color}44`,
        background: `linear-gradient(135deg, ${color}11, transparent)`,
      }}
    >
      <p className="text-dim" style={{ marginBottom: 4 }}>
        {title}
      </p>
      <p style={{ fontSize: 24, fontWeight: 700, color }}>{value}</p>
      <p style={{ color: 'var(--color-text-muted)', marginTop: 4 }}>{description}</p>
    </div>
  );
}

export function GeneticCodeModule(): JSX.Element {
  const { completeModule, hasCompletedModule } = useBeginnerMode();
  const done = hasCompletedModule(MODULE_ID);
  const [activeTab, setActiveTab] = useState<'wheel' | 'table' | 'frames' | 'bias'>('wheel');

  const handleComplete = useCallback(() => {
    completeModule(MODULE_ID);
  }, [completeModule]);

  return (
    <div className="panel" style={{ display: 'flex', flexDirection: 'column', gap: 16 }}>
      <header
        style={{
          display: 'flex',
          flexWrap: 'wrap',
          gap: 12,
          alignItems: 'center',
          justifyContent: 'space-between',
        }}
      >
        <div>
          <p className="text-dim" style={{ letterSpacing: 0.4 }}>
            Foundations · Module 5
          </p>
          <h2 style={{ margin: 0 }}>The Genetic Code</h2>
          <p style={{ margin: '6px 0 0', color: 'var(--color-text-muted)' }}>
            How 64 three-letter codons encode 20 amino acids—plus start and stop signals.
          </p>
        </div>
        <div style={{ display: 'flex', gap: 8, alignItems: 'center' }}>
          <span className="badge">{done ? 'Completed' : '10–12 min'}</span>
          <button
            type="button"
            className="btn"
            onClick={handleComplete}
            disabled={done}
            aria-pressed={done}
          >
            {done ? 'Marked Complete' : 'Mark Complete'}
          </button>
        </div>
      </header>

      {/* Key concepts */}
      <section
        style={{
          display: 'grid',
          gridTemplateColumns: 'repeat(auto-fit, minmax(180px, 1fr))',
          gap: 12,
        }}
      >
        <KeyConceptCard
          title="Alphabet"
          value="4 bases"
          description="A, C, G, T form the DNA alphabet used in codons"
          color="#8b5cf6"
        />
        <KeyConceptCard
          title="Combinations"
          value="64 codons"
          description="4³ = 64 possible three-letter words"
          color="#3b82f6"
        />
        <KeyConceptCard
          title="Amino acids"
          value="20 + Stop"
          description="61 codons encode 20 AAs, 3 are stop signals"
          color="#22c55e"
        />
        <KeyConceptCard
          title="Degeneracy"
          value="Redundant"
          description="Multiple codons can encode the same amino acid"
          color="#f97316"
        />
      </section>

      {/* Tab navigation */}
      <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap' }}>
        {[
          { id: 'wheel', label: 'Codon Wheel' },
          { id: 'table', label: 'Codon Table' },
          { id: 'frames', label: 'Reading Frames' },
          { id: 'bias', label: 'Codon Bias' },
        ].map((tab) => (
          <button
            key={tab.id}
            type="button"
            className={`btn ${activeTab === tab.id ? 'btn-primary' : ''}`}
            onClick={() => setActiveTab(tab.id as typeof activeTab)}
          >
            {tab.label}
          </button>
        ))}
      </div>

      {/* Tab content */}
      {activeTab === 'wheel' && (
        <section
          style={{
            display: 'grid',
            gridTemplateColumns: 'minmax(280px, 1fr) minmax(260px, 1fr)',
            gap: 16,
            alignItems: 'start',
          }}
        >
          <div className="panel panel-compact">
            <p className="text-dim" style={{ letterSpacing: 0.3, marginBottom: 4 }}>
              Interactive
            </p>
            <h3 style={{ margin: '0 0 8px' }}>Codon Wheel</h3>
            <p style={{ color: 'var(--color-text-muted)', marginBottom: 12 }}>
              Click the rings to select bases and see which amino acid the codon encodes.
            </p>
            <CodonWheelVisualizer />
          </div>

          <div className="panel panel-compact">
            <p className="text-dim" style={{ letterSpacing: 0.3, marginBottom: 4 }}>
              Degeneracy
            </p>
            <h3 style={{ margin: '0 0 8px' }}>Codons per Amino Acid</h3>
            <p style={{ color: 'var(--color-text-muted)', marginBottom: 12 }}>
              Some amino acids are encoded by up to 6 different codons (e.g., Leucine, Serine).
              This redundancy provides mutation tolerance.
            </p>
            <DegeneracyChart />
          </div>
        </section>
      )}

      {activeTab === 'table' && (
        <section className="panel panel-compact">
          <p className="text-dim" style={{ letterSpacing: 0.3, marginBottom: 4 }}>
            Reference
          </p>
          <h3 style={{ margin: '0 0 8px' }}>Complete Codon Table</h3>
          <p style={{ color: 'var(--color-text-muted)', marginBottom: 12 }}>
            All 64 codons organized by first and second base. Third base often varies without changing the amino acid
            (wobble position).
          </p>
          <CodonTableMini />
        </section>
      )}

      {activeTab === 'frames' && (
        <section className="panel panel-compact">
          <p className="text-dim" style={{ letterSpacing: 0.3, marginBottom: 4 }}>
            Demo
          </p>
          <h3 style={{ margin: '0 0 8px' }}>Reading Frames</h3>
          <p style={{ color: 'var(--color-text-muted)', marginBottom: 12 }}>
            DNA can be read in three different frames depending on where translation starts.
            The same sequence yields completely different proteins in each frame.
          </p>
          <ReadingFrameDemo sequence={DEMO_SEQUENCE} />
          <div
            style={{
              marginTop: 14,
              padding: 12,
              borderRadius: 10,
              background: 'rgba(139, 92, 246, 0.1)',
              border: '1px solid rgba(139, 92, 246, 0.3)',
            }}
          >
            <p style={{ fontWeight: 600, marginBottom: 4 }}>Why it matters</p>
            <p style={{ color: 'var(--color-text-muted)', fontSize: 14 }}>
              Many phages use overlapping reading frames to pack more genes into limited genome space.
              A frameshift mutation can completely change the resulting protein—or create a premature stop.
            </p>
          </div>
        </section>
      )}

      {activeTab === 'bias' && (
        <section className="panel panel-compact">
          <p className="text-dim" style={{ letterSpacing: 0.3, marginBottom: 4 }}>
            Advanced
          </p>
          <h3 style={{ margin: '0 0 8px' }}>Codon Bias</h3>
          <p style={{ color: 'var(--color-text-muted)', marginBottom: 12 }}>
            Different organisms prefer different codons for the same amino acid.
            This affects translation speed since tRNA abundance varies.
          </p>
          <CodonBiasSection />
          <div
            style={{
              marginTop: 14,
              padding: 12,
              borderRadius: 10,
              background: 'rgba(34, 197, 94, 0.1)',
              border: '1px solid rgba(34, 197, 94, 0.3)',
            }}
          >
            <p style={{ fontWeight: 600, marginBottom: 4 }}>Phage adaptation</p>
            <p style={{ color: 'var(--color-text-muted)', fontSize: 14 }}>
              Phages often evolve codon usage patterns similar to their host bacteria.
              This ensures efficient translation of viral proteins using the host's tRNA pool.
            </p>
          </div>
        </section>
      )}

      {/* Summary section */}
      <section className="panel panel-compact">
        <p className="text-dim" style={{ letterSpacing: 0.3, marginBottom: 4 }}>
          Key Takeaways
        </p>
        <h3 style={{ margin: '0 0 8px' }}>The Genetic Code</h3>
        <ul style={{ margin: 0, paddingLeft: 20, color: 'var(--color-text-muted)' }}>
          <li>
            <strong>Codons are triplets:</strong> Three DNA bases encode one amino acid
          </li>
          <li>
            <strong>64 → 21:</strong> 64 codons map to 20 amino acids plus 3 stop signals
          </li>
          <li>
            <strong>ATG = Start:</strong> Methionine codon that initiates translation
          </li>
          <li>
            <strong>TAA, TAG, TGA = Stop:</strong> Signal the ribosome to release the protein
          </li>
          <li>
            <strong>Degeneracy:</strong> Multiple codons can encode the same amino acid (mutation tolerance)
          </li>
          <li>
            <strong>Reading frames:</strong> The same DNA can produce different proteins depending on start position
          </li>
        </ul>
      </section>
    </div>
  );
}

export default GeneticCodeModule;
