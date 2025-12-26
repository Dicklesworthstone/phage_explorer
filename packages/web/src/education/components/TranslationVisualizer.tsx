/**
 * TranslationVisualizer
 *
 * Animated walkthrough of translation: ribosome stepping codon-by-codon,
 * matching tRNA anticodons, and extending the nascent polypeptide chain.
 * Uses amino acid palette from core + active theme to stay consistent with AAKey.
 */

import React, { useCallback, useEffect, useMemo, useState } from 'react';
import { AMINO_ACIDS, CODON_TABLE, type AminoAcidInfo } from '@phage-explorer/core';
import { useTheme } from '../../hooks/useTheme';
import type { AminoAcid } from '../../theme/types';

type TranslationStep = {
  codon: string;
  amino: string;
};

type TranslationVisualizerProps = {
  sequence?: string;
  speedMs?: number;
  loop?: boolean;
  title?: string;
};

const DEFAULT_SEQUENCE =
  'ATGGTGAAATTTGCCGACTACGAGGAGGCTTCTGAGGACGTTGGTGAGGATGAATGA'; // encodes: MVKFA DYE E ALS EEVGEDE*

const MAX_CODONS = 16;

function cleanSequence(seq: string | undefined): string {
  if (!seq) return DEFAULT_SEQUENCE;
  return seq.toUpperCase().replace(/[^ACGT]/g, '') || DEFAULT_SEQUENCE;
}

function toSteps(sequence: string): TranslationStep[] {
  const steps: TranslationStep[] = [];
  for (let i = 0; i + 2 < sequence.length && steps.length < MAX_CODONS; i += 3) {
    const codon = sequence.slice(i, i + 3);
    const amino = CODON_TABLE[codon] ?? 'X';
    steps.push({ codon, amino });
  }
  return steps;
}

function anticodon(dnaCodon: string): string {
  // tRNA anticodon (RNA) pairs with mRNA codon.
  // DNA T -> RNA A. DNA A -> RNA U. G-C pair.
  // DNA template: TAC. mRNA: AUG. tRNA: UAC.
  // We input DNA coding strand (ATG).
  // ATG -> (complement) TAC -> (RNA) UAC.
  // Map: A->U, T->A, G->C, C->G.
  const map: Record<string, string> = { A: 'U', T: 'A', G: 'C', C: 'G' };
  return dnaCodon
    .split('')
    .map((b) => map[b] ?? 'N')
    .join('');
}

function aminoInfo(amino: string): AminoAcidInfo | undefined {
  return AMINO_ACIDS[amino as keyof typeof AMINO_ACIDS];
}

