import React, { useState, useCallback } from 'react';
import { useBeginnerMode } from '../hooks/useBeginnerMode';
import { TranslationVisualizer } from '../components/TranslationVisualizer';
import type { ModuleId } from '../types';

const MODULE_ID: ModuleId = 'central-dogma';

// Step in the central dogma flow
interface FlowStep {
  id: string;
  title: string;
  molecule: string;
  description: string;
  color: string;
  icon: string;
}

const FLOW_STEPS: FlowStep[] = [
  {
    id: 'dna',
    title: 'DNA',
    molecule: 'Double helix',
    description: 'The master blueprint stored in the genome. Contains all genetic instructions.',
    color: '#8b5cf6',
    icon: '🧬',
  },
  {
    id: 'rna',
    title: 'mRNA',
    molecule: 'Single strand',
    description: 'Messenger RNA: a working copy of a gene, carried from nucleus to ribosome.',
    color: '#3b82f6',
    icon: '📜',
  },
  {
    id: 'protein',
    title: 'Protein',
    molecule: 'Amino acid chain',
    description: 'The functional product: enzymes, structural components, signaling molecules.',
    color: '#22c55e',
    icon: '⚙️',
  },
];

interface ProcessStep {
  id: string;
  name: string;
  from: string;
  to: string;
  description: string;
  keyPlayers: string[];
  color: string;
}

const PROCESSES: ProcessStep[] = [
  {
    id: 'transcription',
    name: 'Transcription',
    from: 'DNA',
    to: 'mRNA',
    description: 'RNA polymerase reads the DNA template and synthesizes a complementary mRNA strand.',
    keyPlayers: ['RNA Polymerase', 'Promoter', 'Terminator', 'Template strand'],
    color: '#8b5cf6',
  },
  {
    id: 'translation',
    name: 'Translation',
    from: 'mRNA',
    to: 'Protein',
    description: 'Ribosomes decode mRNA codons and assemble amino acids into a polypeptide chain.',
    keyPlayers: ['Ribosome', 'tRNA', 'Amino acids', 'Start/Stop codons'],
    color: '#22c55e',
  },
];

function FlowDiagram({ activeStep }: { activeStep: string | null }): JSX.Element {
  return (
    <div
      style={{
        display: 'flex',
        alignItems: 'center',
        justifyContent: 'center',
        gap: 8,
        padding: '20px 10px',
        background: 'linear-gradient(135deg, rgba(139, 92, 246, 0.08), rgba(34, 197, 94, 0.08))',
        borderRadius: 16,
        overflowX: 'auto',
      }}
    >
      {FLOW_STEPS.map((step, idx) => (
        <React.Fragment key={step.id}>
          <div
            style={{
              display: 'flex',
              flexDirection: 'column',
              alignItems: 'center',
              padding: '16px 20px',
              borderRadius: 14,
              background: activeStep === step.id ? `${step.color}22` : 'rgba(255,255,255,0.05)',
              border: `2px solid ${activeStep === step.id ? step.color : 'transparent'}`,
              transition: 'all 0.2s ease',
              minWidth: 100,
            }}
          >
            <span style={{ fontSize: 28, marginBottom: 6 }}>{step.icon}</span>
            <span style={{ fontWeight: 700, fontSize: 16, color: step.color }}>{step.title}</span>
            <span style={{ fontSize: 12, color: 'var(--color-text-muted)' }}>{step.molecule}</span>
          </div>
          {idx < FLOW_STEPS.length - 1 && (
            <div
              style={{
                display: 'flex',
                flexDirection: 'column',
                alignItems: 'center',
                padding: '0 4px',
              }}
            >
              <div
                style={{
                  width: 40,
                  height: 3,
                  background: `linear-gradient(90deg, ${FLOW_STEPS[idx].color}, ${FLOW_STEPS[idx + 1].color})`,
                  borderRadius: 2,
                }}
              />
              <span style={{ fontSize: 11, color: 'var(--color-text-muted)', marginTop: 4 }}>
                {idx === 0 ? 'Transcription' : 'Translation'}
              </span>
            </div>
          )}
        </React.Fragment>
      ))}
    </div>
  );
}

