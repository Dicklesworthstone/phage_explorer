import { parentPort } from 'node:worker_threads';
import { executeAncestralJob,type AncestralJob,type AncestralJobMessage } from '../commands/ancestral';
if(parentPort){const port=parentPort;port.on('message',(job:AncestralJob)=>{void executeAncestralJob(job,message=>port.postMessage({kind:'progress',message} satisfies AncestralJobMessage))
 .then(result=>port.postMessage({kind:'result',result} satisfies AncestralJobMessage))
 .catch(cause=>port.postMessage({kind:'error',message:cause instanceof Error?cause.message:String(cause)} satisfies AncestralJobMessage));});}
