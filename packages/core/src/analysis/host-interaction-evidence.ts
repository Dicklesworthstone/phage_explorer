/** Portable observation evidence for a validated deposited phage-host protein complex. */
import { analysisJson, createAnalysisRecord, parseAnalysisRecord, serializeAnalysisRecord,
  type AnalysisField, type AnalysisRecord } from '../analysis-result';
import { parseProteinReferenceBundle, type ProteinReferenceBundle } from '../protein-reference';

export const DEPOSITED_HOST_INTERACTION_METHOD = {
  id: 'deposited-host-interaction-evidence',
  version: '1',
  implementation: 'validated deposited-complex snapshot; published domain/loop assignments and observed mapped chain coverage; no affinity or mutation inference',
} as const;

export interface DepositedHostInteractionEvidence {
  bundleId: string;
  bundleSha256: string;
  evidence: ProteinReferenceBundle['evidence'];
  phageProtein: { id: string; accession: string; organism: string; length: number };
  hostProtein: { id: string; accession: string; organism: string; length: number };
  chains: Array<{
    proteinId: string; pdbId: string; entryVersion: string; assemblyId: string;
    labelAsymId: string; authAsymId: string; start: number; end: number; observedCaResidues: number;
  }>;
  interactions: ProteinReferenceBundle['domainInteractions'];
  sources: ProteinReferenceBundle['sources'];
  limitations: string[];
}

function evidenceFor(bundle: ProteinReferenceBundle): DepositedHostInteractionEvidence {
  const phage = bundle.proteins.find(row => row.id === bundle.evidence.phageProteinId);
  const host = bundle.proteins.find(row => row.id === bundle.evidence.hostProteinId);
  if (!phage || !host) throw new Error('Deposited interaction partners are unavailable in the validated reference.');
  const limitations = [
    'The reference records a deposited complex and published domain/loop assignments; it does not establish host range outside the reported experimental context.',
    'Observed C-alpha coverage contains only deposited model coordinates. Missing residues and atoms are unavailable, not interpolated.',
    'No binding free energy, dissociation constant, buried surface area, mutation effect or engineered host-range shift is inferred from these inputs.',
    'Source hashes identify retained content; they do not independently authenticate the publications or deposited records.',
  ];
  return {
    bundleId: bundle.id, bundleSha256: bundle.bundleSha256, evidence: structuredClone(bundle.evidence),
    phageProtein: { id: phage.id, accession: phage.accession, organism: phage.organism, length: phage.sequence.length },
    hostProtein: { id: host.id, accession: host.accession, organism: host.organism, length: host.sequence.length },
    chains: bundle.chains.map(chain => ({
      proteinId: chain.proteinId, pdbId: chain.pdbId, entryVersion: chain.entryVersion, assemblyId: chain.assemblyId,
      labelAsymId: chain.labelAsymId, authAsymId: chain.authAsymId, start: chain.start, end: chain.end,
      observedCaResidues: chain.coordinates.length,
    })),
    interactions: structuredClone(bundle.domainInteractions), sources: structuredClone(bundle.sources), limitations,
  };
}
const unavailable = (label: string, missingInputs: string[]): AnalysisField => ({
  label, kind: 'unavailable', value: null, units: null,
  coverage: { available: 0, total: 1, unit: 'records' },
  limitations: ['The deposited-complex evidence contract does not synthesize this quantity.'], missingInputs,
});

