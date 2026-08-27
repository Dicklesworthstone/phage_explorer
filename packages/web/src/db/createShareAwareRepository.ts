import type { PhageSummary } from '@phage-explorer/core';
import type { PhageRepository } from './types';
import { findPhageIndex } from '../utils/share-state';

interface RepositoryViewSnapshot {
  phages: PhageSummary[];
  viewToBaseIndex: number[];
}

function buildSnapshot(phages: PhageSummary[], requestedPhageKey: string): RepositoryViewSnapshot {
  const requestedIndex = findPhageIndex(phages, requestedPhageKey);
  const identity = phages.map((_, index) => index);

  if (requestedIndex <= 0) {
    return {
      phages: phages.slice(),
      viewToBaseIndex: identity,
    };
  }

  const viewToBaseIndex = [
    ...identity.slice(requestedIndex),
    ...identity.slice(0, requestedIndex),
  ];

  return {
    phages: viewToBaseIndex.map((index) => phages[index]),
    viewToBaseIndex,
  };
}

export function createShareAwareRepository(
  repository: PhageRepository,
  requestedPhageKey: string | null | undefined
): PhageRepository {
  const normalizedKey = requestedPhageKey?.trim() ?? '';
  if (!normalizedKey) return repository;

  let snapshot: RepositoryViewSnapshot | null = null;
  let snapshotPromise: Promise<RepositoryViewSnapshot> | null = null;

  const ensureSnapshot = async (): Promise<RepositoryViewSnapshot> => {
    if (snapshot) return snapshot;
    if (!snapshotPromise) {
      snapshotPromise = repository.listPhages()
        .then((phages) => buildSnapshot(phages, normalizedKey))
        .then((nextSnapshot) => {
          snapshot = nextSnapshot;
          return nextSnapshot;
        })
        .catch((error) => {
          snapshotPromise = null;
          throw error;
        });
    }
    return snapshotPromise;
  };

  return new Proxy(repository, {
    get(target, property, receiver) {
      if (property === 'listPhages') {
        return async (): Promise<PhageSummary[]> => {
          const current = await ensureSnapshot();
          return current.phages.slice();
        };
      }

      if (property === 'getPhageByIndex') {
        return async (index: number) => {
          if (!Number.isInteger(index)) return null;
          const current = await ensureSnapshot();
          const baseIndex = current.viewToBaseIndex[index];
          if (baseIndex === undefined) return null;
          return target.getPhageByIndex(baseIndex);
        };
      }

      if (property === 'prefetchAround') {
        return async (index: number, radius: number): Promise<void> => {
          if (!Number.isInteger(index)) return;
          const current = await ensureSnapshot();
          const count = current.viewToBaseIndex.length;
          if (count === 0 || index < 0 || index >= count) return;

          const safeRadius = Math.max(0, Math.floor(radius));
          const baseIndexes = new Set<number>();
          for (let offset = -safeRadius; offset <= safeRadius; offset += 1) {
            const viewIndex = (index + offset + count) % count;
            baseIndexes.add(current.viewToBaseIndex[viewIndex]);
          }

          await Promise.allSettled(
            Array.from(baseIndexes, async (baseIndex) => {
              await target.getPhageByIndex(baseIndex);
            })
          );
        };
      }

      const value = Reflect.get(target, property, receiver);
      return typeof value === 'function' ? value.bind(target) : value;
    },
  }) as PhageRepository;
}

export default createShareAwareRepository;
