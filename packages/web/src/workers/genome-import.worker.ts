import { importLocalGenomes, type GenomeInput } from '@phage-explorer/core';

self.onmessage = (event: MessageEvent<GenomeInput>) => {
  void importLocalGenomes(event.data, (completed, total) => self.postMessage({ type: 'progress', completed, total }))
    .then(result => self.postMessage({ type: 'result', result }))
    .catch((error: unknown) => self.postMessage({ type: 'error', message: error instanceof Error ? error.message : 'Genome import failed' }));
};
