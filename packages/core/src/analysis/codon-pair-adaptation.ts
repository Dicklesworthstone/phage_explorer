/**
 * Phage-Host Codon & Codon-Pair Adaptation Lens
 *
 * Roadmap #44:
 * Quantifies Codon Adaptation Index (CAI), Relative Adaptation Index (RAI),
 * and Codon-Pair Bias (CPB) with z-scores against candidate bacterial host profiles
 * to detect translational compatibility, functional module adaptation,
 * and host-switching footprints.
 */

import { countCodonUsage, CODON_TABLE, reverseComplement } from '../codons';
import type { GeneInfo, PhageFull } from '../types';
import { getGeneMapSegments } from '../genome-import';
import { analysisJson, createAnalysisRecord, type AnalysisRecord } from '../analysis-result';

export interface HostProfile {
  key: string;
  name: string;
  taxonomyId: number;
  gcContent: number;
  // Relative adaptiveness weights w_c for all 64 codons (Sharp & Li 1987)
  codonWeights: Record<string, number>;
  // Codon frequency per 1000 codons in host genome
  codonFrequencies: Record<string, number>;
  // Codon pair score (CPS) dictionary for pair combinations (Coleman et al. 2008)
  cpsScores: Record<string, number>;
  // Host genome-wide mean gene CPB and standard deviation for Z-score normalization
  meanCpb: number;
  stdCpb: number;
  preferredPairs: string[];
  deoptimizedPairs: string[];
}

export type FunctionalModuleType =
  | 'structural'
  | 'replication'
  | 'lysis'
  | 'packaging_regulatory'
  | 'amg_auxiliary'
  | 'unclassified';

export interface GeneCodonAdaptation {
  geneId: number;
  name: string;
  locusTag: string;
  startPos: number;
  endPos: number;
  strand: string;
  product: string;
  module: FunctionalModuleType;
  codonCount: number;
  cai: Record<string, number>; // hostKey -> CAI
  cpb: Record<string, number>; // hostKey -> CPB
  zScore: Record<string, number>; // hostKey -> Z-score
  bestHost: string;
  primaryHostCai: number;
  primaryHostCpb: number;
  primaryHostZScore: number;
  hostSwitchFootprint?: {
    candidateHost: string;
    caiDelta: number;
    cpbDelta: number;
    significance: 'high' | 'moderate';
  };
}

export interface ModuleAdaptationSummary {
  module: FunctionalModuleType;
  displayName: string;
  geneCount: number;
  meanCai: number;
  meanCpb: number;
  meanZScore: number;
  adaptationStatus: 'adapted' | 'transitional' | 'mismatched_acquisition';
}

export interface HostCompatibilityRank {
  hostKey: string;
  hostName: string;
  meanCai: number;
  meanCpb: number;
  meanZScore: number;
  overallCompatibility: number; // 0..100
  isPrimaryHost: boolean;
}

export interface PhageHostAdaptationResult {
  phageId: number;
  phageName: string;
  primaryHost: string;
  genes: GeneCodonAdaptation[];
  modules: ModuleAdaptationSummary[];
  hostRankings: HostCompatibilityRank[];
  hostSwitchCandidates: GeneCodonAdaptation[];
  summary: string;
}

/**
 * Built-in illustrative host weights. This module does not supply a versioned
 * source corpus or calibration evidence for its pair scores and distributions.
 */