export function TranslationVisualizer({
  sequence,
  speedMs = 1200,
  loop = true,
  title = 'Translation visualizer',
}: TranslationVisualizerProps): React.ReactElement | null {
  const { theme } = useTheme();
  const steps = useMemo(() => toSteps(cleanSequence(sequence)), [sequence]);
  const [index, setIndex] = useState(0);
  const [isPlaying, setIsPlaying] = useState(true);

  const current = steps[index];
  const produced = steps.slice(0, index).map((s) => s.amino).filter((a) => a !== '*');
  const info = aminoInfo(current?.amino ?? '');

  const advance = useCallback(() => {
    setIndex((prev) => {
      const next = prev + 1;
      if (next >= steps.length) {
        return loop ? 0 : prev;
      }
      return next;
    });
  }, [loop, steps.length]);

  useEffect(() => {
    if (!isPlaying) return;
    const id = setInterval(advance, Math.max(400, speedMs));
    return () => clearInterval(id);
  }, [advance, isPlaying, speedMs]);

  if (!current) return null;

  const ribosomeProgress = Math.min(1, index / Math.max(1, steps.length - 1));
  const aminoPalette = theme.aminoAcids[current.amino as AminoAcid] ?? { fg: theme.colors.text, bg: theme.colors.backgroundAlt };
  const isStart = current.codon === 'ATG';
  const isStop = current.amino === '*';

  return (
    <div className="translation-viz">
      <div className="translation-viz__header">
        <div>
          <p className="text-dim">{title}</p>
          <p className="text-strong">Ribosome walking codon-by-codon</p>
        </div>
        <div className="translation-viz__controls" role="group" aria-label="Playback controls">
          <button
            type="button"
            className="btn btn-ghost"
            onClick={() => setIsPlaying((v) => !v)}
            aria-pressed={isPlaying}
          >
            {isPlaying ? 'Pause' : 'Play'}
          </button>
          <button type="button" className="btn btn-ghost" onClick={advance}>
            Step
          </button>
        </div>
      </div>

      <div className="translation-viz__layout">
        <div className="translation-viz__timeline" aria-label="mRNA codons">
          {steps.map((step, i) => {
            const status = i < index ? 'done' : i === index ? 'active' : 'todo';
            const palette = aminoInfo(step.amino) ? theme.aminoAcids[step.amino as AminoAcid] : undefined;
            return (
              <div
                key={`${step.codon}-${i}`}
                className={`translation-viz__codon translation-viz__codon--${status}`}
                aria-current={status === 'active'}
              >
                <div className="translation-viz__codon-text">{step.codon.replace(/T/g, 'U')}</div>
                <div
                  className="translation-viz__codon-aa"
                  style={{
                    background: palette?.bg ?? 'var(--color-surface-2)',
                    color: palette?.fg ?? 'var(--color-text)',
                  }}
                >
                  {step.amino === '*' ? 'Stop' : step.amino}
                </div>
              </div>
            );
          })}
        </div>

        <div className="translation-viz__panel">
          <div className="translation-viz__ribosome">
            <div className="translation-viz__track" aria-label="Ribosome position">
              <div
                className="translation-viz__ribosome-body"
                style={{
                  left: `${ribosomeProgress * 100}%`,
                  background: aminoPalette.bg,
                  color: aminoPalette.fg,
                }}
              >
                Ribosome
              </div>
              <div className="translation-viz__track-line" />
            </div>

            <div className="translation-viz__cards">
              <div className="translation-viz__card">
                <div className="label">mRNA codon</div>
                <div className="value mono">{current.codon.replace(/T/g, 'U')}</div>
                <div className="hint">Position {index + 1} of {steps.length}</div>
              </div>
              <div className="translation-viz__card">
                <div className="label">tRNA anticodon</div>
                <div className="value mono">{anticodon(current.codon)}</div>
                <div className="hint">Complementary pairing</div>
              </div>
              <div className="translation-viz__card">
                <div className="label">Amino acid</div>
                <div className="value chip" style={{ background: aminoPalette.bg, color: aminoPalette.fg }}>
                  {info?.name ?? (isStop ? 'Stop' : 'Unknown')}
                </div>
                <div className="hint">
                  {isStart && 'Start codon (AUG)'}
                  {isStop && 'Stop signal — release'}
                  {!isStart && !isStop && info?.property}
                </div>
              </div>
            </div>
          </div>

          <div className="translation-viz__chain" aria-label="Nascent polypeptide">
            <div className="translation-viz__chain-label">Growing chain</div>
            <div className="translation-viz__chain-track">
              {produced.length === 0 && <span className="text-dim">No amino acids yet</span>}
              {produced.map((aa, idx) => {
                const palette = theme.aminoAcids[aa as AminoAcid] ?? { bg: theme.colors.backgroundAlt, fg: theme.colors.text };
                const info = aminoInfo(aa);
                return (
                  <span
                    key={`${aa}-${idx}`}
                    className="translation-viz__chain-aa"
                    style={{ background: palette.bg, color: palette.fg }}
                    title={info?.name ?? aa}
                  >
                    {aa}
                  </span>
                );
              })}
            </div>
          </div>
        </div>
      </div>
    </div>
  );
}

export default TranslationVisualizer;
