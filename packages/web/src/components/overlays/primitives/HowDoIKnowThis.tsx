import React, { useState, useEffect, useRef, useCallback } from 'react';

export interface HowDoIKnowThisProps {
  /** Title of the metric or calculation */
  title: string;
  /** Plain English calculation/algorithm description without internal function names */
  computation: string;
  /** The specific inputs consumed (genomes, window sizes, reference panels) */
  inputs: Array<{ label: string; value: string }>;
  /** The real runtime implementation that executed */
  implementation: {
    engine: 'WASM (SIMD)' | 'WASM (Baseline)' | 'JavaScript' | 'Pipeline Database';
    details?: string;
  };
  /** Annotation database release from annotation_meta (if applicable) */
  annotationRelease?: {
    database: string;
    version: string;
    details?: string;
  };
  /** Formatted, copyable citation text for a Methods section */
  citation: string;
  /** Optional custom button label */
  triggerLabel?: string;
  /** Optional container style */
  style?: React.CSSProperties;
}

export function HowDoIKnowThis({
  title,
  computation,
  inputs,
  implementation,
  annotationRelease,
  citation,
  triggerLabel = 'How do I know this?',
  style,
}: HowDoIKnowThisProps): React.ReactElement {
  const [open, setOpen] = useState(false);
  const [copied, setCopied] = useState(false);
  const dialogRef = useRef<HTMLDivElement>(null);
  const triggerRef = useRef<HTMLButtonElement>(null);

  // Close on Escape
  useEffect(() => {
    if (!open) return;
    const handleKeyDown = (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        e.stopPropagation();
        setOpen(false);
        triggerRef.current?.focus();
      }
    };
    window.addEventListener('keydown', handleKeyDown, true);
    return () => window.removeEventListener('keydown', handleKeyDown, true);
  }, [open]);

  // Click outside to close
  useEffect(() => {
    if (!open) return;
    const handlePointerDown = (e: MouseEvent) => {
      if (dialogRef.current && !dialogRef.current.contains(e.target as Node)) {
        setOpen(false);
      }
    };
    document.addEventListener('mousedown', handlePointerDown);
    return () => document.removeEventListener('mousedown', handlePointerDown);
  }, [open]);

  const handleCopyCitation = useCallback(async () => {
    try {
      if (navigator.clipboard?.writeText) {
        await navigator.clipboard.writeText(citation);
      } else {
        const textarea = document.createElement('textarea');
        textarea.value = citation;
        textarea.style.position = 'fixed';
        textarea.style.opacity = '0';
        document.body.appendChild(textarea);
        textarea.select();
        document.execCommand('copy');
        document.body.removeChild(textarea);
      }
      setCopied(true);
      setTimeout(() => setCopied(false), 2000);
    } catch {
      setCopied(false);
    }
  }, [citation]);

  const engineColor =
    implementation.engine.startsWith('WASM')
      ? 'var(--color-primary, #06b6d4)'
      : implementation.engine === 'Pipeline Database'
      ? 'var(--color-success, #22c55e)'
      : 'var(--color-warning, #f59e0b)';

  return (
    <div style={{ position: 'relative', display: 'inline-block', ...style }}>
      <button
        ref={triggerRef}
        type="button"
        onClick={() => setOpen((prev) => !prev)}
        aria-expanded={open}
        aria-haspopup="dialog"
        aria-label={`How do I know this: ${title}`}
        data-testid="how-do-i-know-this-trigger"
        style={{
          display: 'inline-flex',
          alignItems: 'center',
          gap: '0.35rem',
          padding: '0.2rem 0.55rem',
          fontSize: '0.72rem',
          fontWeight: 600,
          color: 'var(--color-primary, #06b6d4)',
          backgroundColor: 'rgba(6, 182, 212, 0.08)',
          border: '1px solid rgba(6, 182, 212, 0.3)',
          borderRadius: '4px',
          cursor: 'pointer',
          transition: 'all 0.15s ease',
        }}
      >
        <span aria-hidden="true" style={{ fontSize: '0.85rem', lineHeight: 1 }}>
          ⓘ
        </span>
        <span>{triggerLabel}</span>
      </button>

      {open && (
        <div
          ref={dialogRef}
          role="dialog"
          aria-label={`Provenance & calculation details for ${title}`}
          data-testid="how-do-i-know-this-dialog"
          style={{
            position: 'absolute',
            top: 'calc(100% + 6px)',
            left: 0,
            zIndex: 1000,
            width: '420px',
            maxWidth: '90vw',
            backgroundColor: 'var(--color-bg-panel, #0f172a)',
            border: '1px solid var(--color-border, #334155)',
            borderRadius: '6px',
            boxShadow: '0 10px 25px -5px rgba(0, 0, 0, 0.5), 0 8px 10px -6px rgba(0, 0, 0, 0.5)',
            padding: '1rem',
            color: 'var(--color-text, #f8fafc)',
            fontSize: '0.8rem',
            lineHeight: 1.4,
          }}
        >
          {/* Header */}
          <div
            style={{
              display: 'flex',
              alignItems: 'flex-start',
              justifyContent: 'space-between',
              marginBottom: '0.75rem',
              borderBottom: '1px solid var(--color-border, #334155)',
              paddingBottom: '0.5rem',
            }}
          >
            <div>
              <div
                style={{
                  fontSize: '0.68rem',
                  textTransform: 'uppercase',
                  letterSpacing: '0.05em',
                  color: 'var(--color-text-dim, #94a3b8)',
                  fontWeight: 600,
                }}
              >
                Calculation & Provenance
              </div>
              <div style={{ fontWeight: 700, fontSize: '0.92rem', color: 'var(--color-text, #f8fafc)' }}>
                {title}
              </div>
            </div>
            <button
              type="button"
              onClick={() => {
                setOpen(false);
                triggerRef.current?.focus();
              }}
              aria-label="Close provenance details"
              style={{
                background: 'none',
                border: 'none',
                color: 'var(--color-text-dim, #94a3b8)',
                cursor: 'pointer',
                fontSize: '1rem',
                padding: '0.1rem 0.3rem',
                borderRadius: '3px',
              }}
            >
              &times;
            </button>
          </div>

          {/* Computation Details */}
          <div style={{ marginBottom: '0.65rem' }}>
            <div style={{ fontWeight: 600, color: 'var(--color-text-dim, #94a3b8)', fontSize: '0.72rem', marginBottom: '0.2rem' }}>
              COMPUTATION
            </div>
            <div data-testid="provenance-computation" style={{ color: 'var(--color-text, #f8fafc)' }}>
              {computation}
            </div>
          </div>

          {/* Inputs */}
          <div style={{ marginBottom: '0.65rem' }}>
            <div style={{ fontWeight: 600, color: 'var(--color-text-dim, #94a3b8)', fontSize: '0.72rem', marginBottom: '0.2rem' }}>
              INPUTS
            </div>
            <div style={{ display: 'grid', gridTemplateColumns: 'auto 1fr', gap: '0.2rem 0.6rem', fontSize: '0.75rem' }}>
              {inputs.map((inp, idx) => (
                <React.Fragment key={idx}>
                  <span style={{ color: 'var(--color-text-dim, #94a3b8)', fontWeight: 500 }}>{inp.label}:</span>
                  <span style={{ color: 'var(--color-text, #f8fafc)', fontFamily: 'monospace' }}>{inp.value}</span>
                </React.Fragment>
              ))}
            </div>
          </div>

          {/* Implementation & Annotation Release */}
          <div
            style={{
              display: 'flex',
              gap: '0.5rem',
              flexWrap: 'wrap',
              marginBottom: '0.75rem',
              backgroundColor: 'rgba(255, 255, 255, 0.03)',
              padding: '0.5rem',
              borderRadius: '4px',
              border: '1px solid var(--color-border, #334155)',
            }}
          >
            <div style={{ flex: 1, minWidth: '140px' }}>
              <div style={{ fontSize: '0.68rem', color: 'var(--color-text-dim, #94a3b8)', fontWeight: 600 }}>
                RUNTIME ENGINE
              </div>
              <div style={{ display: 'flex', alignItems: 'center', gap: '0.4rem', marginTop: '0.15rem' }}>
                <span
                  data-testid="provenance-engine"
                  style={{
                    fontWeight: 700,
                    fontSize: '0.78rem',
                    color: engineColor,
                  }}
                >
                  {implementation.engine}
                </span>
              </div>
              {implementation.details && (
                <div style={{ fontSize: '0.7rem', color: 'var(--color-text-dim, #94a3b8)', marginTop: '0.1rem' }}>
                  {implementation.details}
                </div>
              )}
            </div>

            {annotationRelease && (
              <div style={{ flex: 1, minWidth: '140px' }}>
                <div style={{ fontSize: '0.68rem', color: 'var(--color-text-dim, #94a3b8)', fontWeight: 600 }}>
                  ANNOTATION RELEASE
                </div>
                <div
                  data-testid="provenance-release"
                  style={{ fontWeight: 700, fontSize: '0.78rem', color: 'var(--color-text, #f8fafc)', marginTop: '0.15rem' }}
                >
                  {annotationRelease.database} {annotationRelease.version}
                </div>
                {annotationRelease.details && (
                  <div style={{ fontSize: '0.7rem', color: 'var(--color-text-dim, #94a3b8)', marginTop: '0.1rem' }}>
                    {annotationRelease.details}
                  </div>
                )}
              </div>
            )}
          </div>

          {/* Citable Methods Description */}
          <div>
            <div
              style={{
                display: 'flex',
                alignItems: 'center',
                justifyContent: 'space-between',
                marginBottom: '0.25rem',
              }}
            >
              <span style={{ fontWeight: 600, color: 'var(--color-text-dim, #94a3b8)', fontSize: '0.72rem' }}>
                CITABLE METHODS DESCRIPTION
              </span>
              <button
                type="button"
                onClick={handleCopyCitation}
                aria-label="Copy citable methods description"
                data-testid="copy-citation-button"
                style={{
                  background: copied ? 'var(--color-success, #22c55e)' : 'rgba(255, 255, 255, 0.08)',
                  color: copied ? '#000' : 'var(--color-text, #f8fafc)',
                  border: 'none',
                  borderRadius: '3px',
                  padding: '0.15rem 0.45rem',
                  fontSize: '0.68rem',
                  fontWeight: 600,
                  cursor: 'pointer',
                  transition: 'background-color 0.15s',
                }}
              >
                {copied ? '✓ Copied!' : 'Copy'}
              </button>
            </div>
            <div
              data-testid="provenance-citation"
              style={{
                padding: '0.45rem 0.6rem',
                backgroundColor: 'rgba(0, 0, 0, 0.3)',
                border: '1px solid var(--color-border, #334155)',
                borderRadius: '4px',
                fontSize: '0.73rem',
                fontStyle: 'italic',
                color: 'var(--color-text-dim, #cbd5e1)',
              }}
            >
              {citation}
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