export const CANDIDATE_HOST_PROFILES: Record<string, HostProfile> = {
  escherichia_coli: {
    key: 'escherichia_coli',
    name: 'Escherichia coli',
    taxonomyId: 562,
    gcContent: 50.8,
    codonWeights: {
      TTT: 0.296, TTC: 1.000, TTA: 0.134, TTG: 0.144, CTT: 0.104, CTC: 0.103, CTA: 0.036, CTG: 1.000,
      ATT: 0.323, ATC: 1.000, ATA: 0.003, ATG: 1.000, GTT: 0.449, GTC: 0.216, GTA: 0.155, GTG: 1.000,
      TCT: 0.852, TCC: 0.744, TCA: 0.077, TCG: 0.089, AGT: 0.085, AGC: 0.410, CCT: 0.114, CCC: 0.012,
      CCA: 0.135, CCG: 1.000, ACT: 0.965, ACC: 1.000, ACA: 0.076, ACG: 0.143, GCT: 0.435, GCC: 0.274,
      GCA: 0.586, GCG: 1.000, TAT: 0.239, TAC: 1.000, TAA: 1.000, TAG: 0.002, CAT: 0.291, CAC: 1.000,
      CAA: 0.124, CAG: 1.000, TGA: 0.078, AAT: 0.051, AAC: 1.000, AAA: 1.000, AAG: 0.253, GAT: 0.434,
      GAC: 1.000, GAA: 1.000, GAG: 0.259, TGT: 0.500, TGC: 1.000, TGG: 1.000, CGT: 1.000, CGC: 0.980,
      CGA: 0.005, CGG: 0.004, AGA: 0.004, AGG: 0.002, GGT: 0.588, GGC: 1.000, GGA: 0.001, GGG: 0.013,
    },
    codonFrequencies: {
      CTG: 52.8, GAA: 39.6, GCG: 33.6, GAT: 32.2, AAA: 33.6, GGC: 29.5, ACC: 23.4, ATG: 27.8,
      ATC: 25.1, GTT: 18.2, AAC: 21.6, CAG: 28.9, GTG: 26.3, CGT: 20.9, CGC: 22.0, TTC: 16.5,
    },
    cpsScores: {
      'CTG_CTG': 0.38, 'GAA_GAA': 0.42, 'AAA_AAA': 0.35, 'ATG_GCG': 0.31, 'GCG_CTG': 0.29,
      'GAT_GAA': 0.28, 'GGC_GAA': 0.25, 'ACC_CTG': 0.24, 'AAC_AAA': 0.22, 'GTT_CTG': 0.21,
      'CCG_CCG': -0.45, 'CGA_CGA': -0.62, 'CTA_CTA': -0.58, 'AGG_AGG': -0.71, 'ATA_ATA': -0.65,
      'TCG_TCG': -0.38, 'CGG_CGA': -0.52, 'CCC_CCC': -0.41, 'TCA_TCA': -0.32,
    },
    meanCpb: 0.082,
    stdCpb: 0.095,
    preferredPairs: ['CTG_CTG', 'GAA_GAA', 'AAA_AAA', 'ATG_GCG', 'GCG_CTG'],
    deoptimizedPairs: ['AGG_AGG', 'CGA_CGA', 'ATA_ATA', 'CTA_CTA', 'CCG_CCG'],
  },
  pseudomonas_aeruginosa: {
    key: 'pseudomonas_aeruginosa',
    name: 'Pseudomonas aeruginosa',
    taxonomyId: 287,
    gcContent: 66.6,
    codonWeights: {
      TTT: 0.125, TTC: 1.000, TTA: 0.018, TTG: 0.115, CTT: 0.075, CTC: 0.582, CTA: 0.024, CTG: 1.000,
      ATT: 0.158, ATC: 1.000, ATA: 0.008, ATG: 1.000, GTT: 0.142, GTC: 0.725, GTA: 0.038, GTG: 1.000,
      TCT: 0.112, TCC: 0.765, TCA: 0.038, TCG: 1.000, AGT: 0.025, AGC: 0.812, CCT: 0.085, CCC: 0.624,
      CCA: 0.045, CCG: 1.000, ACT: 0.095, ACC: 1.000, ACA: 0.042, ACG: 0.612, GCT: 0.185, GCC: 1.000,
      GCA: 0.124, GCG: 0.854, TAT: 0.142, TAC: 1.000, TAA: 0.650, TAG: 0.085, CAT: 0.185, CAC: 1.000,
      CAA: 0.092, CAG: 1.000, TGA: 1.000, AAT: 0.085, AAC: 1.000, AAA: 0.285, AAG: 1.000, GAT: 0.245,
      GAC: 1.000, GAA: 0.325, GAG: 1.000, TGT: 0.215, TGC: 1.000, TGG: 1.000, CGT: 0.325, CGC: 1.000,
      CGA: 0.052, CGG: 0.685, AGA: 0.012, AGG: 0.015, GGT: 0.185, GGC: 1.000, GGA: 0.052, GGG: 0.245,
    },
    codonFrequencies: {
      CGC: 48.5, CTG: 62.4, GCC: 49.5, GTC: 38.5, GAG: 41.2, GAC: 42.5, ACC: 34.5, TTC: 31.2,
      CCG: 39.5, TCG: 28.5, AGC: 29.5, GCG: 36.2, GGC: 45.2, AAG: 38.5, GTG: 37.5, ATC: 32.5,
    },
    cpsScores: {
      'CGC_CTG': 0.44, 'GCC_GCC': 0.39, 'CTG_CTG': 0.41, 'GAG_CGC': 0.33, 'ACC_GCC': 0.30,
      'TTA_TTA': -0.75, 'CTA_CTA': -0.72, 'AGA_AGG': -0.68, 'ATA_ATA': -0.80, 'TCA_TCA': -0.45,
    },
    meanCpb: 0.094,
    stdCpb: 0.108,
    preferredPairs: ['CGC_CTG', 'GCC_GCC', 'CTG_CTG', 'GAG_CGC', 'ACC_GCC'],
    deoptimizedPairs: ['ATA_ATA', 'TTA_TTA', 'CTA_CTA', 'AGA_AGG', 'TCA_TCA'],
  },
  staphylococcus_aureus: {
    key: 'staphylococcus_aureus',
    name: 'Staphylococcus aureus',
    taxonomyId: 1280,
    gcContent: 32.8,
    codonWeights: {
      TTT: 1.000, TTC: 0.425, TTA: 1.000, TTG: 0.385, CTT: 0.412, CTC: 0.085, CTA: 0.155, CTG: 0.095,
      ATT: 1.000, ATC: 0.415, ATA: 0.285, ATG: 1.000, GTT: 1.000, GTC: 0.185, GTA: 0.655, GTG: 0.245,
      TCT: 0.885, TCC: 0.285, TCA: 1.000, TCG: 0.105, AGT: 0.625, AGC: 0.245, CCT: 0.855, CCC: 0.095,
      CCA: 1.000, CCG: 0.145, ACT: 0.925, ACC: 0.285, ACA: 1.000, ACG: 0.125, GCT: 1.000, GCC: 0.185,
      GCA: 0.855, GCG: 0.085, TAT: 1.000, TAC: 0.385, TAA: 1.000, TAG: 0.115, CAT: 1.000, CAC: 0.315,
      CAA: 1.000, CAG: 0.245, TGA: 0.185, AAT: 1.000, AAC: 0.415, AAA: 1.000, AAG: 0.315, GAT: 1.000,
      GAC: 0.285, GAA: 1.000, GAG: 0.285, TGT: 1.000, TGC: 0.245, TGG: 1.000, CGT: 0.655, CGC: 0.185,
      CGA: 0.285, CGG: 0.045, AGA: 1.000, AGG: 0.245, GGT: 1.000, GGC: 0.285, GGA: 0.725, GGG: 0.145,
    },
    codonFrequencies: {
      AAA: 58.5, AAT: 46.2, ATT: 48.5, TTT: 42.5, GAA: 49.5, GAT: 41.2, TTA: 38.5, CAA: 36.5,
      GTT: 32.5, GCT: 29.5, ACA: 28.5, TAT: 29.8, TCA: 25.4, AGA: 24.5, CCT: 18.5, GGT: 25.2,
    },
    cpsScores: {
      'AAA_AAA': 0.48, 'AAT_AAA': 0.38, 'ATT_AAA': 0.34, 'GAA_GAA': 0.40, 'TTT_ATT': 0.31,
      'CCG_CCG': -0.68, 'CGC_CGC': -0.62, 'CGG_CGG': -0.75, 'CTC_CTC': -0.58, 'GCG_GCG': -0.65,
    },
    meanCpb: 0.076,
    stdCpb: 0.091,
    preferredPairs: ['AAA_AAA', 'GAA_GAA', 'AAT_AAA', 'ATT_AAA', 'TTT_ATT'],
    deoptimizedPairs: ['CGG_CGG', 'CCG_CCG', 'GCG_GCG', 'CGC_CGC', 'CTC_CTC'],
  },
  mycobacterium_tuberculosis: {
    key: 'mycobacterium_tuberculosis',
    name: 'Mycobacterium tuberculosis',
    taxonomyId: 1773,
    gcContent: 65.6,
    codonWeights: {
      TTT: 0.145, TTC: 1.000, TTA: 0.024, TTG: 0.285, CTT: 0.085, CTC: 0.485, CTA: 0.035, CTG: 1.000,
      ATT: 0.185, ATC: 1.000, ATA: 0.012, ATG: 1.000, GTT: 0.165, GTC: 0.785, GTA: 0.045, GTG: 1.000,
      TCT: 0.095, TCC: 0.825, TCA: 0.045, TCG: 1.000, AGT: 0.035, AGC: 0.745, CCT: 0.095, CCC: 0.585,
      CCA: 0.055, CCG: 1.000, ACT: 0.115, ACC: 1.000, ACA: 0.052, ACG: 0.655, GCT: 0.195, GCC: 1.000,
      GCA: 0.145, GCG: 0.885, TAT: 0.165, TAC: 1.000, TAA: 0.525, TAG: 0.145, CAT: 0.215, CAC: 1.000,
      CAA: 0.115, CAG: 1.000, TGA: 1.000, AAT: 0.095, AAC: 1.000, AAA: 0.315, AAG: 1.000, GAT: 0.265,
      GAC: 1.000, GAA: 0.365, GAG: 1.000, TGT: 0.245, TGC: 1.000, TGG: 1.000, CGT: 0.285, CGC: 1.000,
      CGA: 0.065, CGG: 0.725, AGA: 0.018, AGG: 0.024, GGT: 0.195, GGC: 1.000, GGA: 0.065, GGG: 0.285,
    },
    codonFrequencies: {
      CGC: 46.2, CTG: 59.8, GCC: 48.2, GTC: 39.5, GAG: 42.1, GAC: 44.5, ACC: 35.8, TTC: 33.2,
      CCG: 38.2, TCG: 27.5, AGC: 28.5, GCG: 34.8, GGC: 46.5, AAG: 39.2, GTG: 38.5, ATC: 33.5,
    },
    cpsScores: {
      'CGC_CTG': 0.42, 'GCC_GCC': 0.38, 'CTG_CTG': 0.40, 'GAG_CGC': 0.32, 'ACC_GCC': 0.29,
      'TTA_TTA': -0.72, 'CTA_CTA': -0.70, 'AGA_AGG': -0.66, 'ATA_ATA': -0.78, 'TCA_TCA': -0.42,
    },
    meanCpb: 0.092,
    stdCpb: 0.105,
    preferredPairs: ['CGC_CTG', 'GCC_GCC', 'CTG_CTG', 'GAG_CGC', 'ACC_GCC'],
    deoptimizedPairs: ['ATA_ATA', 'TTA_TTA', 'CTA_CTA', 'AGA_AGG', 'TCA_TCA'],
  },
  salmonella_enterica: {
    key: 'salmonella_enterica',
    name: 'Salmonella enterica',
    taxonomyId: 28901,
    gcContent: 52.2,
    codonWeights: {
      TTT: 0.312, TTC: 1.000, TTA: 0.125, TTG: 0.138, CTT: 0.098, CTC: 0.112, CTA: 0.038, CTG: 1.000,
      ATT: 0.315, ATC: 1.000, ATA: 0.004, ATG: 1.000, GTT: 0.425, GTC: 0.225, GTA: 0.148, GTG: 1.000,
      TCT: 0.825, TCC: 0.725, TCA: 0.082, TCG: 0.095, AGT: 0.088, AGC: 0.425, CCT: 0.125, CCC: 0.015,
      CCA: 0.142, CCG: 1.000, ACT: 0.945, ACC: 1.000, ACA: 0.082, ACG: 0.155, GCT: 0.425, GCC: 0.285,
      GCA: 0.595, GCG: 1.000, TAT: 0.245, TAC: 1.000, TAA: 1.000, TAG: 0.003, CAT: 0.285, CAC: 1.000,
      CAA: 0.135, CAG: 1.000, TGA: 0.082, AAT: 0.055, AAC: 1.000, AAA: 1.000, AAG: 0.265, GAT: 0.445,
      GAC: 1.000, GAA: 1.000, GAG: 0.268, TGT: 0.485, TGC: 1.000, TGG: 1.000, CGT: 1.000, CGC: 0.965,
      CGA: 0.006, CGG: 0.005, AGA: 0.005, AGG: 0.003, GGT: 0.595, GGC: 1.000, GGA: 0.002, GGG: 0.015,
    },
    codonFrequencies: {
      CTG: 53.5, GAA: 39.8, GCG: 34.2, GAT: 32.5, AAA: 33.8, GGC: 30.1, ACC: 23.8, ATG: 28.1,
      ATC: 25.5, GTT: 18.5, AAC: 21.8, CAG: 29.2, GTG: 26.8, CGT: 21.2, CGC: 22.4, TTC: 16.8,
    },
    cpsScores: {
      'CTG_CTG': 0.39, 'GAA_GAA': 0.43, 'AAA_AAA': 0.36, 'ATG_GCG': 0.32, 'GCG_CTG': 0.30,
      'CCG_CCG': -0.46, 'CGA_CGA': -0.63, 'CTA_CTA': -0.59, 'AGG_AGG': -0.72, 'ATA_ATA': -0.66,
    },
    meanCpb: 0.084,
    stdCpb: 0.096,
    preferredPairs: ['CTG_CTG', 'GAA_GAA', 'AAA_AAA', 'ATG_GCG', 'GCG_CTG'],
    deoptimizedPairs: ['AGG_AGG', 'CGA_CGA', 'ATA_ATA', 'CTA_CTA', 'CCG_CCG'],
  },
  bacillus_subtilis: {
    key: 'bacillus_subtilis',
    name: 'Bacillus subtilis',
    taxonomyId: 1423,
    gcContent: 43.5,
    codonWeights: {
      TTT: 0.585, TTC: 1.000, TTA: 0.885, TTG: 0.425, CTT: 0.625, CTC: 0.285, CTA: 0.215, CTG: 0.485,
      ATT: 0.825, ATC: 1.000, ATA: 0.125, ATG: 1.000, GTT: 0.925, GTC: 0.425, GTA: 0.485, GTG: 0.425,
      TCT: 0.825, TCC: 0.585, TCA: 0.725, TCG: 0.285, AGT: 0.385, AGC: 0.485, CCT: 0.685, CCC: 0.185,
      CCA: 0.855, CCG: 0.485, ACT: 0.885, ACC: 0.625, ACA: 0.825, ACG: 0.325, GCT: 0.925, GCC: 0.425,
      GCA: 0.885, GCG: 0.485, TAT: 0.585, TAC: 1.000, TAA: 1.000, TAG: 0.085, CAT: 0.625, CAC: 1.000,
      CAA: 1.000, CAG: 0.485, TGA: 0.215, AAT: 0.625, AAC: 1.000, AAA: 1.000, AAG: 0.485, GAT: 0.725,
      GAC: 1.000, GAA: 1.000, GAG: 0.485, TGT: 0.625, TGC: 1.000, TGG: 1.000, CGT: 1.000, CGC: 0.825,
      CGA: 0.285, CGG: 0.185, AGA: 0.825, AGG: 0.285, GGT: 0.785, GGC: 1.000, GGA: 0.685, GGG: 0.245,
    },
    codonFrequencies: {
      AAA: 46.5, GAA: 44.2, GAT: 36.5, ATT: 38.2, GCT: 32.5, ATC: 29.8, GTT: 28.5, TTT: 27.5,
      AAC: 26.2, GGC: 27.5, CGT: 22.5, ACT: 21.8, CAA: 29.5, TTA: 25.8, CCA: 19.5, ATG: 26.2,
    },
    cpsScores: {
      'AAA_AAA': 0.38, 'GAA_GAA': 0.36, 'ATT_AAA': 0.30, 'GCT_AAA': 0.28, 'GAT_GAA': 0.27,
      'ATA_ATA': -0.65, 'CGA_CGA': -0.58, 'CTA_CTA': -0.55, 'CGG_CGG': -0.62, 'CCG_CCG': -0.48,
    },
    meanCpb: 0.078,
    stdCpb: 0.092,
    preferredPairs: ['AAA_AAA', 'GAA_GAA', 'ATT_AAA', 'GCT_AAA', 'GAT_GAA'],
    deoptimizedPairs: ['ATA_ATA', 'CGG_CGG', 'CGA_CGA', 'CTA_CTA', 'CCG_CCG'],
  },
  acinetobacter_baumannii: {
    key: 'acinetobacter_baumannii',
    name: 'Acinetobacter baumannii',
    taxonomyId: 470,
    gcContent: 39.1,
    codonWeights: {
      TTT: 0.825, TTC: 1.000, TTA: 0.925, TTG: 0.455, CTT: 0.525, CTC: 0.185, CTA: 0.185, CTG: 0.245,
      ATT: 1.000, ATC: 0.585, ATA: 0.145, ATG: 1.000, GTT: 1.000, GTC: 0.285, GTA: 0.525, GTG: 0.385,
      TCT: 0.885, TCC: 0.385, TCA: 0.825, TCG: 0.185, AGT: 0.485, AGC: 0.325, CCT: 0.785, CCC: 0.145,
      CCA: 0.925, CCG: 0.245, ACT: 0.925, ACC: 0.425, ACA: 0.885, ACG: 0.185, GCT: 1.000, GCC: 0.285,
      GCA: 0.785, GCG: 0.185, TAT: 0.825, TAC: 1.000, TAA: 1.000, TAG: 0.095, CAT: 0.825, CAC: 1.000,
      CAA: 1.000, CAG: 0.385, TGA: 0.165, AAT: 0.825, AAC: 1.000, AAA: 1.000, AAG: 0.425, GAT: 0.885,
      GAC: 1.000, GAA: 1.000, GAG: 0.385, TGT: 0.785, TGC: 1.000, TGG: 1.000, CGT: 1.000, CGC: 0.525,
      CGA: 0.185, CGG: 0.085, AGA: 0.625, AGG: 0.185, GGT: 0.925, GGC: 0.625, GGA: 0.525, GGG: 0.185,
    },
    codonFrequencies: {
      AAA: 52.4, GAA: 45.8, ATT: 44.5, TTT: 38.5, GAT: 38.2, GTT: 34.2, GCT: 31.5, TTA: 32.5,
      CAA: 32.8, AAT: 35.5, AAC: 28.5, ATC: 26.2, ACA: 24.5, GGT: 28.2, CGT: 23.5, ATG: 26.8,
    },
    cpsScores: {
      'AAA_AAA': 0.42, 'GAA_GAA': 0.38, 'ATT_AAA': 0.32, 'GTT_AAA': 0.29, 'TTT_ATT': 0.28,
      'CGG_CGG': -0.68, 'CCG_CCG': -0.60, 'GCG_GCG': -0.58, 'CGC_CGC': -0.52, 'CTC_CTC': -0.50,
    },
    meanCpb: 0.080,
    stdCpb: 0.093,
    preferredPairs: ['AAA_AAA', 'GAA_GAA', 'ATT_AAA', 'GTT_AAA', 'TTT_ATT'],
    deoptimizedPairs: ['CGG_CGG', 'CCG_CCG', 'GCG_GCG', 'CGC_CGC', 'CTC_CTC'],
  },
  klebsiella_pneumoniae: {
    key: 'klebsiella_pneumoniae',
    name: 'Klebsiella pneumoniae',
    taxonomyId: 573,
    gcContent: 57.5,
    codonWeights: {
      TTT: 0.245, TTC: 1.000, TTA: 0.095, TTG: 0.125, CTT: 0.085, CTC: 0.185, CTA: 0.028, CTG: 1.000,
      ATT: 0.285, ATC: 1.000, ATA: 0.003, ATG: 1.000, GTT: 0.385, GTC: 0.325, GTA: 0.125, GTG: 1.000,
      TCT: 0.685, TCC: 0.785, TCA: 0.065, TCG: 0.125, AGT: 0.075, AGC: 0.485, CCT: 0.105, CCC: 0.025,
      CCA: 0.125, CCG: 1.000, ACT: 0.885, ACC: 1.000, ACA: 0.065, ACG: 0.185, GCT: 0.385, GCC: 0.385,
      GCA: 0.525, GCG: 1.000, TAT: 0.215, TAC: 1.000, TAA: 1.000, TAG: 0.002, CAT: 0.245, CAC: 1.000,
      CAA: 0.115, CAG: 1.000, TGA: 0.095, AAT: 0.045, AAC: 1.000, AAA: 1.000, AAG: 0.295, GAT: 0.395,
      GAC: 1.000, GAA: 1.000, GAG: 0.315, TGT: 0.425, TGC: 1.000, TGG: 1.000, CGT: 1.000, CGC: 0.985,
      CGA: 0.005, CGG: 0.006, AGA: 0.003, AGG: 0.002, GGT: 0.525, GGC: 1.000, GGA: 0.001, GGG: 0.018,
    },
    codonFrequencies: {
      CTG: 56.2, GAA: 38.5, GCG: 36.8, GAC: 35.2, AAA: 32.5, GGC: 32.8, ACC: 25.5, ATG: 28.5,
      ATC: 26.8, CAG: 31.5, GTG: 28.5, CGC: 24.5, CGT: 20.8, TTC: 18.5, CCG: 22.5, GTC: 16.8,
    },
    cpsScores: {
      'CTG_CTG': 0.41, 'GAA_GAA': 0.40, 'AAA_AAA': 0.34, 'GCG_CTG': 0.32, 'ATG_GCG': 0.31,
      'AGG_AGG': -0.74, 'CGA_CGA': -0.65, 'ATA_ATA': -0.68, 'CTA_CTA': -0.62, 'CCG_CCG': -0.42,
    },
    meanCpb: 0.086,
    stdCpb: 0.098,
    preferredPairs: ['CTG_CTG', 'GAA_GAA', 'AAA_AAA', 'GCG_CTG', 'ATG_GCG'],
    deoptimizedPairs: ['AGG_AGG', 'CGA_CGA', 'ATA_ATA', 'CTA_CTA', 'CCG_CCG'],
  },
};

