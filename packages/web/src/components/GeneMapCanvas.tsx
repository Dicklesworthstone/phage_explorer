import React, { memo, useEffect, useId, useMemo, useRef } from 'react';
import { getGeneMapSegments, type GeneInfo } from '@phage-explorer/core';
import { usePhageStore } from '@phage-explorer/state';
import { useTheme } from '../hooks/useTheme';
import { classifyGeneStrand, summarizeGeneStrands } from '../utils/gene-strand';
import {
  GENE_MAP_FORWARD_TRACK,
  GENE_MAP_REVERSE_TRACK,
  GENE_MAP_UNKNOWN_TRACK,
  getGeneMapTrack,
  getGeneMapTrackDirectionAtY,
} from '../utils/gene-map-layout';

const srOnly: React.CSSProperties = {
  position: 'absolute',
  width: '1px',
  height: '1px',
  padding: 0,
  margin: '-1px',
  overflow: 'hidden',
  clip: 'rect(0, 0, 0, 0)',
  whiteSpace: 'nowrap',
  border: 0,
};

interface GeneMapCanvasProps {
  height?: number;
  className?: string;
  onGeneClick?: (startPos: number) => void;
  onGeneSelect?: (gene: GeneInfo | null) => void;
}

interface HitInfo {
  posBase: number;
  gene: GeneInfo | null;
  clientX: number;
  clientY: number;
}

