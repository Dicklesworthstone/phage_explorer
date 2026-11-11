import { parentPort } from 'node:worker_threads';
import { executeMosaicJob,type MosaicJob,type MosaicJobMessage } from '../commands/mosaic';
if(parentPort){const port=parentPort;port.on('message',(job:MosaicJob)=>{void executeMosaicJob(job,message=>port.postMessage({kind:'progress',message} satisfies MosaicJobMessage)).then(result=>port.postMessage({kind:'result',result} satisfies MosaicJobMessage)).catch(cause=>port.postMessage({kind:'error',message:cause instanceof Error?cause.message:String(cause)} satisfies MosaicJobMessage));});}