function ProcessCard({ process, isActive, onClick }: { process: ProcessStep; isActive: boolean; onClick: () => void }): JSX.Element {
  return (
    <button
      type="button"
      onClick={onClick}
      style={{
        all: 'unset',
        cursor: 'pointer',
        display: 'flex',
        flexDirection: 'column',
        padding: 14,
        borderRadius: 14,
        background: isActive ? `${process.color}15` : 'var(--color-surface-1)',
        border: `2px solid ${isActive ? process.color : 'var(--color-border-subtle)'}`,
        transition: 'all 0.2s ease',
      }}
    >
      <div style={{ display: 'flex', alignItems: 'center', gap: 10, marginBottom: 8 }}>
        <span
          style={{
            padding: '4px 10px',
            borderRadius: 999,
            background: `${process.color}22`,
            color: process.color,
            fontSize: 12,
            fontWeight: 600,
          }}
        >
          {process.from} → {process.to}
        </span>
        <span style={{ fontWeight: 700, fontSize: 16 }}>{process.name}</span>
      </div>
      <p style={{ color: 'var(--color-text-muted)', margin: 0, fontSize: 14 }}>{process.description}</p>
      <div style={{ display: 'flex', flexWrap: 'wrap', gap: 6, marginTop: 10 }}>
        {process.keyPlayers.map((player) => (
          <span
            key={player}
            style={{
              padding: '3px 8px',
              borderRadius: 6,
              background: 'rgba(255,255,255,0.08)',
              fontSize: 12,
              color: 'var(--color-text-muted)',
            }}
          >
            {player}
          </span>
        ))}
      </div>
    </button>
  );
}

function TranscriptionDetail(): JSX.Element {
  const steps = [
    { phase: 'Initiation', description: 'RNA polymerase binds to the promoter sequence and unwinds the DNA double helix.' },
    { phase: 'Elongation', description: 'RNA polymerase moves along the template strand, synthesizing mRNA 5\' to 3\'.' },
    { phase: 'Termination', description: 'A terminator sequence signals the end; mRNA is released.' },
  ];

  return (
    <div
      style={{
        padding: 14,
        borderRadius: 14,
        background: 'rgba(139, 92, 246, 0.08)',
        border: '1px solid rgba(139, 92, 246, 0.3)',
      }}
    >
      <h4 style={{ margin: '0 0 12px', color: '#8b5cf6' }}>Transcription Steps</h4>
      <div style={{ display: 'grid', gap: 10 }}>
        {steps.map((step, idx) => (
          <div key={step.phase} style={{ display: 'flex', gap: 12, alignItems: 'flex-start' }}>
            <span
              style={{
                width: 28,
                height: 28,
                borderRadius: '50%',
                background: '#8b5cf6',
                color: 'white',
                display: 'flex',
                alignItems: 'center',
                justifyContent: 'center',
                fontWeight: 700,
                fontSize: 14,
                flexShrink: 0,
              }}
            >
              {idx + 1}
            </span>
            <div>
              <p style={{ margin: 0, fontWeight: 600 }}>{step.phase}</p>
              <p style={{ margin: '4px 0 0', color: 'var(--color-text-muted)', fontSize: 14 }}>{step.description}</p>
            </div>
          </div>
        ))}
      </div>
      <div
        style={{
          marginTop: 14,
          padding: 10,
          borderRadius: 10,
          background: 'rgba(255,255,255,0.05)',
        }}
      >
        <p style={{ margin: 0, fontWeight: 600, fontSize: 13 }}>Base pairing in transcription</p>
        <p style={{ margin: '4px 0 0', fontSize: 13, color: 'var(--color-text-muted)' }}>
          DNA template <strong>A → U</strong>, <strong>T → A</strong>, <strong>G → C</strong>, <strong>C → G</strong> in mRNA
        </p>
        <p style={{ margin: '4px 0 0', fontSize: 12, color: 'var(--color-text-muted)' }}>
          Note: RNA uses Uracil (U) instead of Thymine (T)
        </p>
      </div>
    </div>
  );
}

function TranslationDetail(): JSX.Element {
  const steps = [
    { phase: 'Initiation', description: 'Ribosome assembles at the start codon (AUG), with initiator tRNA carrying Methionine.' },
    { phase: 'Elongation', description: 'tRNAs deliver amino acids; ribosome catalyzes peptide bond formation.' },
    { phase: 'Termination', description: 'Stop codon reached; release factors trigger protein release.' },
  ];

  return (
    <div
      style={{
        padding: 14,
        borderRadius: 14,
        background: 'rgba(34, 197, 94, 0.08)',
        border: '1px solid rgba(34, 197, 94, 0.3)',
      }}
    >
      <h4 style={{ margin: '0 0 12px', color: '#22c55e' }}>Translation Steps</h4>
      <div style={{ display: 'grid', gap: 10 }}>
        {steps.map((step, idx) => (
          <div key={step.phase} style={{ display: 'flex', gap: 12, alignItems: 'flex-start' }}>
            <span
              style={{
                width: 28,
                height: 28,
                borderRadius: '50%',
                background: '#22c55e',
                color: 'white',
                display: 'flex',
                alignItems: 'center',
                justifyContent: 'center',
                fontWeight: 700,
                fontSize: 14,
                flexShrink: 0,
              }}
            >
              {idx + 1}
            </span>
            <div>
              <p style={{ margin: 0, fontWeight: 600 }}>{step.phase}</p>
              <p style={{ margin: '4px 0 0', color: 'var(--color-text-muted)', fontSize: 14 }}>{step.description}</p>
            </div>
          </div>
        ))}
      </div>
      <div
        style={{
          marginTop: 14,
          padding: 10,
          borderRadius: 10,
          background: 'rgba(255,255,255,0.05)',
        }}
      >
        <p style={{ margin: 0, fontWeight: 600, fontSize: 13 }}>Key players</p>
        <ul style={{ margin: '8px 0 0', paddingLeft: 18, fontSize: 13, color: 'var(--color-text-muted)' }}>
          <li><strong>Ribosome:</strong> The molecular machine that reads mRNA and builds protein</li>
          <li><strong>tRNA:</strong> Adapter molecules that carry amino acids to match codons</li>
          <li><strong>Amino acids:</strong> Building blocks linked by peptide bonds</li>
        </ul>
      </div>
    </div>
  );
}