export const HOST_REFERENCE_PROFILES = CANDIDATE_HOST_PROFILES;

/**
 * Classify gene into canonical functional modules
 */
export function classifyFunctionalModule(
  name: string | null,
  product: string | null
): FunctionalModuleType {
  const combined = `${name ?? ''} ${product ?? ''}`.toLowerCase();

  // 1. AMG / Auxiliary metabolic module (prioritized before general enzymes)
  if (/\b(psba|psbd|nrda|nrdb|thya|dut|phoh|mazg|photosystem|metabolic|auxiliary)\b/i.test(combined)) {
    return 'amg_auxiliary';
  }

  // 2. Structural module
  if (
    /\b(capsid|coat|head|tail|fiber|spike|baseplate|sheath|tube|collar|portal|neck|scaffold|structural|major.*protein|minor.*protein)\b/i.test(
      combined
    )
  ) {
    return 'structural';
  }

  // 3. Replication / Transcription module
  if (
    /\b(polymerase|helicase|primase|ligase|topoisomerase|nuclease|ssb|single-stranded|dna.*binding|kinase|reductase|clamp)\b/i.test(
      combined
    )
  ) {
    return 'replication';
  }

  // 4. Lysis module
  if (/\b(lysin|endolysin|holin|antiholin|spanin|lysozyme|muramidase|lysis)\b/i.test(combined)) {
    return 'lysis';
  }

  // 5. Packaging & Regulatory module
  if (
    /\b(terminase|repressor|cro|antiterminator|regulator|transcription.*factor|integrase|recombinase|excisionase)\b/i.test(
      combined
    )
  ) {
    return 'packaging_regulatory';
  }

  return 'unclassified';
}

