import { useEffect, useRef, type ReactElement } from 'react';
import type { GeneInfo } from '@phage-explorer/core';
import { usePhageStore, useSelectedGeneStore } from '../store';
import { classifyGeneStrand } from '../utils/gene-strand';
import { getGeneMapTrackDirectionAtY } from '../utils/gene-map-layout';

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

const MIN_GENE_HIT_WIDTH = 44;
const MAX_TAP_TRAVEL = 12;
const CLEAR_SELECTION_SELECTOR = [
  '[data-clear-selected-gene]',
  'button[aria-label="Clear selected gene"]',
  'button[title="Clear selection"]',
].join(', ');

export function findGeneAtMapPoint(
  genes: readonly GeneInfo[],
  genomeLength: number,
  geometry: GeneMapGeometry
): GeneInfo | null {
  if (
    !Number.isFinite(genomeLength) ||
    genomeLength <= 0 ||
    !Number.isFinite(geometry.width) ||
    !Number.isFinite(geometry.height) ||
    !Number.isFinite(geometry.x) ||
    !Number.isFinite(geometry.y) ||
    geometry.width <= 0 ||
    geometry.height <= 0 ||
    geometry.x < 0 ||
    geometry.x > geometry.width ||
    geometry.y < 0 ||
    geometry.y > geometry.height
  ) {
    return null;
  }

  const targetDirection = getGeneMapTrackDirectionAtY(geometry.y);
  if (!targetDirection) return null;

  let bestGene: GeneInfo | null = null;
  let bestDistance = Number.POSITIVE_INFINITY;

  for (const gene of genes) {
    if (classifyGeneStrand(gene.strand) !== targetDirection) continue;

    const startPosition = Math.min(gene.startPos, gene.endPos);
    const endPosition = Math.max(gene.startPos, gene.endPos);
    const startX = (startPosition / genomeLength) * geometry.width;
    const endX = (endPosition / genomeLength) * geometry.width;
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

function isClearSelectionTarget(target: EventTarget | null): boolean {
  return target instanceof Element && Boolean(target.closest(CLEAR_SELECTION_SELECTOR));
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
      if (isClearSelectionTarget(event.target)) clearSelectedGene();
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
