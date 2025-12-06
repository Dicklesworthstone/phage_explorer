#!/usr/bin/env bun

import React from 'react';
import { render } from 'ink';
import { App } from './components/App';
import { BunSqliteRepository } from '@phage-explorer/db-runtime';

const DB_PATH = './phage.db';

async function main() {
  // Check if database exists
  const dbFile = Bun.file(DB_PATH);
  if (!(await dbFile.exists())) {
    console.error(`Database not found: ${DB_PATH}`);
    console.error('Run "bun run build:db" to create the database first.');
    process.exit(1);
  }

  // Create repository
  const repository = new BunSqliteRepository(DB_PATH);

  // Render the TUI
  // patchConsole: false prevents Ink from intercepting console output which can cause flickering
  // We don't use console.log during normal operation anyway
  const { waitUntilExit } = render(
    <App repository={repository} />,
    {
      exitOnCtrlC: true,
      patchConsole: false,
    }
  );

  // Wait for exit
  await waitUntilExit();

  // Cleanup
  await repository.close();
}

main().catch(err => {
  console.error('Fatal error:', err);
  process.exit(1);
});