/**
 * Calculate Codon Adaptation Index (CAI) for a sequence or codon frequency table
 * Sharp & Li (1987)
 */
export function calculateCAI(
  sequenceOrCounts: string | Record<string, number>,
  host: HostProfile
): number {
  let codonCounts: Record<string, number>;

  if (typeof sequenceOrCounts === 'string') {
    codonCounts = countCodonUsage(sequenceOrCounts, 0);
  } else {
    codonCounts = sequenceOrCounts;
  }

  let logSum = 0;
  let totalSenseCodons = 0;

  for (const [codon, count] of Object.entries(codonCounts)) {
    if (count <= 0) continue;
    const upperCodon = codon.toUpperCase();
    const aa = CODON_TABLE[upperCodon];
    if (!aa || aa === '*') continue; // Skip stop codons or invalid

    const weight = host.codonWeights[upperCodon] ?? 0.01;
    // Floor at 0.01 to avoid -infinity
    const clampedWeight = Math.max(0.01, Math.min(1.0, weight));
    logSum += count * Math.log(clampedWeight);
    totalSenseCodons += count;
  }

  if (totalSenseCodons === 0) return 0;
  return Math.round(Math.exp(logSum / totalSenseCodons) * 1000) / 1000;
}

/**
 * Calculate Codon-Pair Bias (CPB) and Z-score for a coding sequence
 * Coleman et al. (2008), Mueller et al. (2010)
 */