function SequencePredictionSection(): JSX.Element {
  const examples = [
    {
      name: 'Enzyme active site',
      description: 'Specific amino acid sequences create catalytic pockets that bind substrates.',
      implication: 'A single mutation can destroy enzyme function.',
      color: '#f97316',
    },
    {
      name: 'Signal peptide',
      description: 'N-terminal sequences direct proteins to specific cellular locations.',
      implication: 'Sequence determines where the protein ends up.',
      color: '#3b82f6',
    },
    {
      name: 'Structural motifs',
      description: 'Alpha helices and beta sheets form from predictable sequence patterns.',
      implication: 'Sequence dictates 3D structure.',
      color: '#8b5cf6',
    },
  ];

  return (
    <div className="panel panel-compact">
      <p className="text-dim" style={{ letterSpacing: 0.3, marginBottom: 4 }}>Why It Matters</p>
      <h3 style={{ margin: '0 0 8px' }}>Sequence → Structure → Function</h3>
      <p style={{ color: 'var(--color-text-muted)', marginBottom: 14 }}>
        The central dogma explains why we can predict protein function from DNA sequence alone.
        Each step preserves information: DNA encodes mRNA, mRNA encodes protein structure.
      </p>
      <div style={{ display: 'grid', gap: 10 }}>
        {examples.map((ex) => (
          <div
            key={ex.name}
            style={{
              padding: 12,
              borderRadius: 12,
              background: `${ex.color}11`,
              border: `1px solid ${ex.color}33`,
            }}
          >
            <p style={{ margin: 0, fontWeight: 700, color: ex.color }}>{ex.name}</p>
            <p style={{ margin: '4px 0', fontSize: 14, color: 'var(--color-text-muted)' }}>{ex.description}</p>
            <p style={{ margin: 0, fontSize: 13, fontStyle: 'italic', color: 'var(--color-text-muted)' }}>
              → {ex.implication}
            </p>
          </div>
        ))}
      </div>
    </div>
  );
}

function PhageContextSection(): JSX.Element {
  return (
    <div
      style={{
        padding: 14,
        borderRadius: 14,
        background: 'linear-gradient(135deg, rgba(34, 197, 94, 0.1), rgba(59, 130, 246, 0.1))',
        border: '1px solid rgba(34, 197, 94, 0.3)',
      }}
    >
      <h4 style={{ margin: '0 0 10px' }}>The Central Dogma in Phages</h4>
      <ul style={{ margin: 0, paddingLeft: 18, color: 'var(--color-text-muted)', fontSize: 14 }}>
        <li style={{ marginBottom: 6 }}>
          <strong>Hijacking machinery:</strong> Phages inject their DNA/RNA and use the host's
          ribosomes to translate viral proteins.
        </li>
        <li style={{ marginBottom: 6 }}>
          <strong>Early vs. late genes:</strong> Temporal control—early genes take over the host,
          late genes build new phage particles.
        </li>
        <li style={{ marginBottom: 6 }}>
          <strong>Compact genomes:</strong> Overlapping reading frames and polycistronic mRNAs
          maximize coding density.
        </li>
        <li>
          <strong>RNA phages:</strong> Some phages skip DNA entirely—their RNA is both genome and mRNA.
        </li>
      </ul>
    </div>
  );
}

