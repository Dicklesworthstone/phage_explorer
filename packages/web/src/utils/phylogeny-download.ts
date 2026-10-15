/** Download representations of an accepted worker result, never unverified imported JSON. */
import { serializeAnalysisRecord } from '../../../core/src/analysis-result';
import type { AlignedPhylogenyExperiment } from '../../../core/src/analysis/aligned-phylogeny';
import { exportPhylogeny, type PhylogenyExportFormat } from '../../../core/src/analysis/phylogeny-export';

export type PhylogenyDownloadFormat = 'experiment' | 'newick' | 'distances' | 'splits' | 'splits-tsv' | 'alignment-fasta';
export interface PhylogenyDownload { content: string; filename: string; mimeType: string }

/** Preserve the existing JSON downloads; use the same Newick/TSV/FASTA bytes as the headless command. */
export function preparePhylogenyDownload(experiment: AlignedPhylogenyExperiment, format: PhylogenyDownloadFormat): PhylogenyDownload {
  const { result, record } = experiment;
  if (format === 'experiment') return { content: serializeAnalysisRecord(record),
    filename: 'aligned-phylogeny-experiment.json', mimeType: 'application/json' };
  if (format === 'splits') return {
    content: JSON.stringify({ resultId: record.resultId, bootstrap: result.bootstrap, splits: result.splits, warnings: result.warnings }, null, 2) + '\n',
    filename: 'aligned-phylogeny-splits.json', mimeType: 'application/json',
  };
  const formats: Record<Exclude<PhylogenyDownloadFormat, 'experiment' | 'splits'>, { format: PhylogenyExportFormat; extension: string; mimeType: string }> = {
    newick: { format: 'newick', extension: 'nwk', mimeType: 'text/plain' },
    distances: { format: 'distances-tsv', extension: 'tsv', mimeType: 'text/tab-separated-values' },
    'splits-tsv': { format: 'splits-tsv', extension: 'tsv', mimeType: 'text/tab-separated-values' },
    'alignment-fasta': { format: 'alignment-fasta', extension: 'fasta', mimeType: 'text/plain' },
  };
  if (!Object.hasOwn(formats, format)) throw new Error('Unsupported phylogeny download format.');
  const selected = formats[format];
  return { content: exportPhylogeny(experiment, selected.format), filename: `aligned-phylogeny-${format}.${selected.extension}`, mimeType: selected.mimeType };
}