export function calculateGeneCPB(
  codingSequence: string,
  host: HostProfile
): {
  cpb: number;
  zScore: number;
  pairCount: number;
  preferredPairs: number;
  deoptimizedPairs: number;
} {
  const upperSeq = codingSequence.toUpperCase();
  if (upperSeq.length < 6) {
    return {
      cpb: 0,
      zScore: 0,
      pairCount: 0,
      preferredPairs: 0,
      deoptimizedPairs: 0,
    };
  }

  let totalCps = 0;
  let pairCount = 0;
  let preferredPairs = 0;
  let deoptimizedPairs = 0;

  for (let i = 0; i + 6 <= upperSeq.length; i += 3) {
    const c1 = upperSeq.substring(i, i + 3);
    const c2 = upperSeq.substring(i + 3, i + 6);

    const aa1 = CODON_TABLE[c1];
    const aa2 = CODON_TABLE[c2];
    if (!aa1 || aa1 === '*' || !aa2 || aa2 === '*') continue;

    const pairKey = `${c1}_${c2}`;
    let cps = host.cpsScores[pairKey];

    if (cps === undefined) {
      // Analytical model based on host codon weights product vs expected mean
      const w1 = host.codonWeights[c1] ?? 0.5;
      const w2 = host.codonWeights[c2] ?? 0.5;
      const expectedPairWeight = w1 * w2;
      cps = Math.log(Math.max(0.05, expectedPairWeight) / 0.25) * 0.4;
    }

    totalCps += cps;
    pairCount++;

    if (cps > 0.2) preferredPairs++;
    if (cps < -0.2) deoptimizedPairs++;
  }

  if (pairCount === 0) {
    return {
      cpb: 0,
      zScore: 0,
      pairCount: 0,
      preferredPairs: 0,
      deoptimizedPairs: 0,
    };
  }

  const cpb = Math.round((totalCps / pairCount) * 1000) / 1000;
  const zScore = Math.round(((cpb - host.meanCpb) / host.stdCpb) * 100) / 100;

  return {
    cpb,
    zScore,
    pairCount,
    preferredPairs,
    deoptimizedPairs,
  };
}

