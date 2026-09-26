/** Simulation calculations run off the main thread; checkpoints are worker-independent. */
import * as Comlink from 'comlink';
import { getAllSimulations } from '@phage-explorer/core';
import { createSimulationAPI } from './simulation-runtime';

Comlink.expose(createSimulationAPI(getAllSimulations()));
