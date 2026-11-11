import { parentPort } from 'node:worker_threads';
import { executeProteinStructureJob, type ProteinStructureJob, type ProteinStructureJobMessage } from '../commands/protein-structure';

if (parentPort) {
  const port=parentPort;
  port.on('message',(job: ProteinStructureJob)=>{
    void executeProteinStructureJob(job,message=>port.postMessage({kind:'progress',message} satisfies ProteinStructureJobMessage))
      .then(result=>port.postMessage({kind:'result',result} satisfies ProteinStructureJobMessage))
      .catch(cause=>port.postMessage({kind:'error',message:cause instanceof Error?cause.message:String(cause)} satisfies ProteinStructureJobMessage));
  });
}