/**
 * Match a host name string to the closest reference host profile
 */
export function matchHostProfile(hostName?: string | null): HostProfile {
  if (!hostName) return CANDIDATE_HOST_PROFILES.escherichia_coli;
  const lower = hostName.toLowerCase();

  if (lower.includes('pseudomonas')) return CANDIDATE_HOST_PROFILES.pseudomonas_aeruginosa;
  if (lower.includes('staphylococcus')) return CANDIDATE_HOST_PROFILES.staphylococcus_aureus;
  if (lower.includes('salmonella')) return CANDIDATE_HOST_PROFILES.salmonella_enterica;
  if (lower.includes('mycobacterium')) return CANDIDATE_HOST_PROFILES.mycobacterium_tuberculosis;
  if (lower.includes('bacillus')) return CANDIDATE_HOST_PROFILES.bacillus_subtilis;
  if (lower.includes('acinetobacter')) return CANDIDATE_HOST_PROFILES.acinetobacter_baumannii;
  if (lower.includes('klebsiella')) return CANDIDATE_HOST_PROFILES.klebsiella_pneumoniae;

  return CANDIDATE_HOST_PROFILES.escherichia_coli;
}

/**
 * Extract spliced in-frame coding sequence for a gene
 */
export function extractGeneSequence(
  gene: GeneInfo,
  genomeSequence?: string | null
): string {
  if (!genomeSequence || genomeSequence.length === 0) {
    return '';
  }
  if (gene.qualifiers?.transl_table && !['1', '11'].includes(String(gene.qualifiers.transl_table))) return '';

  const segments = getGeneMapSegments(gene);
  const rawSegments = gene.qualifiers?._segments;
  if (Array.isArray(rawSegments) && rawSegments.length !== segments.length) return '';
  if (segments.length === 0 || segments.some(segment => !Number.isSafeInteger(segment.start) || !Number.isSafeInteger(segment.end) ||
    segment.start < 0 || segment.end > genomeSequence.length || segment.start >= segment.end ||
    segment.strand !== '+' && segment.strand !== '-')) return '';
  const sub = segments.map(segment => {
    const part = genomeSequence.slice(segment.start, segment.end);
    return segment.strand === '-' ? reverseComplement(part) : part;
  }).join('');
  const codonStart = Number(gene.qualifiers?.codon_start ?? 1);
  if (![1, 2, 3].includes(codonStart)) return '';
  return sub.slice(codonStart - 1);
}

/**
 * Analyze codon and codon-pair adaptation across all genes in a phage genome
 */
