/**
 * QuickStats Component
 *
 * A compact bar showing key phage metrics at a glance, plus direct access to
 * the primary NCBI record and mobile-native sharing.
 */

import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { usePhageStore } from '@phage-explorer/state';
import { haptics } from '../utils/haptics';

interface QuickStatsProps {
  className?: string;
}

type ActionFeedback = 'accession-copied' | 'link-copied' | null;

export function buildNcbiNucleotideUrl(accession: string): string {
  return `https://www.ncbi.nlm.nih.gov/nuccore/${encodeURIComponent(accession.trim())}`;
}

async function copyText(text: string): Promise<void> {
  if (navigator.clipboard?.writeText) {
    await navigator.clipboard.writeText(text);
    return;
  }

  const textArea = document.createElement('textarea');
  textArea.value = text;
  textArea.setAttribute('readonly', '');
  textArea.style.position = 'fixed';
  textArea.style.opacity = '0';
  document.body.appendChild(textArea);
  textArea.select();
  const copied = document.execCommand('copy');
  textArea.remove();
  if (!copied) throw new Error('Clipboard copy failed');
}

function ExternalLinkIcon(): React.ReactElement {
  return (
    <svg
      width="14"
      height="14"
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth={2}
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
    >
      <path d="M15 3h6v6" />
      <path d="M10 14 21 3" />
      <path d="M18 13v6a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V8a2 2 0 0 1 2-2h6" />
    </svg>
  );
}

function ShareIcon(): React.ReactElement {
  return (
    <svg
      width="14"
      height="14"
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth={2}
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
    >
      <circle cx="18" cy="5" r="3" />
      <circle cx="6" cy="12" r="3" />
      <circle cx="18" cy="19" r="3" />
      <path d="m8.6 10.5 6.8-4" />
      <path d="m8.6 13.5 6.8 4" />
    </svg>
  );
}

function CopyIcon(): React.ReactElement {
  return (
    <svg
      width="14"
      height="14"
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth={2}
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
    >
      <rect width="14" height="14" x="8" y="8" rx="2" ry="2" />
      <path d="M4 16c-1.1 0-2-.9-2-2V4c0-1.1.9-2 2-2h10c1.1 0 2 .9 2 2" />
    </svg>
  );
}

