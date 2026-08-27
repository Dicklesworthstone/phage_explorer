export interface PhageCitationInput {
  name: string;
  accession: string;
  explorerUrl: string;
  pdbIds?: readonly string[];
  accessedAt?: Date;
}

export function buildNcbiNucleotideUrl(accession: string): string {
  return `https://www.ncbi.nlm.nih.gov/nuccore/${encodeURIComponent(accession.trim())}`;
}

export function buildRcsbPdbUrl(pdbId: string): string {
  return `https://www.rcsb.org/structure/${encodeURIComponent(pdbId.trim().toUpperCase())}`;
}

export function formatCitationAccessDate(date: Date): string {
  if (!Number.isFinite(date.getTime())) return 'unknown date';
  return date.toISOString().slice(0, 10);
}

export function buildPhageCitation({
  name,
  accession,
  explorerUrl,
  pdbIds = [],
  accessedAt = new Date(),
}: PhageCitationInput): string {
  const cleanName = name.trim() || 'Bacteriophage record';
  const cleanAccession = accession.trim();
  const uniquePdbIds = Array.from(
    new Set(
      pdbIds
        .map((pdbId) => pdbId.trim().toUpperCase())
        .filter(Boolean)
    )
  );
  const accessionPart = cleanAccession
    ? `NCBI Nucleotide accession ${cleanAccession}.`
    : 'NCBI Nucleotide record.';
  const pdbPart = uniquePdbIds.length > 0
    ? ` Associated phage-level RCSB PDB records: ${uniquePdbIds.join(', ')}.`
    : '';
  const cleanExplorerUrl = explorerUrl.trim();
  const explorerPart = cleanExplorerUrl
    ? ` Phage Explorer, ${cleanExplorerUrl}`
    : ' Phage Explorer';

  return `${cleanName}. ${accessionPart}${pdbPart}${explorerPart} (accessed ${formatCitationAccessDate(accessedAt)}).`;
}