export function CentralDogmaModule(): JSX.Element {
  const { completeModule, hasCompletedModule } = useBeginnerMode();
  const done = hasCompletedModule(MODULE_ID);
  const [activeProcess, setActiveProcess] = useState<'transcription' | 'translation'>('transcription');

  const handleComplete = useCallback(() => {
    completeModule(MODULE_ID);
  }, [completeModule]);

  const activeFlowStep = activeProcess === 'transcription' ? 'dna' : 'protein';

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
            Foundations · Module 4
          </p>
          <h2 style={{ margin: 0 }}>The Central Dogma</h2>
          <p style={{ margin: '6px 0 0', color: 'var(--color-text-muted)' }}>
            DNA → RNA → Protein: how genetic information flows from blueprint to function.
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

      {/* Flow diagram */}
      <section className="panel panel-compact">
        <p className="text-dim" style={{ letterSpacing: 0.3, marginBottom: 4 }}>Overview</p>
        <h3 style={{ margin: '0 0 8px' }}>Information Flow</h3>
        <p style={{ color: 'var(--color-text-muted)', marginBottom: 12 }}>
          The central dogma describes how genetic information is stored, copied, and expressed.
          DNA holds the master code; transcription creates RNA copies; translation builds proteins.
        </p>
        <FlowDiagram activeStep={activeFlowStep} />
      </section>

      {/* Process selection */}
      <section
        style={{
          display: 'grid',
          gridTemplateColumns: 'repeat(auto-fit, minmax(280px, 1fr))',
          gap: 12,
        }}
      >
        {PROCESSES.map((process) => (
          <ProcessCard
            key={process.id}
            process={process}
            isActive={activeProcess === process.id}
            onClick={() => setActiveProcess(process.id as typeof activeProcess)}
          />
        ))}
      </section>

      {/* Process details */}
      <section
        style={{
          display: 'grid',
          gridTemplateColumns: 'repeat(auto-fit, minmax(300px, 1fr))',
          gap: 16,
          alignItems: 'start',
        }}
      >
        {activeProcess === 'transcription' ? <TranscriptionDetail /> : <TranslationDetail />}

        {activeProcess === 'translation' && (
          <div className="panel panel-compact">
            <p className="text-dim" style={{ letterSpacing: 0.3, marginBottom: 4 }}>Interactive</p>
            <h3 style={{ margin: '0 0 8px' }}>Ribosome in Action</h3>
            <p style={{ color: 'var(--color-text-muted)', marginBottom: 12 }}>
              Watch the ribosome walk along mRNA, matching codons to tRNAs and building a protein.
            </p>
            <TranslationVisualizer speedMs={1400} loop={true} title="Translation demo" />
          </div>
        )}

        {activeProcess === 'transcription' && (
          <div
            style={{
              padding: 14,
              borderRadius: 14,
              background: 'var(--color-surface-1)',
              border: '1px solid var(--color-border-subtle)',
            }}
          >
            <h4 style={{ margin: '0 0 10px' }}>Template vs. Coding Strand</h4>
            <div
              style={{
                fontFamily: 'monospace',
                fontSize: 13,
                display: 'grid',
                gap: 6,
              }}
            >
              <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
                <span style={{ color: 'var(--color-text-muted)', minWidth: 100 }}>Coding (5'→3'):</span>
                <span style={{ color: '#8b5cf6' }}>5'-ATG GCT TAC GAA-3'</span>
              </div>
              <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
                <span style={{ color: 'var(--color-text-muted)', minWidth: 100 }}>Template (3'→5'):</span>
                <span style={{ color: '#3b82f6' }}>3'-TAC CGA ATG CTT-5'</span>
              </div>
              <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
                <span style={{ color: 'var(--color-text-muted)', minWidth: 100 }}>mRNA (5'→3'):</span>
                <span style={{ color: '#22c55e' }}>5'-AUG GCU UAC GAA-3'</span>
              </div>
            </div>
            <p style={{ marginTop: 10, fontSize: 13, color: 'var(--color-text-muted)' }}>
              RNA polymerase reads the template strand 3'→5' and synthesizes mRNA 5'→3'.
              The mRNA sequence matches the coding strand (with U instead of T).
            </p>
          </div>
        )}
      </section>

      {/* Sequence prediction section */}
      <SequencePredictionSection />

      {/* Phage context */}
      <PhageContextSection />

      {/* Summary */}
      <section className="panel panel-compact">
        <p className="text-dim" style={{ letterSpacing: 0.3, marginBottom: 4 }}>Key Takeaways</p>
        <h3 style={{ margin: '0 0 8px' }}>The Central Dogma</h3>
        <ul style={{ margin: 0, paddingLeft: 20, color: 'var(--color-text-muted)' }}>
          <li>
            <strong>DNA → RNA → Protein:</strong> The one-way flow of genetic information
          </li>
          <li>
            <strong>Transcription:</strong> RNA polymerase copies DNA into mRNA
          </li>
          <li>
            <strong>Translation:</strong> Ribosomes decode mRNA into amino acid sequences
          </li>
          <li>
            <strong>Information preservation:</strong> Each step faithfully transfers sequence information
          </li>
          <li>
            <strong>Predictive power:</strong> Knowing DNA sequence lets us predict protein structure and function
          </li>
          <li>
            <strong>Phage exploitation:</strong> Viruses hijack this machinery to replicate themselves
          </li>
        </ul>
      </section>
    </div>
  );
}

export default CentralDogmaModule;
