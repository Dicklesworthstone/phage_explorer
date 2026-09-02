/**
 * Donor reference panel for HGT provenance analysis.
 *
 * `analyzeHGTProvenance` infers, for each compositionally anomalous island, a
 * likely donor by comparing that island's k-mer profile against a library of
 * reference genomes. With an empty library there is nothing to compare, so
 * every island reports no donor and the "donor lineage" panel the overlay
 * advertises cannot render at all.
 *
 * The catalogue itself is the natural first panel: every other phage in the
 * database is a plausible donor, the sequences are already local, and the set
 * spans several hosts and families. The TUI already built this inline; this
 * module is the shared implementation so both surfaces load the same panel the
 * same way instead of one of them passing `{}`.
 */

/** Minimal repository surface needed to build a panel. */
export interface ReferencePanelSource {
  getFullGenomeLength(phageId: number): Promise<number>;
  getSequenceWindow(phageId: number, start: number, end: number): Promise<string>;
}

/** Minimal phage metadata needed to label a reference. */
export interface ReferencePanelPhage {
  id: number;
  name?: string | null;
  host?: string | null;
}

export interface ReferencePanelOptions {
  /**
   * Cap on bases taken from each reference genome. A contiguous prefix is
   * used rather than a subsample, because k-mer continuity is what the
   * comparison depends on. 200 kb covers all but the largest catalogue
   * entries (T4 is ~169 kb) while bounding memory.
   */
  maxBasesPerReference?: number;
  /** Cap on how many references to load. */
  maxReferences?: number;
  /** Abort signal checked between references. */
  signal?: { aborted: boolean };
}

export const DEFAULT_MAX_BASES_PER_REFERENCE = 200_000;
export const DEFAULT_MAX_REFERENCES = 50;

/**
 * Label a reference so a donor attribution is readable and unambiguous.
 *
 * The id suffix matters: two catalogue entries can share a display name, and
 * the label is the key of the returned record.
 */
export function referenceLabel(phage: ReferencePanelPhage): string {
  const name = phage.name ?? `phage-${phage.id}`;
  const host = phage.host ?? 'unknown host';
  return `${name} (${host}) #${phage.id}`;
}

/**
 * Build a donor reference panel from the catalogue, excluding the phage under
 * analysis so it cannot be reported as its own donor.
 *
 * Failures on individual references are skipped rather than failing the whole
 * panel: a partial panel still produces useful donor attributions, while an
 * exception would leave the overlay with nothing.
 */
export async function buildReferencePanel(
  source: ReferencePanelSource,
  phages: readonly ReferencePanelPhage[],
  excludePhageId: number | null,
  options: ReferencePanelOptions = {}
): Promise<Record<string, string>> {
  const maxBases = options.maxBasesPerReference ?? DEFAULT_MAX_BASES_PER_REFERENCE;
  const maxRefs = options.maxReferences ?? DEFAULT_MAX_REFERENCES;

  const candidates = phages
    .filter(p => p.id !== excludePhageId)
    .slice(0, maxRefs);

  const panel: Record<string, string> = {};

  for (const phage of candidates) {
    if (options.signal?.aborted) break;
    try {
      const length = await source.getFullGenomeLength(phage.id);
      if (!Number.isFinite(length) || length <= 0) continue;
      const sequence = await source.getSequenceWindow(
        phage.id,
        0,
        Math.min(length, maxBases)
      );
      if (!sequence) continue;
      panel[referenceLabel(phage)] = sequence.slice(0, maxBases);
    } catch {
      // A reference that cannot be read is simply not in the panel.
      continue;
    }
  }

  return panel;
}
