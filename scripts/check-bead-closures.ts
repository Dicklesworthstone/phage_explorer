#!/usr/bin/env bun
/**
 * scripts/check-bead-closures.ts
 *
 * Enforces the Bead Closure Standard (see AGENTS.md):
 * Every bead that transitions to `closed` MUST have a non-empty `close_reason`.
 *
 * Checks:
 * 1. Newly closed beads relative to git baseline (HEAD by default, or specified base ref).
 * 2. Closed beads that previously had a close reason must not have their reason removed.
 *
 * Options:
 *   --staged      Check git staged changes instead of working tree
 *   --base <ref>  Compare against a specific git reference (e.g. origin/main, HEAD~1)
 *   --all         Validate all closed beads (fails if any closed bead lacks reason, excluding historical [WEB-P*])
 */

import { execSync } from 'node:child_process';
import * as fs from 'node:fs';
import * as path from 'node:path';

interface BeadIssue {
  id: string;
  title: string;
  status: string;
  close_reason?: string;
  closed_at?: string;
  labels?: string[];
}

function parseIssues(content: string): Map<string, BeadIssue> {
  const map = new Map<string, BeadIssue>();
  for (const line of content.split('\n')) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    try {
      const issue = JSON.parse(trimmed) as BeadIssue;
      if (issue.id) {
        map.set(issue.id, issue);
      }
    } catch {
      // Ignore malformed lines
    }
  }
  return map;
}

function getBaseContent(baseRef: string): string | null {
  try {
    return execSync(`git show ${baseRef}:.beads/issues.jsonl`, {
      stdio: ['pipe', 'pipe', 'ignore'],
      maxBuffer: 64 * 1024 * 1024,
    }).toString();
  } catch {
    return null;
  }
}

function getCurrentContent(staged: boolean): string | null {
  if (staged) {
    try {
      return execSync('git show :.beads/issues.jsonl', {
        stdio: ['pipe', 'pipe', 'ignore'],
        maxBuffer: 64 * 1024 * 1024,
      }).toString();
    } catch {
      return null;
    }
  }

  const filePath = path.resolve('.beads/issues.jsonl');
  if (!fs.existsSync(filePath)) return null;
  return fs.readFileSync(filePath, 'utf8');
}

function main() {
  const args = process.argv.slice(2);
  const isStaged = args.includes('--staged');
  const isAll = args.includes('--all');
  const baseIndex = args.indexOf('--base');
  const baseRef = baseIndex !== -1 && args[baseIndex + 1] ? args[baseIndex + 1] : 'HEAD';

  const currentContent = getCurrentContent(isStaged);
  if (!currentContent) {
    console.log('check-bead-closures: No .beads/issues.jsonl found or staged; skipping.');
    process.exit(0);
  }

  const currentIssues = parseIssues(currentContent);
  const violations: Array<{ id: string; title: string; issue: string }> = [];

  if (isAll) {
    for (const issue of currentIssues.values()) {
      if (issue.status === 'closed') {
        const hasReason = Boolean(issue.close_reason && issue.close_reason.trim().length > 0);
        const isUnverifiedPlan = issue.labels?.includes('unverified') || issue.labels?.includes('imported-plan');
        if (!hasReason && !isUnverifiedPlan) {
          violations.push({
            id: issue.id,
            title: issue.title,
            issue: 'Closed bead missing mandatory close reason.',
          });
        }
      }
    }
  } else {
    const baseContent = getBaseContent(baseRef);
    const baseIssues = baseContent ? parseIssues(baseContent) : new Map<string, BeadIssue>();

    for (const [id, current] of currentIssues.entries()) {
      const base = baseIssues.get(id);

      // Check if newly closed
      const isNowClosed = current.status === 'closed';
      const wasClosed = base?.status === 'closed';

      if (isNowClosed) {
        const hasReason = Boolean(current.close_reason && current.close_reason.trim().length > 0);

        if (!wasClosed) {
          // Newly transitioned to closed (or newly added directly as closed)
          if (!hasReason) {
            violations.push({
              id,
              title: current.title,
              issue: 'Transitioned to closed without a mandatory close reason.',
            });
          }
        } else if (base?.close_reason && base.close_reason.trim().length > 0 && !hasReason) {
          // Existing closed bead had its reason cleared
          violations.push({
            id,
            title: current.title,
            issue: 'Existing close reason was emptied or removed.',
          });
        }
      }
    }
  }

  if (violations.length > 0) {
    console.error(`\n❌ Bead Closure Standard Violation (${violations.length} issue(s)):`);
    console.error('Every bead closed must provide evidence of verification in its close reason.\n');
    for (const v of violations) {
      console.error(`  - ${v.id}: "${v.title}"`);
      console.error(`    Problem: ${v.issue}`);
      console.error(`    Fix: br close ${v.id} --reason "<evidence of verification>"\n`);
    }
    process.exit(1);
  }

  console.log('✓ Bead closure standard verified: all newly closed beads have mandatory close reasons.');
  process.exit(0);
}

main();
