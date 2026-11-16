/**
 * LogoOverlay - Sequence Logo
 *
 * Web port of the TUI LogoOverlay using `computeSequenceLogo()` from @phage-explorer/core.
 *
 * This implementation uses real data: an alignment of fixed-width windows around
 * CDS translation start sites in the current phage genome ("gene-start motif").
 */

import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import type { AlphabetType, PhageFull } from '@phage-explorer/core';
import { buildGeneStartAlignment, computeSequenceLogo, GENE_START_LOGO_WINDOW, GENE_START_LOGO_EXCLUSION_LABELS } from '@phage-explorer/core';
import type { GeneStartLogoAlignment, LogoColumn } from '@phage-explorer/core';
import type { PhageRepository } from '../../db';
import { useTheme } from '../../hooks/useTheme';
import { Overlay } from './Overlay';
import { useOverlay } from './OverlayProvider';

interface LogoOverlayProps {
  repository: PhageRepository | null;
  currentPhage: PhageFull | null;
}

const UPSTREAM_BP = GENE_START_LOGO_WINDOW.upstream;
const DOWNSTREAM_BP = GENE_START_LOGO_WINDOW.downstream;
const WINDOW_BP = UPSTREAM_BP + DOWNSTREAM_BP;
const STACK_HEIGHT_PX = 120;
const MAX_ALIGNMENT_BYTES = 2 * 1024 * 1024;
const MAX_ALIGNMENT_SEQUENCES = 1000;
const MAX_ALIGNMENT_COLUMNS = 1000;

type LogoSourceMode = 'gene-start' | 'custom';
type AlphabetMode = 'auto' | AlphabetType;
type AlignmentFormat = 'fasta' | 'clustal';

const MAX_BITS_BY_ALPHABET: Record<AlphabetType, number> = {
  dna: Math.log2(4),
  protein: Math.log2(20),
};

function formatRelativePosition(pos: number): string {
  if (pos > 0) return `+${pos}`;
  return `${pos}`;
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
  if (rawText.length > MAX_ALIGNMENT_BYTES || new TextEncoder().encode(rawText).length > MAX_ALIGNMENT_BYTES) {
    throw new Error('Logo alignments are limited to 2 MiB. Select a smaller aligned region.');
  }
  const trimmed = normalizeAlignmentText(rawText).trim();
  if (!trimmed) {
    throw new Error('Paste/upload an aligned FASTA (or CLUSTAL) first.');
  }
  const format = trimmed.startsWith('>') ? 'fasta' : /^(CLUSTAL|MUSCLE)/i.test(trimmed) ? 'clustal' : null;
  if (!format) throw new Error('Unrecognized format. Paste/upload an aligned FASTA (">" headers) or CLUSTAL alignment.');
  const alignment = format === 'fasta' ? parseFastaAlignment(trimmed) : parseClustalAlignment(trimmed);
  if (alignment.length > MAX_ALIGNMENT_SEQUENCES || alignment[0].length > MAX_ALIGNMENT_COLUMNS) {
    throw new Error('Logo alignments are limited to 1,000 sequences and 1,000 columns. Select a smaller aligned region.');
  }
  return { alignment, format };
}

