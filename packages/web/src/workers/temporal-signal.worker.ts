import { executeTemporalRequest, type TemporalRequest, type TemporalMessage } from './TemporalSignalSession';
const scope=self as unknown as {onmessage:((event:MessageEvent<TemporalRequest>)=>void)|null;postMessage:(message:TemporalMessage)=>void};
scope.onmessage=event=>{
  void executeTemporalRequest(event.data,phase=>scope.postMessage({kind:'progress',phase}))
    .then(value=>scope.postMessage({kind:'result',value}))
    .catch(cause=>scope.postMessage({kind:'error',message:cause instanceof Error?cause.message:String(cause)}));
};
