import { executeSpacerRequest, type SpacerRequest, type SpacerMessage } from './SpacerReferenceSession';
const scope=self as unknown as {onmessage:((event:MessageEvent<SpacerRequest>)=>void)|null;postMessage:(message:SpacerMessage)=>void};
scope.onmessage=event=>{
  void executeSpacerRequest(event.data,phase=>scope.postMessage({kind:'progress',phase}))
    .then(value=>scope.postMessage({kind:'result',value}))
    .catch(cause=>scope.postMessage({kind:'error',message:cause instanceof Error?cause.message:String(cause)}));
};
