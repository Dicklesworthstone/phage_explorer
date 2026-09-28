/** Synthetic numerical fixture shared by interface tests. Not a biological reference model. */
import { validateHostModelInput } from './host-metabolism';
export function hostGeneWorkflowFixture() {
  return validateHostModelInput({ format: 'phage-explorer-host-model', version: 1,
    source: { kind: 'demo', name: 'Private gene-rule fixture', version: '1', organism: 'synthetic', strain: 'none', accession: 'fixture',
      reference: 'Analytic optimum min(9, 6*complexEnabled + 4*alternativeEnabled)', license: 'CC0-1.0', fluxUnits: 'arbitrary', objectiveUnits: 'arbitrary' },
    medium: { name: 'Fixed supply', reference: 'Synthetic supply cap 9', bounds: [] },
    cobra: { id: 'gpr-interface', metabolites: [{ id: 'S', compartment: 'c' }, { id: 'P', compartment: 'c' }],
      genes: ['a','b','c','d','unused'].map(id => ({ id })), reactions: [
        { id: 'supply', metabolites: { S: 1 }, lower_bound: 0, upper_bound: 9 },
        { id: 'complex', metabolites: { S: -1, P: 1 }, lower_bound: 0, upper_bound: 6, gene_reaction_rule: 'a and b' },
        { id: 'alternative', metabolites: { S: -1, P: 1 }, lower_bound: 0, upper_bound: 4, gene_reaction_rule: 'c or d' },
        { id: 'objective', metabolites: { P: -1 }, lower_bound: 0, upper_bound: 20, objective_coefficient: 1 },
      ] } });
}