export function analyzePhageHostCodonAdaptation(
  phage: PhageFull,
  options: {
    genomeSequence?: string | null;
    candidateHosts?: HostProfile[];
    primaryHostName?: string | null;
  } = {}
): PhageHostAdaptationResult {
  const hosts =
    options.candidateHosts && options.candidateHosts.length > 0
      ? options.candidateHosts
      : Object.values(CANDIDATE_HOST_PROFILES);

  const primaryHost = matchHostProfile(options.primaryHostName ?? phage.host);
  const genes = phage.genes ?? [];
  const seq = options.genomeSequence ?? '';

  const geneAdaptations: GeneCodonAdaptation[] = [];

  for (const g of genes) {
    // Only analyze CDS features
    if (g.type && g.type !== 'CDS') continue;

    const codingSeq = extractGeneSequence(g, seq);
    const counts = countCodonUsage(codingSeq);
    const senseCodonCount = Object.entries(counts).reduce((sum, [codon, count]) =>
      sum + (CODON_TABLE[codon] && CODON_TABLE[codon] !== '*' ? count : 0), 0);
    // This combined lens requires a valid adjacent pair for both CAI and CPB.
    if (senseCodonCount === 0 || calculateGeneCPB(codingSeq, primaryHost).pairCount === 0) continue;
    const mod = classifyFunctionalModule(g.name, g.product);

    const caiMap: Record<string, number> = {};
    const cpbMap: Record<string, number> = {};
    const zMap: Record<string, number> = {};

    let bestHost = primaryHost.key;
    let maxCai = -1;

    for (const h of hosts) {
      const caiVal = calculateCAI(counts, h);
      const cpbStats = calculateGeneCPB(codingSeq, h);
      const cpbVal = cpbStats.cpb;
      const zVal = cpbStats.zScore;

      caiMap[h.key] = caiVal;
      cpbMap[h.key] = cpbVal;
      zMap[h.key] = zVal;

      if (caiVal > maxCai) {
        maxCai = caiVal;
        bestHost = h.key;
      }
    }

    const primaryCai = caiMap[primaryHost.key] ?? 0.5;
    const primaryCpb = cpbMap[primaryHost.key] ?? 0.0;
    const primaryZ = zMap[primaryHost.key] ?? 0.0;

    // Check for host-switch footprint
    let hostSwitchFootprint: GeneCodonAdaptation['hostSwitchFootprint'];
    let largestDelta = 0;

    for (const h of hosts) {
      if (h.key === primaryHost.key) continue;
      const deltaCai = (caiMap[h.key] ?? 0) - primaryCai;
      const deltaCpb = (cpbMap[h.key] ?? 0) - primaryCpb;

      if (deltaCai > 0.12 && deltaCai > largestDelta) {
        largestDelta = deltaCai;
        hostSwitchFootprint = {
          candidateHost: h.name,
          caiDelta: Math.round(deltaCai * 1000) / 1000,
          cpbDelta: Math.round(deltaCpb * 1000) / 1000,
          significance: deltaCai > 0.2 ? 'high' : 'moderate',
        };
      }
    }

    geneAdaptations.push({
      geneId: g.id,
      name: g.name ?? g.locusTag ?? `gene_${g.id}`,
      locusTag: g.locusTag ?? `gene_${g.id}`,
      startPos: g.startPos,
      endPos: g.endPos,
      strand: g.strand ?? '+',
      product: g.product ?? 'hypothetical protein',
      module: mod,
      codonCount: senseCodonCount,
      cai: caiMap,
      cpb: cpbMap,
      zScore: zMap,
      bestHost,
      primaryHostCai: primaryCai,
      primaryHostCpb: primaryCpb,
      primaryHostZScore: primaryZ,
      hostSwitchFootprint,
    });
  }

  // Module aggregation
  const moduleNames: Record<FunctionalModuleType, string> = {
    structural: 'Structural / Virion Architecture',
    replication: 'Replication & Transcription Engine',
    lysis: 'Host Lysis Timing & Burst',
    packaging_regulatory: 'Genome Packaging & Circuit Regulation',
    amg_auxiliary: 'Auxiliary Metabolic Genes (AMGs)',
    unclassified: 'Unclassified / Hypothetical',
  };

  const moduleGroups: Record<FunctionalModuleType, GeneCodonAdaptation[]> = {
    structural: [],
    replication: [],
    lysis: [],
    packaging_regulatory: [],
    amg_auxiliary: [],
    unclassified: [],
  };

  for (const ga of geneAdaptations) {
    moduleGroups[ga.module].push(ga);
  }

  const moduleSummaries: ModuleAdaptationSummary[] = (
    Object.keys(moduleGroups) as FunctionalModuleType[]
  )
    .filter((mod) => moduleGroups[mod].length > 0)
    .map((mod) => {
      const gList = moduleGroups[mod];
      const meanCai =
        gList.reduce((sum, g) => sum + g.primaryHostCai, 0) / (gList.length || 1);
      const meanCpb =
        gList.reduce((sum, g) => sum + g.primaryHostCpb, 0) / (gList.length || 1);
      const meanZ =
        gList.reduce((sum, g) => sum + g.primaryHostZScore, 0) / (gList.length || 1);

      let adaptationStatus: 'adapted' | 'transitional' | 'mismatched_acquisition' =
        'transitional';
      if (meanZ >= 0.5 && meanCai >= 0.65) {
        adaptationStatus = 'adapted';
      } else if (meanZ < -1.0) {
        adaptationStatus = 'mismatched_acquisition';
      }

      return {
        module: mod,
        displayName: moduleNames[mod],
        geneCount: gList.length,
        meanCai: Math.round(meanCai * 1000) / 1000,
        meanCpb: Math.round(meanCpb * 1000) / 1000,
        meanZScore: Math.round(meanZ * 100) / 100,
        adaptationStatus,
      };
    });

  // Host rankings across the entire phage genome
  const hostRankings: HostCompatibilityRank[] = (geneAdaptations.length > 0 ? hosts : []).map((h) => {
    const avgCai =
      geneAdaptations.reduce((sum, g) => sum + (g.cai[h.key] ?? 0), 0) /
      (geneAdaptations.length || 1);
    const avgCpb =
      geneAdaptations.reduce((sum, g) => sum + (g.cpb[h.key] ?? 0), 0) /
      (geneAdaptations.length || 1);
    const avgZ =
      geneAdaptations.reduce((sum, g) => sum + (g.zScore[h.key] ?? 0), 0) /
      (geneAdaptations.length || 1);

    // Score combines CAI and normalized Z-score
    const normalizedZ = Math.max(0, Math.min(1, (avgZ + 2.5) / 5.0));
    const overallComp = Math.round((avgCai * 0.65 + normalizedZ * 0.35) * 1000) / 10;

    return {
      hostKey: h.key,
      hostName: h.name,
      meanCai: Math.round(avgCai * 1000) / 1000,
      meanCpb: Math.round(avgCpb * 1000) / 1000,
      meanZScore: Math.round(avgZ * 100) / 100,
      overallCompatibility: overallComp,
      isPrimaryHost: h.key === primaryHost.key,
    };
  });

  hostRankings.sort((a, b) => b.overallCompatibility - a.overallCompatibility);

  const hostSwitchCandidates = geneAdaptations.filter((g) => g.hostSwitchFootprint);

  const topHost = hostRankings[0]?.hostName ?? primaryHost.name;
  const summary = geneAdaptations.length > 0
    ? `Evaluated ${geneAdaptations.length} genes against ${hosts.length} built-in host weight profiles. Highest model score: ${topHost}. These illustrative scores do not predict infection or establish host switching.`
    : 'No annotated coding sequence with a complete unambiguous sense-codon pair is available. No host scores were inferred.';

  return {
    phageId: phage.id,
    phageName: phage.name,
    primaryHost: primaryHost.name,
    genes: geneAdaptations,
    modules: moduleSummaries,
    hostRankings,
    hostSwitchCandidates,
    summary,
  };
}

