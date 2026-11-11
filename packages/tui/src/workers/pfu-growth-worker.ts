import { parentPort } from 'node:worker_threads';
import { executePfuGrowthJob, type PfuGrowthJob, type PfuGrowthJobMessage } from '../commands/pfu-growth';
if(parentPort){
  const port=parentPort;
  port.on('message',(job:PfuGrowthJob)=>{
    void executePfuGrowthJob(job,message=>port.postMessage({kind:'progress',message} satisfies PfuGrowthJobMessage))
      .then(result=>port.postMessage({kind:'result',result} satisfies PfuGrowthJobMessage))
      .catch(cause=>port.postMessage({kind:'error',message:cause instanceof Error?cause.message:String(cause)} satisfies PfuGrowthJobMessage));
  });
}
