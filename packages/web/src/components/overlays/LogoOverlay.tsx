/**
 * LogoOverlay - Sequence Logo
 *
 * Web port of the TUI LogoOverlay using `computeSequenceLogo()` from @phage-explorer/core.
 *
 * This implementation uses real data: an alignment of fixed-width windows around
 * CDS translation start sites in the current phage genome ("gene-start motif").
 */

import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import type { AlphabetType, GeneInfo, PhageFull } from '@phage-explorer/core';
import { computeSequenceLogo, reverseComplement } from '@phage-explorer/core';
import type { LogoColumn } from '@phage-explorer/core';
import type { PhageRepository } from '../../db';
import { useTheme } from '../../hooks/useTheme';
import { Overlay } from './Overlay';
import { useOverlay } from './OverlayProvider';

interface LogoOverlayProps {
  repository: PhageRepository | null;
  currentPhage: PhageFull | null;
}

const UPSTREAM_BP = 20;
const DOWNSTREAM_BP = 10;
const WINDOW_BP = UPSTREAM_BP + DOWNSTREAM_BP;
const STACK_HEIGHT_PX = 120;

type LogoSourceMode = 'gene-start' | 'custom';
type AlphabetMode = 'auto' | AlphabetType;
type AlignmentFormat = 'fasta' | 'clustal';

const MAX_BITS_BY_ALPHABET: Record<AlphabetType, number> = {
  dna: Math.log2(4),
  protein: Math.log2(20),
};

function isReverseStrand(strand: string | null): boolean {
  return (strand ?? '').trim() === '-';
}

function formatRelativePosition(pos: number): string {
  if (pos > 0) return `+${pos}`;
  return `${pos}`;
}

function buildGeneStartAlignment(genome: string, genes: GeneInfo[]): { alignment: string[]; totalCds: number } {
  const upperGenome = genome.toUpperCase();
  const genomeLength = upperGenome.length;

  const cdsGenes = genes.filter((g) => (g.type ?? '').toUpperCase() === 'CDS');

  // Collapse multi-segment CDS rows (e.g. join / wrap-around) into a single
  // anchor point so we don't over-count the same gene multiple times.
  type CdsAnchor = { strand: string | null; minStartPos: number; maxEndPos: number };
  const anchorsByKey = new Map<string, CdsAnchor>();

  for (const gene of cdsGenes) {
    const locusTag = (gene.locusTag ?? '').trim();
    const key = locusTag ? `locus:${locusTag}` : `id:${gene.id}`;
    const existing = anchorsByKey.get(key);
    if (!existing) {
      anchorsByKey.set(key, { strand: gene.strand, minStartPos: gene.startPos, maxEndPos: gene.endPos });
      continue;
    }
    existing.minStartPos = Math.min(existing.minStartPos, gene.startPos);
    existing.maxEndPos = Math.max(existing.maxEndPos, gene.endPos);
    // Preserve the first non-null strand we see (they should be consistent).
    if (!existing.strand && gene.strand) {
      existing.strand = gene.strand;
    }
  }

  const alignment: string[] = [];

  const orderedAnchors = [...anchorsByKey.values()].sort((a, b) => {
    const anchorA = isReverseStrand(a.strand) ? a.maxEndPos : a.minStartPos;
    const anchorB = isReverseStrand(b.strand) ? b.maxEndPos : b.minStartPos;
    return anchorA - anchorB;
  });

  for (const gene of orderedAnchors) {
    const startPos = gene.minStartPos;
    const endPos = gene.maxEndPos;
    if (!Number.isFinite(startPos) || !Number.isFinite(endPos)) continue;

    if (isReverseStrand(gene.strand)) {
      const start = endPos - DOWNSTREAM_BP;
      const end = endPos + UPSTREAM_BP;
      if (start < 0 || end > genomeLength) continue;
      alignment.push(reverseComplement(upperGenome.slice(start, end)));
    } else {
      const start = startPos - UPSTREAM_BP;
      const end = startPos + DOWNSTREAM_BP;
      if (start < 0 || end > genomeLength) continue;
      alignment.push(upperGenome.slice(start, end));
    }
  }

  return { alignment, totalCds: anchorsByKey.size };
}

function normalizeAlignmentText(raw: string): string {
  return raw.replace(/^\uFEFF/, '').replace(/\r\n?/g, '\n');
}

