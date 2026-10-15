#!/usr/bin/env bun
import { runPhylogenyCommand } from '../packages/tui/src/headless-phylogeny';

if (import.meta.main) {
  const controller = new AbortController();
  let exitCode = 1;
  const interrupt = () => { exitCode = 130; controller.abort(); };
  const terminate = () => { exitCode = 143; controller.abort(); };
  process.once('SIGINT', interrupt);
  process.once('SIGTERM', terminate);
  try {
    const result = await runPhylogenyCommand(process.argv.slice(2), controller.signal);
    console.log(typeof result === 'string' ? result : JSON.stringify(result, null, 2));
  } catch (error) {
    console.error(error instanceof Error ? error.message : String(error));
    process.exitCode = exitCode;
  } finally {
    process.removeListener('SIGINT', interrupt);
    process.removeListener('SIGTERM', terminate);
  }
}
