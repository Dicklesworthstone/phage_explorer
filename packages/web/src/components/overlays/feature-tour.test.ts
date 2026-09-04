import { describe, expect, it } from 'bun:test';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { ActionIds, ActionRegistry } from '../../keyboard';

describe('FeatureTour Overlay Reachability (phage_explorer-9vk4.1)', () => {
  it('registers ActionIds.EducationStartTour in ActionRegistry pointing to tour overlay', () => {
    const action = ActionRegistry[ActionIds.EducationStartTour];
    expect(action).toBeDefined();
    expect(action.title).toBe('Take feature tour');
    expect(action.category).toBe('Education');
    expect(action.overlayId).toBe('tour');
    expect(action.overlayAction).toBe('open');
  });

  it('OverlayManager mounts FeatureTour and handles tour in render paths', () => {
    const overlayManagerPath = resolve(__dirname, 'OverlayManager.tsx');
    const source = readFileSync(overlayManagerPath, 'utf8');

    // FeatureTour must be imported
    expect(source).toContain("import { FeatureTour } from './FeatureTour';");

    // Must be mounted in EagerOverlayBoundary or handled in renderLazyOverlay
    expect(source).toContain('<EagerOverlayBoundary id="tour"><FeatureTour /></EagerOverlayBoundary>');
    expect(source).toContain("case 'tour':");
  });

  it('WelcomeModal triggers tour overlay on Take Tour', () => {
    const welcomePath = resolve(__dirname, 'WelcomeModal.tsx');
    const source = readFileSync(welcomePath, 'utf8');

    expect(source).toContain("open('tour')");
  });

  it('CommandPalette triggers tour overlay when user selects start-welcome-tour', () => {
    const cmdPath = resolve(__dirname, 'CommandPalette.tsx');
    const source = readFileSync(cmdPath, 'utf8');

    expect(source).toContain("open('tour')");
  });

  it('FeatureTour updates state and completes tour on finish or skip', () => {
    const tourPath = resolve(__dirname, 'FeatureTour.tsx');
    const source = readFileSync(tourPath, 'utf8');

    expect(source).toContain("completeTour('welcome')");
    expect(source).toContain("close('tour')");
  });
});