function parseFastaAlignment(rawText: string): string[] {
  const text = normalizeAlignmentText(rawText);
  const lines = text.split('\n');

  const sequences: string[] = [];
  let current: string[] = [];
  let sawHeader = false;

  const flush = (): void => {
    if (!sawHeader) return;
    const joined = current.join('');
    if (joined.length > 0) {
      sequences.push(joined);
    }
    current = [];
  };

  for (const line of lines) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    if (trimmed.startsWith('>')) {
      sawHeader = true;
      flush();
      continue;
    }
    if (!sawHeader) {
      throw new Error('Expected FASTA input starting with a header line beginning with ">".');
    }
    const cleaned = trimmed
      .replace(/\s+/g, '')
      .replace(/[0-9]/g, '')
      .replace(/\./g, '-');
    if (cleaned) current.push(cleaned);
  }

  flush();

  if (sequences.length === 0) {
    throw new Error('No sequences found. Paste/upload an aligned FASTA (">" headers + sequence lines).');
  }

  const expectedLen = sequences[0].length;
  if (expectedLen === 0) {
    throw new Error('First sequence is empty.');
  }

  const bad = sequences.find((seq) => seq.length !== expectedLen);
  if (bad) {
    const lengths = sequences.slice(0, 12).map((s) => s.length);
    throw new Error(`All sequences must be the same length (aligned). Example lengths: ${lengths.join(', ')}.`);
  }

  return sequences;
}

function parseClustalAlignment(rawText: string): string[] {
  const text = normalizeAlignmentText(rawText);
  const lines = text.split('\n');

  const firstNonEmpty = lines.find((l) => l.trim().length > 0) ?? '';
  const header = firstNonEmpty.trim().toUpperCase();
  if (!header.startsWith('CLUSTAL') && !header.startsWith('MUSCLE')) {
    throw new Error('Expected CLUSTAL input starting with a "CLUSTAL" (or "MUSCLE") header line.');
  }

  const byId = new Map<string, string[]>();

  for (const line of lines.slice(lines.indexOf(firstNonEmpty) + 1)) {
    if (!line.trim()) continue;
    if (line.trim().startsWith('#')) continue;
    if (/^\s/.test(line)) continue; // consensus line

    const parts = line.trim().split(/\s+/);
    if (parts.length < 2) continue;
    const id = parts[0];
    const chunk = parts[1].replace(/\./g, '-');
    if (!byId.has(id)) byId.set(id, []);
    byId.get(id)?.push(chunk);
  }

  const sequences = [...byId.values()].map((chunks) => chunks.join(''));
  if (sequences.length === 0) {
    throw new Error('No sequences found in CLUSTAL alignment.');
  }

  const expectedLen = sequences[0].length;
  const bad = sequences.find((seq) => seq.length !== expectedLen);
  if (bad) {
    const lengths = sequences.slice(0, 12).map((s) => s.length);
    throw new Error(`All sequences must be the same length (aligned). Example lengths: ${lengths.join(', ')}.`);
  }

  return sequences;
}

function parseAlignment(rawText: string): { alignment: string[]; format: AlignmentFormat } {
  const trimmed = normalizeAlignmentText(rawText).trim();
  if (!trimmed) {
    throw new Error('Paste/upload an aligned FASTA (or CLUSTAL) first.');
  }
  if (trimmed.startsWith('>')) {
    return { alignment: parseFastaAlignment(trimmed), format: 'fasta' };
  }
  if (/^(CLUSTAL|MUSCLE)/i.test(trimmed)) {
    return { alignment: parseClustalAlignment(trimmed), format: 'clustal' };
  }
  throw new Error('Unrecognized format. Paste/upload an aligned FASTA (">" headers) or CLUSTAL alignment.');
}

function isProbablyDna(alignment: string[]): boolean {
  for (const seq of alignment) {
    for (const c of seq) {
      const ch = c.toUpperCase();
      if (ch === '-' || ch === '.') continue;
      if (ch === 'A' || ch === 'C' || ch === 'G' || ch === 'T' || ch === 'U' || ch === 'N') continue;
      return false;
    }
  }
  return true;
}

function isAlphabetAmbiguous(alignment: string[]): boolean {
  for (const seq of alignment) {
    for (const c of seq) {
      const ch = c.toUpperCase();
      if (ch === '-' || ch === '.') continue;
      if (ch === 'A' || ch === 'C' || ch === 'G' || ch === 'T' || ch === 'N') continue;
      return false;
    }
  }
  return true;
}