export async function createDepositedHostInteractionRecord(value: unknown): Promise<{
  bundle: ProteinReferenceBundle; evidence: DepositedHostInteractionEvidence; record: AnalysisRecord;
}> {
  const bundle = await parseProteinReferenceBundle(value), evidence = evidenceFor(bundle), inputId = 'proteinReference';
  const observation = (label: string, value: unknown, available: number, total = available,
    unit: 'records' | 'residues' = 'records'): AnalysisField => ({
    label, kind: 'observation', value: analysisJson(value), units: unit,
    coverage: { available, total, unit }, limitations: evidence.limitations, sourceInput: inputId,
  });
  const observedResidues = evidence.chains.reduce((sum, chain) => sum + chain.observedCaResidues, 0);
  const mappedResidues = evidence.chains.reduce((sum, chain) => sum + chain.end - chain.start + 1, 0);
  const record = await createAnalysisRecord({
    method: DEPOSITED_HOST_INTERACTION_METHOD,
    inputs: [{ id: inputId, accession: evidence.phageProtein.accession, source: 'external',
      description: `${bundle.id}: validated deposited phage-host protein complex and published interaction assignments`,
      data: analysisJson(bundle) }],
    parameters: {}, seed: null,
    references: bundle.sources.map(source => ({ id: source.id, version: source.version,
      description: `${source.uri}; license ${source.license}; retrieved ${source.retrievedAt}; sha256 ${source.sha256}` })),
    fields: {
      interaction: observation('Deposited complex identity, experimental host and published domain/loop assignments',
        { evidence: evidence.evidence, phageProtein: evidence.phageProtein, hostProtein: evidence.hostProtein,
          interactions: evidence.interactions }, evidence.interactions.length),
      chainCoverage: observation('Observed mapped chain coverage in the deposited assembly',
        evidence.chains, observedResidues, mappedResidues, 'residues'),
      sourceManifest: observation('Pinned source manifest for the deposited interaction evidence',
        evidence.sources, evidence.sources.length),
      bindingAffinity: unavailable('Binding affinity / Kd',
        ['Experimentally measured affinity or a separately validated affinity estimator tied to this exact complex.']),
      bindingFreeEnergy: unavailable('Binding free energy / ΔG',
        ['Measured or rigorously calculated free energy for this exact complex under stated conditions.']),
      buriedSurfaceArea: unavailable('Buried surface area / SASA-derived interface area',
        ['A validated solvent-accessible surface calculation over the complete relevant structural model.']),
      mutationEffects: unavailable('Mutation ΔΔG / engineered host-range effects',
        ['Measured mutation effects or a validated mutation-effect model with explicit sequence/structure inputs.']),
    },
  });
  return { bundle, evidence, record };
}
export async function replayDepositedHostInteractionRecord(content: string): Promise<{
  bundle: ProteinReferenceBundle; evidence: DepositedHostInteractionEvidence; record: AnalysisRecord;
}> {
  const saved = await parseAnalysisRecord(content, { methodId: DEPOSITED_HOST_INTERACTION_METHOD.id,
    methodVersion: DEPOSITED_HOST_INTERACTION_METHOD.version });
  if (saved.inputs.length !== 1 || saved.inputs[0].id !== 'proteinReference' || Object.keys(saved.parameters).length !== 0) {
    throw new Error('Deposited host-interaction replay requires one exact protein reference and no fitted parameters.');
  }
  const fresh = await createDepositedHostInteractionRecord(saved.inputs[0].data);
  if (fresh.record.cacheKey !== saved.cacheKey || fresh.record.resultId !== saved.resultId
    || serializeAnalysisRecord(fresh.record) !== serializeAnalysisRecord(saved)) {
    throw new Error('Recomputed deposited host-interaction evidence differs from the saved record.');
  }
  return fresh;
}
const tsvCell = (value: string): string =>
  /[\t\r\n"]/.test(value) ? '"' + value.replace(/"/g, '""') + '"' : value;
export function exportDepositedHostInteractionTsv(record: AnalysisRecord): string {
  if (record.method.id !== DEPOSITED_HOST_INTERACTION_METHOD.id || record.method.version !== DEPOSITED_HOST_INTERACTION_METHOD.version) {
    throw new Error('Expected deposited host-interaction evidence.');
  }
  const value = record.fields.interaction.value as unknown as {
    evidence: ProteinReferenceBundle['evidence'];
    phageProtein: DepositedHostInteractionEvidence['phageProtein'];
    hostProtein: DepositedHostInteractionEvidence['hostProtein'];
    interactions: ProteinReferenceBundle['domainInteractions'];
  };
  return [
    `# method=${record.method.id}; version=${record.method.version}; result=${record.resultId}`,
    `# experimental_host=${JSON.stringify(value.evidence.experimentalHost)}; publication_doi=${value.evidence.publicationDoi}`,
    '# Deposited-complex domain/loop observations only. No ΔG, Kd, buried surface area, mutation effect or host-range estimate is implied.',
    ['phage_protein_id','phage_accession','host_protein_id','host_accession','pdb_id','phage_domain','host_domain',
      'phage_loops','host_loops','source_id','source_section','method'].join('\t'),
    ...value.interactions.map(row => [
      row.phageProteinId, value.phageProtein.accession, row.hostProteinId, value.hostProtein.accession, row.pdbId,
      row.phageDomain, row.hostDomain, row.phageLoops.join('|'), row.hostLoops.join('|'), row.sourceId, row.sourceSection, row.method,
    ].map(item => tsvCell(String(item))).join('\t')),
  ].join('\n') + '\n';
}