function isProbablyDna(alignment: string[]): boolean {
  for (const seq of alignment) {
    for (const c of seq) {
      const ch = c.toUpperCase();
      if (ch === '-' || ch === '.') continue;
      if ('ACGTURYSWKMBDHVN'.includes(ch)) continue;
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
      if ('ACGTRYSWKMBDHVN'.includes(ch)) continue;
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

export function GeneStartLogoCoverage({ result }: { result: GeneStartLogoAlignment }): React.ReactElement {
  const reasons = new Map<string, number>();
  for (const item of result.excluded) reasons.set(item.reason, (reasons.get(item.reason) ?? 0) + 1);
  const wrapped = result.windows.filter(window => window.wrapped).length;
  return <section aria-label="Gene-start logo coverage" data-testid="gene-start-logo-coverage">
    <p>{result.windows.length} distinct oriented starts from {result.totalCds} mapped CDS features.
      {' '}{result.excluded.length} excluded. Topology: {result.topology}; {wrapped} windows cross the origin.</p>
    <p>Windows follow the annotated transcript's first segment and preserve genomic flanks in coding orientation.
      Only exact starts with codon_start=1 and an initiator in the annotated NCBI code are included; a missing code uses table 1.
      Circular wrapping requires explicitly known circular topology. These are annotation-based motifs, not measured initiation or transcription.</p>
    {reasons.size > 0 && <ul>{[...reasons].map(([reason, count]) =>
      <li key={reason}>{count}: {GENE_START_LOGO_EXCLUSION_LABELS[reason as keyof typeof GENE_START_LOGO_EXCLUSION_LABELS]}</li>)}</ul>}
    {result.windows.length > 0 && <details>
      <summary>Inspect exact motif windows ({Math.min(50, result.windows.length)} shown)</summary>
      <p>Anchor is the 1-based genomic position of the first initiation-codon base. Context is −20 through +9 in coding orientation.</p>
      <div style={{ overflowX: 'auto' }}><table>
        <thead><tr><th>CDS</th><th>Anchor</th><th>Strand</th><th>Code</th><th>Genomic context</th></tr></thead>
        <tbody>{result.windows.slice(0, 50).map(window => <tr key={`${window.strand}:${window.anchor}`}>
          <td>{window.name}</td><td>{window.anchor + 1}</td><td>{window.strand}</td><td>{window.geneticCode}</td>
          <td><code>{window.sequence}</code>{window.wrapped ? ' (origin crossing)' : ''}</td>
        </tr>)}</tbody>
      </table></div>
    </details>}
  </section>;
}

export function LogoOverlay({ repository, currentPhage }: LogoOverlayProps): React.ReactElement | null {
  const { theme } = useTheme();
  const colors = theme.colors;
  const { isOpen } = useOverlay();

  const [mode, setMode] = useState<LogoSourceMode>('gene-start');

  const [snapshot, setSnapshot] = useState<{
    repository: PhageRepository; phage: PhageFull; result: GeneStartLogoAlignment | null; loading: boolean; error: string | null;
  } | null>(null);
  const current = snapshot?.repository === repository && snapshot?.phage === currentPhage ? snapshot : null;
  const geneStarts = current?.result ?? null;
  const alignment = useMemo(() => geneStarts?.windows.map(window => window.sequence) ?? [], [geneStarts]);
  const totalCds = geneStarts?.totalCds ?? null;
  const status = repository && currentPhage && (!current || current.loading) ? 'loading' : 'idle';
  const error = !repository ? 'Database not loaded yet.' : !currentPhage ? 'No phage loaded yet.' : current?.error ?? null;

  const [customDraft, setCustomDraft] = useState<string>('');
  const [customSourceLabel, setCustomSourceLabel] = useState<string | null>(null);
  const [customStatus, setCustomStatus] = useState<'idle' | 'parsing'>('idle');
  const [customError, setCustomError] = useState<string | null>(null);
  const [customAlignment, setCustomAlignment] = useState<string[]>([]);
  const [customFormat, setCustomFormat] = useState<AlignmentFormat | null>(null);
  const [alphabetMode, setAlphabetMode] = useState<AlphabetMode>('auto');
  const customReader = useRef<FileReader | null>(null);
  const customGeneration = useRef(0);
  useEffect(() => () => { customGeneration.current++; customReader.current?.abort(); }, []);

  const overlayOpen = isOpen('logo');

  useEffect(() => {
    if (!overlayOpen || mode !== 'gene-start') return;

    if (!repository || !currentPhage) { setSnapshot(null); return; }
    let cancelled = false;
    const input = { repository, phage: currentPhage };
    setSnapshot({ ...input, result: null, loading: true, error: null });

    void (async () => {
      try {
        const [len, genes] = await Promise.all([repository.getFullGenomeLength(currentPhage.id), repository.getGenes(currentPhage.id)]);
        if (cancelled) return;

        const genome = await repository.getSequenceWindow(currentPhage.id, 0, len);
        if (cancelled) return;
        if (genome.length !== len) throw new Error('The complete genome could not be read. Retry after the sequence has loaded.');

        const result = buildGeneStartAlignment(genome, genes, currentPhage.localGenome?.topology ?? 'unknown');
        setSnapshot({ ...input, result, loading: false, error: null });
      } catch (e) {
        if (cancelled) return;
        const msg = e instanceof Error ? e.message : 'Failed to load genome sequence';
        setSnapshot({ ...input, result: null, loading: false, error: msg });
      }
    })();
    return () => { cancelled = true; };
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
      const generation = ++customGeneration.current;
      customReader.current?.abort();
      setCustomAlignment([]); setCustomFormat(null); setCustomError(null); setCustomSourceLabel(null); setCustomDraft('');
      if (file.size > MAX_ALIGNMENT_BYTES) {
        setCustomStatus('idle');
        setCustomError('Logo alignments are limited to 2 MiB. Select a smaller aligned region.');
        return;
      }
      const reader = new FileReader();
      customReader.current = reader;
      setCustomStatus('parsing');
      reader.onload = () => {
        if (generation !== customGeneration.current) return;
        customReader.current = null;
        const text = typeof reader.result === 'string' ? reader.result : '';
        setCustomDraft(text);
        applyCustom(text, file.name);
      };
      reader.onerror = () => {
        if (generation !== customGeneration.current) return;
        customReader.current = null; setCustomStatus('idle');
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
    return mode === 'custom' && customAlignment.length > 0 && alphabetMode === 'auto' && isAlphabetAmbiguous(customAlignment);
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
              Fixed genomic windows around supported annotated CDS starts (0 = first initiation-codon base).
            </span>
          ) : (
            <span style={{ color: colors.textMuted, fontSize: '0.95rem' }}>
              Paste or upload an aligned FASTA (or CLUSTAL) to inspect symbol frequencies and information content.
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
            No supported complete CDS start windows are available for this phage. Inspect the coverage and exclusions below.
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
                  customGeneration.current++; customReader.current?.abort(); setCustomStatus('idle');
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
              maxLength={MAX_ALIGNMENT_BYTES}
              onChange={(e) => {
                customGeneration.current++; customReader.current?.abort(); setCustomStatus('idle');
                setCustomDraft(e.target.value); setCustomSourceLabel(null); setCustomAlignment([]); setCustomFormat(null); setCustomError(null);
              }}
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
                Alphabet is ambiguous: these IUPAC DNA symbols can also occur in proteins. Choose DNA or Protein explicitly if Auto is incorrect.
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
                {' '}Limits: 2 MiB, 1,000 sequences and 1,000 columns.
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

        {mode === 'gene-start' && geneStarts && <GeneStartLogoCoverage result={geneStarts} />}

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
          {' '}Unresolved symbols and gaps are excluded per column; the small-sample correction can give zero-height stacks when observations are few.
        </div>
      </div>
    </Overlay>
  );
}

export default LogoOverlay;