function normalizeAlignmentForAlphabet(alignment: string[], alphabet: AlphabetType): string[] {
  if (alignment.length === 0) return alignment;
  if (alphabet === 'dna') {
    return alignment.map((seq) => seq.toUpperCase().replace(/\./g, '-').replace(/U/g, 'T'));
  }
  return alignment.map((seq) => seq.toUpperCase().replace(/\./g, '-'));
}

export function LogoOverlay({ repository, currentPhage }: LogoOverlayProps): React.ReactElement | null {
  const { theme } = useTheme();
  const colors = theme.colors;
  const { isOpen } = useOverlay();

  const [mode, setMode] = useState<LogoSourceMode>('gene-start');

  const [alignment, setAlignment] = useState<string[]>([]);
  const [totalCds, setTotalCds] = useState<number | null>(null);
  const [status, setStatus] = useState<'idle' | 'loading'>('idle');
  const [error, setError] = useState<string | null>(null);

  const [customDraft, setCustomDraft] = useState<string>('');
  const [customSourceLabel, setCustomSourceLabel] = useState<string | null>(null);
  const [customStatus, setCustomStatus] = useState<'idle' | 'parsing'>('idle');
  const [customError, setCustomError] = useState<string | null>(null);
  const [customAlignment, setCustomAlignment] = useState<string[]>([]);
  const [customFormat, setCustomFormat] = useState<AlignmentFormat | null>(null);
  const [alphabetMode, setAlphabetMode] = useState<AlphabetMode>('auto');

  const requestIdRef = useRef(0);

  const overlayOpen = isOpen('logo');

  useEffect(() => {
    if (!overlayOpen || mode !== 'gene-start') return;

    if (!repository) {
      setError('Database not loaded yet.');
      setAlignment([]);
      setTotalCds(null);
      setStatus('idle');
      return;
    }

    if (!currentPhage) {
      setError('No phage loaded yet.');
      setAlignment([]);
      setTotalCds(null);
      setStatus('idle');
      return;
    }

    const requestId = ++requestIdRef.current;
    setStatus('loading');
    setError(null);

    const getGenomeLength = async (): Promise<number> => {
      if (typeof currentPhage.genomeLength === 'number') return currentPhage.genomeLength;
      return repository.getFullGenomeLength(currentPhage.id);
    };

    const getGenes = async (): Promise<GeneInfo[]> => {
      if (Array.isArray(currentPhage.genes) && currentPhage.genes.length > 0) {
        return currentPhage.genes;
      }
      return repository.getGenes(currentPhage.id);
    };

    void (async () => {
      try {
        const [len, genes] = await Promise.all([getGenomeLength(), getGenes()]);
        if (requestIdRef.current !== requestId) return;

        const genome = await repository.getSequenceWindow(currentPhage.id, 0, len);
        if (requestIdRef.current !== requestId) return;

        const { alignment: nextAlignment, totalCds: nextTotalCds } = buildGeneStartAlignment(genome, genes);
        setAlignment(nextAlignment);
        setTotalCds(nextTotalCds);
      } catch (e) {
        if (requestIdRef.current !== requestId) return;
        const msg = e instanceof Error ? e.message : 'Failed to load genome sequence';
        setError(msg);
        setAlignment([]);
        setTotalCds(null);
      } finally {
        if (requestIdRef.current !== requestId) return;
        setStatus('idle');
      }
    })();
  }, [currentPhage, mode, overlayOpen, repository]);

  const applyCustom = useCallback((nextText: string, sourceLabel: string | null): void => {
    setCustomStatus('parsing');
    setCustomError(null);

    try {
      const { alignment: parsed, format } = parseAlignment(nextText);
      setCustomAlignment(parsed);
      setCustomFormat(format);
      setCustomSourceLabel(sourceLabel);
    } catch (e) {
      const msg = e instanceof Error ? e.message : 'Failed to parse alignment';
      setCustomError(msg);
      setCustomAlignment([]);
      setCustomFormat(null);
    } finally {
      setCustomStatus('idle');
    }
  }, []);

  const onUploadFile = useCallback(
    (file: File | null) => {
      if (!file) return;
      const reader = new FileReader();
      reader.onload = () => {
        const text = typeof reader.result === 'string' ? reader.result : '';
        setCustomDraft(text);
        applyCustom(text, file.name);
      };
      reader.onerror = () => {
        setCustomError('Failed to read file.');
      };
      reader.readAsText(file);
    },
    [applyCustom]
  );

  const logoAlphabet = useMemo<AlphabetType>(() => {
    if (mode !== 'custom') return 'dna';
    if (alphabetMode !== 'auto') return alphabetMode;
    return isProbablyDna(customAlignment) ? 'dna' : 'protein';
  }, [alphabetMode, customAlignment, mode]);

  const alphabetAmbiguous = useMemo(() => {
    return mode === 'custom' && alphabetMode === 'auto' && isAlphabetAmbiguous(customAlignment);
  }, [alphabetMode, customAlignment, mode]);

  const activeAlignment = useMemo(() => {
    if (mode === 'custom') return normalizeAlignmentForAlphabet(customAlignment, logoAlphabet);
    return alignment;
  }, [alignment, customAlignment, logoAlphabet, mode]);

  const logoData = useMemo<LogoColumn[]>(() => {
    if (activeAlignment.length === 0) return [];
    return computeSequenceLogo(activeAlignment, logoAlphabet);
  }, [activeAlignment, logoAlphabet]);

  if (!overlayOpen) {
    return null;
  }

  const maxBits = MAX_BITS_BY_ALPHABET[logoAlphabet];

  return (
    <Overlay
      id="logo"
      title="SEQUENCE LOGO"
      size="lg"
    >
      <div style={{ display: 'flex', flexDirection: 'column', gap: '0.75rem' }}>
        <div style={{ display: 'flex', gap: '0.75rem', alignItems: 'center', flexWrap: 'wrap' }}>
          <div
            style={{
              display: 'inline-flex',
              border: `1px solid ${colors.borderLight}`,
              borderRadius: 999,
              overflow: 'hidden',
            }}
          >
            <button
              type="button"
              onClick={() => setMode('gene-start')}
              style={{
                padding: '0.25rem 0.65rem',
                border: 'none',
                cursor: 'pointer',
                background: mode === 'gene-start' ? colors.info : colors.backgroundAlt,
                color: mode === 'gene-start' ? colors.badgeText : colors.textMuted,
                fontWeight: 800,
                fontSize: '0.85rem',
              }}
            >
              Gene-start motif
            </button>
            <button
              type="button"
              onClick={() => setMode('custom')}
              style={{
                padding: '0.25rem 0.65rem',
                border: 'none',
                cursor: 'pointer',
                background: mode === 'custom' ? colors.info : colors.backgroundAlt,
                color: mode === 'custom' ? colors.badgeText : colors.textMuted,
                fontWeight: 800,
                fontSize: '0.85rem',
              }}
            >
              Custom MSA
            </button>
          </div>

          {mode === 'custom' && (
            <label style={{ display: 'inline-flex', alignItems: 'center', gap: '0.5rem', color: colors.textMuted }}>
              Alphabet
              <select
                value={alphabetMode}
                onChange={(e) => setAlphabetMode(e.target.value as AlphabetMode)}
                style={{
                  background: colors.backgroundAlt,
                  color: colors.text,
                  border: `1px solid ${colors.borderLight}`,
                  borderRadius: 8,
                  padding: '0.25rem 0.5rem',
                }}
              >
                <option value="auto">Auto</option>
                <option value="dna">DNA</option>
                <option value="protein">Protein</option>
              </select>
            </label>
          )}

          {mode === 'gene-start' ? (
            <span style={{ color: colors.textMuted, fontSize: '0.95rem' }}>
              Real alignment of fixed windows around CDS translation start sites (0 = start codon).
            </span>
          ) : (
            <span style={{ color: colors.textMuted, fontSize: '0.95rem' }}>
              Paste or upload an aligned FASTA (or CLUSTAL) to visualize true conservation across sequences.
            </span>
          )}
        </div>

        <div style={{ color: colors.textDim, fontFamily: 'monospace', fontSize: '0.95rem' }}>
          {mode === 'gene-start' ? (
            <>
              Window: {formatRelativePosition(-UPSTREAM_BP)}..{formatRelativePosition(DOWNSTREAM_BP - 1)} bp
              {' · '}
              Width: {WINDOW_BP} bp
              {' · '}
              Seqs: {alignment.length}
              {totalCds === null ? '' : `/${totalCds} CDS`}
              {' · '}
              Alphabet: DNA
            </>
          ) : (
            <>
              Source: {customSourceLabel ?? 'paste'}
              {' · '}
              Format: {customFormat ? customFormat.toUpperCase() : '—'}
              {' · '}
              Width: {customAlignment.length > 0 ? customAlignment[0].length : '—'}
              {' · '}
              Seqs: {customAlignment.length}
              {' · '}
              Alphabet: {logoAlphabet.toUpperCase()}
            </>
          )}
        </div>

        {mode === 'gene-start' && error && (
          <div style={{ color: colors.error, fontSize: '0.95rem' }}>
            {error}
          </div>
        )}

        {mode === 'gene-start' && status === 'loading' && (
          <div style={{ color: colors.textMuted, fontSize: '0.95rem' }}>
            Loading…
          </div>
        )}

        {mode === 'gene-start' && !error && status !== 'loading' && alignment.length === 0 && (
          <div style={{ color: colors.textMuted, fontSize: '0.95rem' }}>
            No CDS start windows available for this phage (or windows run off genome edges).
          </div>
        )}

        {mode === 'custom' && (
          <div
            style={{
              border: `1px solid ${colors.borderLight}`,
              borderRadius: 8,
              background: colors.backgroundAlt,
              padding: '0.75rem',
              display: 'flex',
              flexDirection: 'column',
              gap: '0.65rem',
            }}
          >
            <div style={{ display: 'flex', gap: '0.75rem', flexWrap: 'wrap', alignItems: 'center' }}>
              <label style={{ display: 'inline-flex', alignItems: 'center', gap: '0.5rem', color: colors.textMuted }}>
                Upload
                <input
                  type="file"
                  accept=".fa,.fasta,.faa,.aln,.clustal,.txt"
                  onChange={(e) => onUploadFile(e.target.files?.[0] ?? null)}
                />
              </label>
              <button
                type="button"
                onClick={() => applyCustom(customDraft, customSourceLabel ?? 'paste')}
                disabled={customStatus === 'parsing'}
                style={{
                  padding: '0.35rem 0.75rem',
                  borderRadius: 8,
                  border: `1px solid ${colors.borderLight}`,
                  background: colors.background,
                  color: colors.text,
                  cursor: customStatus === 'parsing' ? 'not-allowed' : 'pointer',
                  fontWeight: 800,
                }}
              >
                {customStatus === 'parsing' ? 'Parsing…' : 'Parse & Use Alignment'}
              </button>
              <button
                type="button"
                onClick={() => {
                  setCustomDraft('');
                  setCustomSourceLabel(null);
                  setCustomError(null);
                  setCustomAlignment([]);
                  setCustomFormat(null);
                }}
                style={{
                  padding: '0.35rem 0.75rem',
                  borderRadius: 8,
                  border: `1px solid ${colors.borderLight}`,
                  background: colors.background,
                  color: colors.textMuted,
                  cursor: 'pointer',
                  fontWeight: 700,
                }}
              >
                Clear
              </button>
            </div>

            <label
              htmlFor="logo-custom-alignment"
              style={{ color: colors.textMuted, fontSize: '0.9rem', fontWeight: 700 }}
            >
              Alignment
            </label>
            <textarea
              id="logo-custom-alignment"
              value={customDraft}
              onChange={(e) => setCustomDraft(e.target.value)}
              placeholder={'>seq1\nACGT...\n>seq2\nACGT...\n\n(or CLUSTAL format)'}
              aria-describedby={!customError && customAlignment.length === 0 ? 'logo-custom-alignment-hint' : undefined}
              rows={6}
              style={{
                width: '100%',
                resize: 'vertical',
                fontFamily: 'monospace',
                fontSize: '0.9rem',
                padding: '0.6rem',
                borderRadius: 8,
                border: `1px solid ${colors.borderLight}`,
                background: colors.background,
                color: colors.text,
              }}
            />

            {alphabetAmbiguous && (
              <div style={{ color: colors.warning, fontSize: '0.9rem' }}>
                Alphabet is ambiguous (alignment contains only A/C/G/T/N). Choose DNA or Protein if Auto is incorrect.
              </div>
            )}

            {customError && (
              <div style={{ color: colors.error, fontSize: '0.9rem' }}>
                {customError}
              </div>
            )}

            {!customError && customAlignment.length === 0 && (
              <div id="logo-custom-alignment-hint" style={{ color: colors.textMuted, fontSize: '0.9rem' }}>
                Paste/upload an aligned FASTA (or CLUSTAL). All sequences must be the same length; gaps (e.g. '-' or '.') are OK.
              </div>
            )}
          </div>
        )}

        {mode === 'custom' && !customError && customAlignment.length === 0 && (
          <div style={{ color: colors.textMuted, fontSize: '0.95rem' }}>
            No custom alignment loaded yet.
          </div>
        )}

        {mode === 'custom' && !customError && customAlignment.length > 0 && logoData.length === 0 && (
          <div style={{ color: colors.textMuted, fontSize: '0.95rem' }}>
            Parsed {customAlignment.length} sequences but found no valid characters for {logoAlphabet.toUpperCase()} logo rendering.
          </div>
        )}

        {mode === 'gene-start' && !error && alignment.length > 0 && (
          <div style={{ color: colors.textMuted, fontSize: '0.9rem' }}>
            Note: Window selection is filtered to avoid edges; some CDS may be excluded if the window runs off the genome.
          </div>
        )}

        {(mode === 'gene-start' ? !error : !customError) && activeAlignment.length > 0 && (
          <div
            style={{
              border: `1px solid ${colors.borderLight}`,
              borderRadius: 8,
              background: colors.backgroundAlt,
              overflowX: 'auto',
            }}
          >
            <div
              style={{
                display: 'flex',
                gap: '0.5rem',
                alignItems: 'flex-end',
                padding: '0.75rem',
                minWidth: 'max-content',
              }}
            >
              {logoData.map((col) => {
                const relativePos = (col.position - 1) - UPSTREAM_BP;
                const showRelative = mode === 'gene-start';
                const label = showRelative ? formatRelativePosition(relativePos) : `${col.position}`;
                const isStartCodon = showRelative && relativePos === 0;
                const letters = [...col.letters].sort((a, b) => b.height - a.height);
                return (
                  <div
                    key={col.position}
                    style={{
                      width: 30,
                      display: 'flex',
                      flexDirection: 'column',
                      alignItems: 'center',
                      gap: '0.25rem',
                      fontFamily: 'monospace',
                    }}
                  >
                    <div style={{ fontSize: '0.75rem', color: colors.textMuted }}>
                      {col.totalBits.toFixed(1)}
                    </div>
                    <div
                      style={{
                        height: STACK_HEIGHT_PX,
                        width: '100%',
                        display: 'flex',
                        flexDirection: 'column',
                        justifyContent: 'flex-end',
                        borderBottom: `1px solid ${colors.borderLight}`,
                        outline: isStartCodon ? `2px solid ${colors.info}` : undefined,
                        outlineOffset: -2,
                      }}
                      aria-label={`Position ${label}`}
                    >
                      {letters.map((l) => {
                        const h = (l.height / maxBits) * STACK_HEIGHT_PX;
                        const fg = logoAlphabet === 'dna'
                          ? (theme.nucleotides[(l.char as 'A' | 'C' | 'G' | 'T' | 'N')]?.fg ?? colors.text)
                          : (theme.aminoAcids[(l.char as keyof typeof theme.aminoAcids)]?.fg ?? colors.text);
                        return (
                          <div
                            key={l.char}
                            style={{
                              height: Math.max(2, h),
                              display: 'flex',
                              alignItems: 'center',
                              justifyContent: 'center',
                              color: fg,
                              fontWeight: 800,
                              lineHeight: 1,
                              fontSize: '0.95rem',
                              userSelect: 'none',
                            }}
                            title={`${l.char}: ${l.height.toFixed(2)} bits`}
                          >
                            {l.char}
                          </div>
                        );
                      })}
                    </div>
                    <div style={{ fontSize: '0.75rem', color: colors.textDim }}>
                      {label}
                    </div>
                  </div>
                );
              })}
            </div>
          </div>
        )}

        <div style={{ color: colors.textMuted, fontSize: '0.9rem' }}>
          Tip: Sequence logos visualize information content (bits) per position across aligned sequences.
          {mode === 'custom' ? ' Unknown characters and gaps are ignored when computing frequencies.' : ''}
        </div>
      </div>
    </Overlay>
  );
}

export default LogoOverlay;