export function QuickStats({ className = '' }: QuickStatsProps): React.ReactElement | null {
  const currentPhage = usePhageStore((s) => s.currentPhage);
  const [feedback, setFeedback] = useState<ActionFeedback>(null);
  const feedbackTimerRef = useRef<number | null>(null);

  const stats = useMemo(() => {
    if (!currentPhage) return null;

    const forwardGenes = currentPhage.genes?.filter((gene) => gene.strand !== '-').length ?? 0;
    const reverseGenes = currentPhage.genes?.filter((gene) => gene.strand === '-').length ?? 0;

    return {
      name: currentPhage.name,
      accession: currentPhage.accession,
      length: currentPhage.genomeLength ?? 0,
      gcContent: currentPhage.gcContent,
      geneCount: currentPhage.genes?.length ?? 0,
      forwardGenes,
      reverseGenes,
      baltimore: currentPhage.baltimoreGroup,
      host: currentPhage.host,
      hasPdb: (currentPhage.pdbIds?.length ?? 0) > 0,
    };
  }, [currentPhage]);

  const showFeedback = useCallback((nextFeedback: Exclude<ActionFeedback, null>) => {
    setFeedback(nextFeedback);
    if (feedbackTimerRef.current !== null) {
      window.clearTimeout(feedbackTimerRef.current);
    }
    feedbackTimerRef.current = window.setTimeout(() => {
      setFeedback(null);
      feedbackTimerRef.current = null;
    }, 1800);
  }, []);

  useEffect(() => {
    return () => {
      if (feedbackTimerRef.current !== null) {
        window.clearTimeout(feedbackTimerRef.current);
      }
    };
  }, []);

  const ncbiUrl = stats ? buildNcbiNucleotideUrl(stats.accession) : '';

  const handleCopyAccession = useCallback(async () => {
    if (!stats) return;
    try {
      await copyText(stats.accession);
      haptics.success();
      showFeedback('accession-copied');
    } catch {
      haptics.error();
    }
  }, [showFeedback, stats]);

  const handleShare = useCallback(async () => {
    if (!stats) return;
    const shareData = {
      title: `${stats.name} — Phage Explorer`,
      text: `${stats.name} (${stats.accession}) on Phage Explorer. Primary nucleotide record:`,
      url: ncbiUrl,
    };

    try {
      if (typeof navigator.share === 'function') {
        await navigator.share(shareData);
        haptics.success();
        return;
      }

      await copyText(`${shareData.title}\n${shareData.text}\n${shareData.url}`);
      haptics.success();
      showFeedback('link-copied');
    } catch (error) {
      if (error instanceof DOMException && error.name === 'AbortError') return;
      haptics.error();
    }
  }, [ncbiUrl, showFeedback, stats]);

  if (!stats) {
    return null;
  }

  const formatNumber = (value: number): string => {
    if (value >= 1_000_000) return `${(value / 1_000_000).toFixed(2)}M`;
    if (value >= 1_000) return `${(value / 1_000).toFixed(1)}k`;
    return value.toLocaleString();
  };

  return (
    <div className={`quick-stats ${className}`} aria-label="Phage statistics">
      <div className="quick-stat">
        <span className="quick-stat__label">Length</span>
        <span className="quick-stat__value">{formatNumber(stats.length)} bp</span>
      </div>

      {stats.gcContent != null && (
        <div className="quick-stat">
          <span className="quick-stat__label">GC Content</span>
          <span className="quick-stat__value">{stats.gcContent.toFixed(1)}%</span>
        </div>
      )}

      <div className="quick-stat">
        <span className="quick-stat__label">Genes</span>
        <span className="quick-stat__value">
          {stats.geneCount}{' '}
          <span className="quick-stat__detail">
            ({stats.forwardGenes}+ / {stats.reverseGenes}-)
          </span>
        </span>
      </div>

      {stats.baltimore && (
        <div className="quick-stat">
          <span className="quick-stat__label">Baltimore</span>
          <span className="quick-stat__value quick-stat__value--highlight">{stats.baltimore}</span>
        </div>
      )}

      {stats.host && (
        <div className="quick-stat quick-stat--wide">
          <span className="quick-stat__label">Host</span>
          <span className="quick-stat__value quick-stat__value--host">{stats.host}</span>
        </div>
      )}

      {stats.hasPdb && (
        <div className="quick-stat">
          <span className="quick-stat__label">Structure</span>
          <span className="quick-stat__value quick-stat__value--highlight">Available</span>
        </div>
      )}

      <div className="quick-stat">
        <span className="quick-stat__label">Accession</span>
        <span className="quick-stat__value quick-stat__value--mono">{stats.accession}</span>
      </div>

      <div className="quick-stat quick-stat--actions">
        <span className="quick-stat__label">Research</span>
        <div className="quick-stat__actions">
          <a
            className="quick-stat__action"
            href={ncbiUrl}
            target="_blank"
            rel="noopener noreferrer"
            aria-label={`Open ${stats.accession} in NCBI Nucleotide`}
          >
            <ExternalLinkIcon />
            <span>NCBI</span>
          </a>
          <button
            type="button"
            className="quick-stat__action"
            onClick={() => void handleShare()}
            aria-label={`Share ${stats.name} primary record`}
          >
            <ShareIcon />
            <span>{feedback === 'link-copied' ? 'Copied' : 'Share'}</span>
          </button>
          <button
            type="button"
            className="quick-stat__action"
            onClick={() => void handleCopyAccession()}
            aria-label={`Copy accession ${stats.accession}`}
          >
            <CopyIcon />
            <span>{feedback === 'accession-copied' ? 'Copied' : 'Copy ID'}</span>
          </button>
        </div>
      </div>
    </div>
  );
}

export default QuickStats;
