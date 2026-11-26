/** Standalone annotated CDS/proteome export without starting the terminal UI or catalog. */
import { runGenomeCdsProcess } from '../packages/tui/src/commands/genome-cds';

await runGenomeCdsProcess(process.argv.slice(2));
