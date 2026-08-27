import { useEffect, useRef, type ReactElement } from 'react';
import type { GeneInfo } from '@phage-explorer/core';
import { usePhageStore, useSelectedGeneStore } from '../store';

interface GeneMapGeometry {
  width: number;
  height: number;
  x: number;
  y: number;
}

interface PointerStart {
  canvas: HTMLCanvasElement;
  x: number;
  y: number;
}

const FORWARD_TRACK_Y = 10;
const REVERSE_TRACK_Y = 30;
const TRACK_HEIGHT = 12;
const MIN_GENE_HIT_WIDTH = 44;
const MAX_TAP_TRAVEL = 12;

export function findGeneAtMapPoint(
  genes: readonly GeneInfo[],
  genomeLength: number,
  geometry: GeneMapGeometry
): GeneInfo | null {
  if (
    genomeLength <= 0 ||
    geometry.width <= 0 ||
    geometry.height <= 0 ||
    geometry.x < 0 ||
    geometry.x > geometry.width ||
    geometry.y < 0 ||
    geometry.y > geometry.height
  ) {
    return null;
  }

  const inForward =
    geometry.y >= FORWARD_TRACK_Y &&
    geometry.y <= FORWARD_TRACK_Y + TRACK_HEIGHT;
  const inReverse =
    geometry.y >= REVERSE_TRACK_Y &&
    geometry.y <= REVERSE_TRACK_Y + TRACK_HEIGHT;
  if (!inForward && !inReverse) return null;

  let bestGene: GeneInfo | null = null;
  let bestDistance = Number.POSITIVE_INFINITY;

  for (const gene of genes) {
    const isForward = gene.strand !== '-';
    if (inForward && !isForward) continue;
    if (inReverse && isForward) continue;

    const startX = (gene.startPos / genomeLength) * geometry.width;
    const endX = (gene.endPos / genomeLength) * geometry.width;
    const renderedWidth = Math.max(1, endX - startX);
    const hitWidth = Math.max(renderedWidth, MIN_GENE_HIT_WIDTH);
    const centerX = startX + renderedWidth / 2;
    const hitStart = centerX - hitWidth / 2;
    const hitEnd = centerX + hitWidth / 2;

    if (geometry.x < hitStart || geometry.x > hitEnd) continue;
    const distance = Math.abs(geometry.x - centerX);
    if (distance < bestDistance) {
      bestDistance = distance;
      bestGene = gene;
    }
  }

  return bestGene;
}

function getGeneMapCanvas(target: EventTarget | null): HTMLCanvasElement | null {
  if (!(target instanceof Element)) return null;
  const canvas = target.closest('.gene-map-container canvas');
  return canvas instanceof HTMLCanvasElement ? canvas : null;
}

export function GeneSelectionBridge(): ReactElement | null {
  const currentPhage = usePhageStore((state) => state.currentPhage);
  const setSelectedGeneId = useSelectedGeneStore((state) => state.setSelectedGeneId);
  const clearSelectedGene = useSelectedGeneStore((state) => state.clearSelectedGene);
  const pointerStartsRef = useRef(new Map<number, PointerStart>());

  useEffect(() => {
    if (typeof document === 'undefined') return;

    const handlePointerDown = (event: PointerEvent) => {
      const canvas = getGeneMapCanvas(event.target);
      if (!canvas) return;
      pointerStartsRef.current.set(event.pointerId, {
        canvas,
        x: event.clientX,
        y: event.clientY,
      });
    };

    const handlePointerUp = (event: PointerEvent) => {
      const start = pointerStartsRef.current.get(event.pointerId);
      pointerStartsRef.current.delete(event.pointerId);
      if (!start || !currentPhage) return;
      if (Math.hypot(event.clientX - start.x, event.clientY - start.y) > MAX_TAP_TRAVEL) return;

      const rect = start.canvas.getBoundingClientRect();
      const gene = findGeneAtMapPoint(
        currentPhage.genes,
        currentPhage.genomeLength ?? 0,
        {
          width: rect.width,
          height: rect.height,
          x: event.clientX - rect.left,
          y: event.clientY - rect.top,
        }
      );
      setSelectedGeneId(gene?.id ?? null);
    };

    const handlePointerCancel = (event: PointerEvent) => {
      pointerStartsRef.current.delete(event.pointerId);
    };

    const handleClick = (event: MouseEvent) => {
      const target = event.target;
      if (!(target instanceof Element)) return;
      if (target.closest('button[title="Clear selection"]')) {
        clearSelectedGene();
      }
    };

    document.addEventListener('pointerdown', handlePointerDown, true);
    document.addEventListener('pointerup', handlePointerUp, true);
    document.addEventListener('pointercancel', handlePointerCancel, true);
    document.addEventListener('click', handleClick, true);

    return () => {
      pointerStartsRef.current.clear();
      document.removeEventListener('pointerdown', handlePointerDown, true);
      document.removeEventListener('pointerup', handlePointerUp, true);
      document.removeEventListener('pointercancel', handlePointerCancel, true);
      document.removeEventListener('click', handleClick, true);
    };
  }, [clearSelectedGene, currentPhage, setSelectedGeneId]);

  return null;
}

export default GeneSelectionBridge;
