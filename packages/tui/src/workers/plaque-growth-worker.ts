import { parentPort } from 'node:worker_threads';
import { executePlaqueGrowthJob,type PlaqueGrowthJob,type PlaqueGrowthJobMessage } from '../commands/plaque-growth';
if(parentPort){
  const port=parentPort;
  port.on('message',(job:PlaqueGrowthJob)=>{
    void executePlaqueGrowthJob(job,message=>port.postMessage({kind:'progress',message} satisfies PlaqueGrowthJobMessage))
      .then(result=>port.postMessage({kind:'result',result} satisfies PlaqueGrowthJobMessage))
      .catch(cause=>port.postMessage({kind:'error',message:cause instanceof Error?cause.message:String(cause)} satisfies PlaqueGrowthJobMessage));
  });
}
