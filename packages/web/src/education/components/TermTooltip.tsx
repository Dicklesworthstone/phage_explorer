import type { CSSProperties } from 'react';
import React, {
  useCallback,
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
} from 'react';
import { createPortal } from 'react-dom';
import type { GlossaryId } from '../glossary/terms';
import { useGlossary } from '../hooks/useGlossary';
import { useBeginnerMode } from '../hooks/useBeginnerMode';

interface TermTooltipProps {
  termId: GlossaryId;
  style?: CSSProperties;
}

export function TermTooltip({ termId, style }: TermTooltipProps): React.ReactElement | null {
  const { getTerm, relatedTerms } = useGlossary();
  const entry = getTerm(termId);
  if (!entry) return null;

  const related = relatedTerms(termId);

  return (
    <div
      role="tooltip"
      style={{
        maxWidth: 320,
        padding: '0.5rem 0.75rem',
        borderRadius: 8,
        background: 'rgba(10, 10, 15, 0.95)',
        border: '1px solid rgba(255, 255, 255, 0.08)',
        color: '#f0f0f8',
        boxShadow: '0 8px 24px rgba(0,0,0,0.35)',
        ...style,
      }}
    >
      <div style={{ fontWeight: 700, marginBottom: 4 }}>{entry.term}</div>
      <div style={{ fontSize: '0.9rem', color: '#d1d5db' }}>{entry.shortDef}</div>
      {related.length > 0 && (
        <div style={{ marginTop: 8 }}>
          <div style={{ fontSize: '0.75rem', color: '#9ca3af', marginBottom: 2 }}>See also</div>
          <div style={{ display: 'flex', gap: 6, flexWrap: 'wrap' }}>
            {related.map((rel) => (
              <span
                key={rel.id}
                style={{
                  fontSize: '0.8rem',
                  padding: '2px 6px',
                  borderRadius: 6,
                  background: 'rgba(34, 211, 238, 0.12)',
                  color: '#22d3ee',
                }}
              >
                {rel.term}
              </span>
            ))}
          </div>
        </div>
      )}
    </div>
  );
}

interface GlossaryTermLinkProps {
  termId: GlossaryId;
  children?: React.ReactNode;
}

type TooltipPlacement = 'top' | 'bottom';

function clamp(value: number, min: number, max: number): number {
  return Math.min(Math.max(value, min), max);
}

export function GlossaryTermLink({ termId, children }: GlossaryTermLinkProps): React.ReactElement {
  const { getTerm } = useGlossary();
  const { isEnabled, enable, openGlossary, showContextFor } = useBeginnerMode();
  const anchorRef = useRef<HTMLSpanElement>(null);
  const tooltipRef = useRef<HTMLDivElement>(null);
  const [open, setOpen] = useState(false);
  const [placement, setPlacement] = useState<TooltipPlacement>('bottom');
  const [coords, setCoords] = useState<{ top: number; left: number }>({ top: 0, left: 0 });

  const entry = getTerm(termId);
  const label = children ?? entry?.term ?? termId;

  const computePosition = useCallback(() => {
    const anchor = anchorRef.current;
    const tooltip = tooltipRef.current;
    if (!anchor || !tooltip) return;

    const spacing = 10;
    const anchorRect = anchor.getBoundingClientRect();
    const tooltipRect = tooltip.getBoundingClientRect();

    let nextTop = anchorRect.bottom + spacing;
    let nextPlacement: TooltipPlacement = 'bottom';

    if (nextTop + tooltipRect.height > window.innerHeight - spacing) {
      nextPlacement = 'top';
      nextTop = anchorRect.top - tooltipRect.height - spacing;
    }

    const rawLeft = anchorRect.left + anchorRect.width / 2 - tooltipRect.width / 2;
    const nextLeft = clamp(rawLeft, 12, window.innerWidth - tooltipRect.width - 12);

    setCoords({ top: Math.max(nextTop, spacing), left: nextLeft });
    setPlacement(nextPlacement);
  }, []);

  useLayoutEffect(() => {
    if (!open) return;
    computePosition();
  }, [open, computePosition, entry?.id]);

  useEffect(() => {
    if (!open) return;
    const handle = () => computePosition();
    window.addEventListener('scroll', handle, true);
    window.addEventListener('resize', handle);
    return () => {
      window.removeEventListener('scroll', handle, true);
      window.removeEventListener('resize', handle);
    };
  }, [open, computePosition]);

  const handleOpen = useCallback(() => {
    if (!entry) return;
    setOpen(true);
  }, [entry]);

  const handleClose = useCallback(() => setOpen(false), []);

  const handleClick = useCallback(() => {
    if (!entry) return;
    if (!isEnabled) {
      enable();
      // Defer context so beginner mode state hydrates first
      window.setTimeout(() => showContextFor(termId), 0);
    } else {
      showContextFor(termId);
      openGlossary();
    }
    setOpen(false);
  }, [enable, entry, isEnabled, openGlossary, showContextFor, termId]);

  const handleKeyDown = useCallback(
    (event: React.KeyboardEvent) => {
      if (event.key === 'Enter' || event.key === ' ') {
        event.preventDefault();
        handleClick();
      }
    },
    [handleClick],
  );

  const tooltip = useMemo(() => {
    if (!open || !entry) return null;
    return createPortal(
      <div
        ref={tooltipRef}
        onMouseEnter={handleOpen}
        onMouseLeave={handleClose}
        style={{
          position: 'fixed',
          top: coords.top,
          left: coords.left,
          zIndex: 1000,
          pointerEvents: 'auto',
        }}
      >
        <div
          style={{
            marginBottom: placement === 'top' ? 6 : 0,
            marginTop: placement === 'bottom' ? 6 : 0,
          }}
        >
          <TermTooltip termId={termId} />
        </div>
      </div>,
      document.body,
    );
  }, [coords.left, coords.top, entry, handleClose, handleOpen, open, placement, termId]);

  return (
    <span
      ref={anchorRef}
      role="button"
      tabIndex={0}
      onMouseEnter={handleOpen}
      onMouseLeave={handleClose}
      onFocus={handleOpen}
      onBlur={handleClose}
      onClick={handleClick}
      onKeyDown={handleKeyDown}
      style={{
        cursor: 'help',
        color: 'var(--color-accent, #22d3ee)',
        fontWeight: 700,
        textDecoration: 'underline',
        textDecorationStyle: 'dotted',
      }}
      aria-haspopup="dialog"
      aria-expanded={open}
      aria-label={`${label} glossary definition`}
    >
      {label}
      {tooltip}
    </span>
  );
}

export default TermTooltip;