function GeneMapCanvasBase({
  height = 60,
  className,
  onGeneClick,
  onGeneSelect,
}: GeneMapCanvasProps): React.ReactElement {
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const { theme } = useTheme();
  const colors = theme.colors;
  const tooltipId = useId();
  const descriptionId = useId();

  const currentPhage = usePhageStore((state) => state.currentPhage);
  const scrollPosition = usePhageStore((state) => state.scrollPosition);
  const viewMode = usePhageStore((state) => state.viewMode);

  const genes = useMemo(() => currentPhage?.genes ?? [], [currentPhage]);
  const genomeLength = currentPhage?.genomeLength ?? null;

  const geneDescription = useMemo(() => {
    if (!currentPhage || genes.length === 0) return 'No phage genome loaded.';

    const strands = summarizeGeneStrands(genes);
    const unknownPart = strands.unknown > 0
      ? `, and ${strands.unknown} with unknown strand annotation`
      : '';
    const lengthPart = genomeLength === null
      ? ' Genome length is not reported.'
      : ` Genome length: ${genomeLength.toLocaleString()} base pairs.`;

    return `Gene map showing ${genes.length} genes for ${currentPhage.name}: ` +
      `${strands.forward} on the forward strand, ${strands.reverse} on the reverse strand${unknownPart}.` +
      `${lengthPart} Click or tap to navigate to a gene position.`;
  }, [currentPhage, genes, genomeLength]);

  const [hoveredGene, setHoveredGene] = React.useState<{
    name: string;
    product?: string;
    x: number;
    y: number;
  } | null>(null);

  const lastTouchEndRef = useRef(0);
  const longPressTimerRef = useRef<number | null>(null);
  const tooltipDismissTimerRef = useRef<number | null>(null);
  const touchSessionRef = useRef<{
    startClientX: number;
    startClientY: number;
    moved: boolean;
    longPressed: boolean;
    gene: GeneInfo | null;
  } | null>(null);
  const rafIdRef = useRef<number | null>(null);
  const drawPendingRef = useRef(false);

  const clearLongPressTimer = () => {
    if (longPressTimerRef.current !== null) {
      window.clearTimeout(longPressTimerRef.current);
      longPressTimerRef.current = null;
    }
  };

  const clearTooltipDismissTimer = () => {
    if (tooltipDismissTimerRef.current !== null) {
      window.clearTimeout(tooltipDismissTimerRef.current);
      tooltipDismissTimerRef.current = null;
    }
  };

  useEffect(() => {
    return () => {
      clearLongPressTimer();
      clearTooltipDismissTimer();
      if (rafIdRef.current !== null) {
        cancelAnimationFrame(rafIdRef.current);
        rafIdRef.current = null;
      }
    };
  }, []);

  const toScrollUnits = (posBase: number): number =>
    viewMode === 'aa' ? Math.floor(posBase / 3) : posBase;

  const getHitInfo = (clientX: number, clientY: number): HitInfo | undefined => {
    const canvas = canvasRef.current;
    if (!canvas || genomeLength === null || genomeLength <= 0) return;

    const rect = canvas.getBoundingClientRect();
    const x = clientX - rect.left;
    const y = clientY - rect.top;
    if (rect.width <= 0 || rect.height <= 0) return;
    if (x < 0 || x > rect.width || y < 0 || y > rect.height) return;

    const posBase = Math.min(
      genomeLength - 1,
      Math.max(0, Math.floor((x / rect.width) * genomeLength))
    );
    const targetDirection = getGeneMapTrackDirectionAtY(y);
    let bestGene: GeneInfo | null = null;
    let bestDistance = Number.POSITIVE_INFINITY;

    if (targetDirection) {
      for (const gene of genes) {
        for (const segment of getGeneMapSegments(gene)) {
          if (classifyGeneStrand(segment.strand) !== targetDirection) continue;
          const startPosition = segment.start;
          const endPosition = segment.end;
          const startX = (startPosition / genomeLength) * rect.width;
          const endX = (endPosition / genomeLength) * rect.width;
          const geneWidth = Math.max(1, endX - startX);
          const hitWidth = Math.max(geneWidth, 44);
          const centerX = startX + geneWidth / 2;

          if (x < centerX - hitWidth / 2 || x > centerX + hitWidth / 2) continue;
          const distance = Math.abs(x - centerX);
          if (distance < bestDistance) {
            bestDistance = distance;
            bestGene = gene;
          }
        }
      }
    }

    return { posBase, gene: bestGene, clientX, clientY };
  };

  const showTooltip = (gene: GeneInfo, clientX: number, clientY: number) => {
    setHoveredGene({
      name: gene.locusTag || gene.name || 'Unknown gene',
      product: gene.product ?? undefined,
      x: clientX,
      y: clientY,
    });
  };

  const scheduleTooltipDismiss = (ms: number) => {
    clearTooltipDismissTimer();
    tooltipDismissTimerRef.current = window.setTimeout(() => setHoveredGene(null), ms);
  };

  const selectHit = (hit: HitInfo) => {
    const targetBase = hit.gene
      ? Math.min(hit.gene.startPos, hit.gene.endPos)
      : hit.posBase;
    onGeneSelect?.(hit.gene);
    onGeneClick?.(toScrollUnits(targetBase));
  };

  const handleClick = (event: React.MouseEvent<HTMLCanvasElement>) => {
    if (performance.now() - lastTouchEndRef.current < 500) return;
    const hit = getHitInfo(event.clientX, event.clientY);
    if (hit) selectHit(hit);
  };

  const handleMouseMove = (event: React.MouseEvent<HTMLCanvasElement>) => {
    const hit = getHitInfo(event.clientX, event.clientY);
    if (!hit?.gene) {
      setHoveredGene(null);
      return;
    }
    showTooltip(hit.gene, hit.clientX, hit.clientY - 10);
  };

  const handleTouchStart = (event: React.TouchEvent<HTMLCanvasElement>) => {
    if (event.touches.length !== 1) return;
    const touch = event.touches[0];
    const hit = getHitInfo(touch.clientX, touch.clientY);
    if (!hit) return;

    clearLongPressTimer();
    clearTooltipDismissTimer();
    touchSessionRef.current = {
      startClientX: touch.clientX,
      startClientY: touch.clientY,
      moved: false,
      longPressed: false,
      gene: hit.gene,
    };

    if (hit.gene) {
      longPressTimerRef.current = window.setTimeout(() => {
        const session = touchSessionRef.current;
        if (!session || session.moved || !hit.gene) return;
        session.longPressed = true;
        showTooltip(hit.gene, hit.clientX, hit.clientY - 40);
        onGeneSelect?.(hit.gene);
      }, 300);
    }
  };

  const handleTouchMove = (event: React.TouchEvent<HTMLCanvasElement>) => {
    if (event.touches.length !== 1) return;
    const session = touchSessionRef.current;
    if (!session) return;

    const touch = event.touches[0];
    if (Math.hypot(
      touch.clientX - session.startClientX,
      touch.clientY - session.startClientY
    ) > 10) {
      session.moved = true;
      clearLongPressTimer();
      if (!session.longPressed) setHoveredGene(null);
    }

    if (session.longPressed && session.gene) {
      showTooltip(session.gene, touch.clientX, touch.clientY - 40);
    }
  };

  const handleTouchEnd = (event: React.TouchEvent<HTMLCanvasElement>) => {
    lastTouchEndRef.current = performance.now();
    clearLongPressTimer();

    const session = touchSessionRef.current;
    touchSessionRef.current = null;
    if (!session) return;
    if (session.longPressed) {
      scheduleTooltipDismiss(2000);
      return;
    }
    if (session.moved || event.changedTouches.length !== 1) {
      setHoveredGene(null);
      return;
    }

    const touch = event.changedTouches[0];
    const hit = getHitInfo(touch.clientX, touch.clientY);
    if (!hit) return;
    selectHit(hit);

    if (hit.gene) {
      showTooltip(hit.gene, hit.clientX, hit.clientY - 40);
      scheduleTooltipDismiss(900);
    } else {
      setHoveredGene(null);
    }
  };

  const handleTouchCancel = () => {
    clearLongPressTimer();
    touchSessionRef.current = null;
    setHoveredGene(null);
  };

  const scrollPositionRef = useRef(scrollPosition);
  const colorsRef = useRef(colors);
  const genesRef = useRef(genes);
  const genomeLengthRef = useRef<number | null>(genomeLength);
  const viewModeRef = useRef(viewMode);
  const heightRef = useRef(height);
  const currentPhageRef = useRef(currentPhage);

  useEffect(() => { scrollPositionRef.current = scrollPosition; }, [scrollPosition]);
  useEffect(() => { colorsRef.current = colors; }, [colors]);
  useEffect(() => { genesRef.current = genes; }, [genes]);
  useEffect(() => { genomeLengthRef.current = genomeLength; }, [genomeLength]);
  useEffect(() => { viewModeRef.current = viewMode; }, [viewMode]);
  useEffect(() => { heightRef.current = height; }, [height]);
  useEffect(() => { currentPhageRef.current = currentPhage; }, [currentPhage]);

  const drawCanvas = React.useCallback(() => {
    const canvas = canvasRef.current;
    const phage = currentPhageRef.current;
    if (!canvas || !phage) return;

    const ctx = canvas.getContext('2d');
    if (!ctx) return;

    const h = heightRef.current;
    const c = colorsRef.current;
    const g = genesRef.current;
    const gl = genomeLengthRef.current;
    const sp = scrollPositionRef.current;
    const vm = viewModeRef.current;
    const dpr = Math.max(1, window.devicePixelRatio || 1);
    const rect = canvas.getBoundingClientRect();
    const width = Math.max(1, rect.width);
    const displayHeight = Math.max(1, rect.height || h);
    const pixelWidth = Math.max(1, Math.round(width * dpr));
    const pixelHeight = Math.max(1, Math.round(displayHeight * dpr));

    if (canvas.width !== pixelWidth) canvas.width = pixelWidth;
    if (canvas.height !== pixelHeight) canvas.height = pixelHeight;
    ctx.setTransform(pixelWidth / width, 0, 0, pixelHeight / displayHeight, 0, 0);
    ctx.clearRect(0, 0, width, displayHeight);
    ctx.fillStyle = c.background;
    ctx.fillRect(0, 0, width, displayHeight);

    if (gl === null || gl <= 0) {
      ctx.fillStyle = c.textMuted;
      ctx.font = '11px sans-serif';
      ctx.textAlign = 'center';
      ctx.textBaseline = 'middle';
      ctx.fillText('Genome length not reported', width / 2, displayHeight / 2);
      return;
    }

    for (const track of [
      GENE_MAP_FORWARD_TRACK,
      GENE_MAP_REVERSE_TRACK,
      GENE_MAP_UNKNOWN_TRACK,
    ]) {
      ctx.fillStyle = c.backgroundAlt;
      ctx.fillRect(0, track.y, width, track.height);
    }

    ctx.strokeStyle = c.borderLight;
    ctx.lineWidth = 1;
    ctx.beginPath();
    ctx.moveTo(0, 26);
    ctx.lineTo(width, 26);
    ctx.stroke();

    for (const gene of g) {
      for (const segment of getGeneMapSegments(gene)) {
        const startPosition = segment.start;
        const endPosition = segment.end;
        const startX = (startPosition / gl) * width;
        const endX = (endPosition / gl) * width;
        const geneWidth = Math.max(1, endX - startX);
        const direction = classifyGeneStrand(segment.strand);
        const track = getGeneMapTrack(direction);

        ctx.fillStyle = direction === 'forward'
          ? (c.geneForward ?? '#22c55e')
          : direction === 'reverse'
            ? (c.geneReverse ?? '#ef4444')
            : c.textMuted;
        ctx.fillRect(startX, track.y, geneWidth, track.height);

        if (geneWidth > 40 && gene.name) {
          ctx.fillStyle = '#ffffff';
          ctx.font = direction === 'unknown' ? '8px sans-serif' : '10px sans-serif';
          ctx.textAlign = 'center';
          ctx.textBaseline = 'middle';
          ctx.fillText(gene.name, startX + geneWidth / 2, track.y + track.height / 2);
        }
      }
    }

    const effectivePos = vm === 'aa' ? sp * 3 : sp;
    const cursorX = Math.min(width, Math.max(0, (effectivePos / gl) * width));
    ctx.strokeStyle = c.accent;
    ctx.lineWidth = 2;
    ctx.beginPath();
    ctx.moveTo(cursorX, 0);
    ctx.lineTo(cursorX, displayHeight);
    ctx.stroke();

    ctx.fillStyle = c.accent;
    ctx.beginPath();
    ctx.moveTo(cursorX - 4, 0);
    ctx.lineTo(cursorX + 4, 0);
    ctx.lineTo(cursorX, 6);
    ctx.fill();
  }, []);

  useEffect(() => {
    drawPendingRef.current = true;
    if (rafIdRef.current !== null) return;

    rafIdRef.current = requestAnimationFrame(() => {
      rafIdRef.current = null;
      if (!drawPendingRef.current) return;
      drawPendingRef.current = false;
      drawCanvas();
    });
  }, [colors, currentPhage, drawCanvas, genes, genomeLength, height, scrollPosition, viewMode]);

  return (
    <div
      className={`gene-map-container${className ? ` ${className}` : ''}`}
      role="figure"
      aria-label={`Gene map visualization${currentPhage ? ` for ${currentPhage.name}` : ''}`}
      aria-describedby={descriptionId}
      style={{
        position: 'relative',
        height,
        border: `1px solid ${colors.border}`,
        borderRadius: '6px',
        overflow: 'hidden',
        marginBottom: '8px',
      }}
    >
      <div id={descriptionId} style={srOnly}>{geneDescription}</div>
      <div role="status" aria-live="polite" aria-atomic="true" style={srOnly}>
        {hoveredGene
          ? `Gene: ${hoveredGene.name}${hoveredGene.product ? `. Product: ${hoveredGene.product}` : ''}`
          : ''}
      </div>

      <canvas
        ref={canvasRef}
        style={{
          width: '100%',
          height: '100%',
          display: 'block',
          cursor: genomeLength === null ? 'default' : 'pointer',
          touchAction: 'pan-y',
        }}
        onClick={handleClick}
        onMouseMove={handleMouseMove}
        onMouseLeave={() => setHoveredGene(null)}
        onTouchStart={handleTouchStart}
        onTouchMove={handleTouchMove}
        onTouchEnd={handleTouchEnd}
        onTouchCancel={handleTouchCancel}
        aria-hidden="true"
        title={genomeLength === null ? 'Genome length not reported' : 'Click to jump to position'}
      />

      {hoveredGene && (() => {
        const vv = typeof window !== 'undefined' ? window.visualViewport : null;
        const viewportWidth = vv?.width ?? (typeof window !== 'undefined' ? window.innerWidth : 0);
        const viewportHeight = vv?.height ?? (typeof window !== 'undefined' ? window.innerHeight : 0);
        const viewportLeft = vv?.offsetLeft ?? 0;
        const viewportTop = vv?.offsetTop ?? 0;
        const leftMin = viewportLeft + 12;
        const leftMax = Math.max(leftMin, viewportLeft + viewportWidth - 12);
        const topMin = viewportTop + 12;
        const topMax = Math.max(topMin, viewportTop + viewportHeight - 12);
        const clampedLeft = Math.min(Math.max(hoveredGene.x, leftMin), leftMax);
        const clampedTop = Math.min(Math.max(hoveredGene.y, topMin), topMax);

        return (
          <div
            id={tooltipId}
            role="tooltip"
            style={{
              position: 'fixed',
              left: clampedLeft,
              top: clampedTop,
              transform: clampedTop < topMin + 48
                ? 'translate(-50%, 14px)'
                : 'translate(-50%, -100%)',
              backgroundColor: colors.backgroundAlt,
              border: `1px solid ${colors.border}`,
              borderRadius: '4px',
              padding: '4px 8px',
              pointerEvents: 'none',
              zIndex: 1000,
              boxShadow: '0 2px 8px rgba(0,0,0,0.2)',
              fontSize: '12px',
              maxWidth: 'min(240px, calc(100vw - env(safe-area-inset-left) - env(safe-area-inset-right) - 24px))',
            }}
          >
            <div style={{ fontWeight: 'bold', color: colors.text }}>{hoveredGene.name}</div>
            {hoveredGene.product && (
              <div style={{ color: colors.textDim, fontSize: '10px', marginTop: '2px' }}>
                {hoveredGene.product}
              </div>
            )}
          </div>
        );
      })()}
    </div>
  );
}

export const GeneMapCanvas = memo(GeneMapCanvasBase);
