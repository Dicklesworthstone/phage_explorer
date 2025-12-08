/**
 * Shared visualization primitive types
 */

export interface ColorStop {
  value: number;
  color: string;
}

export interface ColorScale {
  stops: ColorStop[];
}

export interface MatrixData {
  /** Number of rows */
  rows: number;
  /** Number of columns */
  cols: number;
  /** Flattened values length = rows * cols */
  values: Float32Array | number[];
}

export interface HeatmapInteraction {
  row: number;
  col: number;
  value: number | null;
  clientX: number;
  clientY: number;
}

export interface ScatterPoint {
  x: number;
  y: number;
  value?: number;
  color?: string;
  radius?: number;
  meta?: Record<string, unknown>;
}

export interface ScatterScale {
  xMin: number;
  xMax: number;
  yMin: number;
  yMax: number;
}

export interface ScatterInteraction {
  point: ScatterPoint;
  index: number;
  clientX: number;
  clientY: number;
}

export interface ArcNode {
  id: string;
  label?: string;
  weight?: number;
}

export interface ArcLink {
  source: string;
  target: string;
  value: number;
  color?: string;
  meta?: Record<string, unknown>;
}

export interface ArcInteraction {
  link: ArcLink;
  index: number;
  clientX: number;
  clientY: number;
}

export interface GenomeTrackSegment {
  start: number;
  end: number;
  color?: string;
  label?: string;
  height?: number;
}

export interface GenomeTrackInteraction {
  position: number;
  segment: GenomeTrackSegment | null;
  clientX: number;
  clientY: number;
}

export interface GelBand {
  size: number; // in base pairs
  intensity: number; // 0-1
}

export interface GelLane {
  name: string;
  bands: GelBand[];
  color?: string;
}

export interface GelInteraction {
  laneIndex: number;
  bandIndex: number;
  band: GelBand;
  clientX: number;
  clientY: number;
}

