import { executeRegionComparisonRequest, type RegionComparisonMessage, type RegionComparisonRequest } from './RegionComparisonSession';

self.onmessage = async (event: MessageEvent<RegionComparisonRequest>) => {
  const send = (message: RegionComparisonMessage) => self.postMessage(message);
  try {
    const value = await executeRegionComparisonRequest(event.data, phase => send({ kind: 'progress', phase }));
    send({ kind: 'result', value });
  } catch (cause) {
    send({ kind: 'error', message: cause instanceof Error ? cause.message : 'Region comparison failed.' });
  }
};
