import type { PhageFull } from '../types';

export interface StabilityInputs {
  genomeLength?: number | null;
  /** GC percentage (0–100), consistent with DB storage */
  gcContent?: number | null;
  morphology?: string | null;
  baltimoreGroup?: string | null;
  pdbIds?: string[];
}

export interface StabilityEnvironment {
  temperatureC: number; // Current handling temperature
  saltMilliMolar: number; // Approximate ionic strength in mM
}

export type StabilityStatus = 'robust' | 'moderate' | 'fragile';

export interface StabilityEstimate {
  baseIndex: number; // Intrinsic stability (capsid design, genome load)
  packagingPenalty: number; // Pressure from genome length
  temperatureFactor: number;
  saltFactor: number;
  integrity: number; // 0–1 combined estimate under current env
  meltingTempC: number;
  recommendedStorage: {
    temperatureC: number;
    saltMilliMolar: number;
  };
  status: StabilityStatus;
  warnings: string[];
  notes: string[];
}

const clamp01 = (v: number) => Math.max(0, Math.min(1, v));
const normalize = (v: number, min: number, max: number) => clamp01((v - min) / (max - min));

function morphologyBoost(morphology?: string | null): number {
  const m = morphology?.toLowerCase() ?? '';
  if (!m) return 0;
  if (m.includes('myovir') || m.includes('podovir')) return 0.06;
  if (m.includes('siphov')) return 0.04;
  if (m.includes('inovir') || m.includes('filament')) return -0.05;
  return 0;
}

function baltimoreBoost(group?: string | null): number {
  const g = (group ?? '').toUpperCase();
  if (g === 'I' || g === 'VII') return 0.05; // dsDNA / dsDNA-RT
  if (g === 'II' || g === 'V') return -0.05; // ssDNA / ssRNA
  if (g === 'III') return -0.03; // dsRNA often more fragile in handling
  return 0;
}

function packagingPenalty(genomeLength?: number | null): number {
  if (!genomeLength || genomeLength <= 0) return 0.05;
  const threshold = 65000;
  if (genomeLength <= threshold) return 0.05;
  const excess = genomeLength - threshold;
  const penalty = excess / 150000; // Rough scaling; cap below 0.35
  return Math.min(0.35, 0.05 + penalty);
}

function estimateMeltingTemp(gcContent?: number | null, baseIndex = 0.5): number {
  const gc = gcContent ?? 50;
  const gcNorm = normalize(gc, 35, 70);
  // Baseline 45–65°C depending on GC and intrinsic stability
  const baseTm = 45 + gcNorm * 15;
  const bonus = (baseIndex - 0.5) * 25;
  return Math.max(35, Math.min(85, baseTm + bonus));
}

function temperatureFactor(tempC: number, meltingTemp: number): number {
  if (tempC <= 4) return 1;
  if (tempC <= 25) {
    return clamp01(1 - (tempC - 4) * 0.012); // Gentle slope to room temp
  }
  if (tempC >= meltingTemp) return 0.1;
  const span = Math.max(1, meltingTemp - 25);
  const drop = (tempC - 25) / span;
  return clamp01(0.748 - drop * 0.65); // Falls toward ~0.1 near melting
}

function saltFactor(saltMilliMolar: number): number {
  const delta = Math.abs(saltMilliMolar - 100); // 100 mM sweet spot
  if (delta <= 50) return 1;
  if (delta <= 150) return clamp01(1 - delta / 300);
  return clamp01(0.55 - (delta - 150) / 500);
}

function statusFromIntegrity(integrity: number): StabilityStatus {
  if (integrity >= 0.75) return 'robust';
  if (integrity >= 0.5) return 'moderate';
  return 'fragile';
}

export function predictVirionStability(
  inputs: StabilityInputs,
  env: StabilityEnvironment
): StabilityEstimate {
  const gc = inputs.gcContent ?? 50;
  const gcNorm = normalize(gc, 35, 70);
  const morph = morphologyBoost(inputs.morphology);
  const baltimore = baltimoreBoost(inputs.baltimoreGroup);
  const packaging = packagingPenalty(inputs.genomeLength);

  const intrinsic = 0.53 + 0.32 * (gcNorm - 0.5) + morph + baltimore - packaging;
  const intrinsicClamped = clamp01(intrinsic);

  const meltingTemp = estimateMeltingTemp(gc, intrinsicClamped);
  const tempFactor = temperatureFactor(env.temperatureC, meltingTemp);
  const ionicFactor = saltFactor(env.saltMilliMolar);

  const integrity = clamp01(intrinsicClamped * tempFactor * ionicFactor);
  const status = statusFromIntegrity(integrity);

  const warnings: string[] = [];
  const notes: string[] = [];

  if (inputs.gcContent != null && inputs.gcContent < 42) warnings.push('Low GC content reduces thermal robustness.');
  if ((inputs.genomeLength ?? 0) > 120_000) warnings.push('Large genome increases capsid pressure; avoid high temp.');
  if (env.temperatureC > 37) warnings.push('Handling above 37°C risks premature capsid softening.');
  if (env.saltMilliMolar < 30) warnings.push('Very low salt can disrupt capsid charge shielding.');
  if (env.saltMilliMolar > 250) warnings.push('High salt may destabilize some tail fibers / baseplates.');
  if (!inputs.pdbIds || inputs.pdbIds.length === 0) {
    notes.push('No PDB models linked; stability estimate uses heuristics only.');
  }

  const recommendedStorage = {
    temperatureC: 4,
    saltMilliMolar: 100,
  };

  return {
    baseIndex: intrinsicClamped,
    packagingPenalty: packaging,
    temperatureFactor: tempFactor,
    saltFactor: ionicFactor,
    integrity,
    meltingTempC: Math.round(meltingTemp * 10) / 10,
    recommendedStorage,
    status,
    warnings,
    notes,
  };
}

export function predictVirionStabilityFromPhage(
  phage: PhageFull | null,
  env: StabilityEnvironment
): StabilityEstimate {
  return predictVirionStability(
    {
      genomeLength: phage?.genomeLength,
      gcContent: phage?.gcContent,
      morphology: phage?.morphology,
      baltimoreGroup: phage?.baltimoreGroup,
      pdbIds: phage?.pdbIds,
    },
    env
  );
}
