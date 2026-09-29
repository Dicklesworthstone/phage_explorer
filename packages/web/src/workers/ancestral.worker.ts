import { executeAncestralRequest, type AncestralRequest, type AncestralMessage } from './AncestralSession';
self.onmessage = (event:MessageEvent<AncestralRequest>) => {
  const send=(message:AncestralMessage)=>self.postMessage(message);
  void executeAncestralRequest(event.data,phase=>send({kind:'progress',phase})).then(
    value=>send({kind:'result',value}),
    cause=>send({kind:'error',message:cause instanceof Error?cause.message:String(cause)}),
  );
};