/** Preserve the actual CDS inputs and distinguish counted codons from host-model scores. */
export async function createCodonAdaptationRecord(phage: PhageFull, genomeSequence: string,
  analysis: PhageHostAdaptationResult): Promise<AnalysisRecord> {
  if (analysis.phageId !== phage.id) throw new Error('Codon analysis belongs to a different genome.');
  const codingGenes = phage.genes.filter(gene => !gene.type || gene.type === 'CDS');
  const annotationsById = new Map(codingGenes.map(gene => [gene.id, gene]));
  const codingSequences = analysis.genes.map(gene => {
    const annotation = annotationsById.get(gene.geneId);
    if (!annotation) throw new Error('Codon analysis refers to a missing coding annotation.');
    return { geneId: gene.geneId, codonCount: gene.codonCount, sequence: extractGeneSequence(annotation, genomeSequence) };
  });
  const coverage = { available: analysis.genes.length, total: codingGenes.length, unit: 'genes' as const };
  const assumptions = ['Built-in illustrative host weights and pair-score distributions; unspecified pairs use a weight-product approximation.',
    'CAI is a rounded geometric mean with a 0.01 weight floor; combined host scores and divergence labels use fixed heuristic thresholds.'];
  const limitations = ['These scores are not infection probabilities, experimentally calibrated host ranges or evidence of host switching.',
    'This combined lens excludes CDS without an unambiguous adjacent sense-codon pair. Missing annotations or sequence do not imply biological absence.'];
  const modelField = (label: string, value: unknown) => analysis.genes.length > 0
    ? { label, kind: 'demo' as const, value: analysisJson(value), units: 'records' as const, coverage, assumptions, limitations }
    : { label, kind: 'unavailable' as const, value: null, units: null, coverage, limitations,
        missingInputs: ['Annotated coding sequence containing an unambiguous adjacent sense-codon pair.'] };
  return createAnalysisRecord({ method: { id: 'codon-adaptation-lens', version: '2', implementation: 'JavaScript coding-sequence statistics and illustrative host model' },
    inputs: [
      { id: 'sequence', accession: phage.accession, source: phage.localGenome ? 'local' : 'catalog', description: 'Exact genome sequence used for CDS extraction.', data: genomeSequence },
      { id: 'annotations', accession: phage.accession, source: phage.localGenome ? 'local' : 'catalog', description: 'CDS coordinates, strand, joined segments, reading-frame qualifier and functional labels.',
        data: analysisJson({ host: phage.host, genes: codingGenes }) },
      { id: 'host-profiles', accession: null, source: 'demo', description: 'Exact built-in model weights and score distributions; no reference corpus is supplied.', data: analysisJson(CANDIDATE_HOST_PROFILES) },
    ], parameters: { primaryHost: analysis.primaryHost, codonStart: 'GenBank codon_start, default 1', ambiguityPolicy: 'Preserve positions; skip unknown triplets and pairs' },
    seed: null, references: [{ id: 'standard-genetic-code', version: '1', description: 'Standard DNA codon meanings (tables 1 and 11); CDS with other declared translation tables are excluded.' }],
    fields: {
      codingSequences: { label: 'Consumed coding sequences and sense-codon counts', kind: 'sequence-score', units: 'records', coverage,
        limitations: ['Transcript-order joined segments, per-segment reverse complement and codon_start are applied. Only analyzed CDS are listed.'],
        value: analysisJson(codingSequences) },
      geneScores: modelField('Per-gene host-model scores', analysis.genes),
      hostRankings: modelField('Host-model rankings', analysis.hostRankings),
      modules: modelField('Functional module model summaries', analysis.modules),
    },
  });
}
