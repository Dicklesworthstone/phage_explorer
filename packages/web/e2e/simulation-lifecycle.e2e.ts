import { test, expect } from '@playwright/test';
import { resolve } from 'node:path';
import { createServer as createViteServer, loadConfigFromFile, mergeConfig, type UserConfig, type InlineConfig } from 'vite';

let fixtureConfig: UserConfig | undefined;
test('seeded simulations survive worker replacement, reset, parameter edits and cancelled replies', async ({ page }, info) => {
  test.setTimeout(180000);
  const root = process.cwd();
  const fixtureId = resolve(root, 'src/simulation-lifecycle-fixture.tsx');
  if (!fixtureConfig) {
    const loaded = await loadConfigFromFile({ command: 'serve', mode: 'development' }, resolve(root, 'vite.config.ts'));
    if (!loaded) throw new Error('Could not load simulation fixture configuration');
    fixtureConfig = loaded.config;
  }
  const server = await createViteServer(mergeConfig(fixtureConfig, {
    root, cacheDir: info.outputPath('vite-cache'), configFile: false,
    server: { host: '127.0.0.1', port: 0, open: false },
    plugins: [{
      name: 'simulation-lifecycle-fixture',
      resolveId(id) { if (id === '/src/simulation-lifecycle-fixture.tsx') return fixtureId; },
      load(id) {
        if (id !== fixtureId) return;
        return `
          import React, { useEffect } from 'react';
          import { createRoot } from 'react-dom/client';
          import { usePhageStore } from '@phage-explorer/state';
          import { SIMULATION_METADATA } from '@phage-explorer/core';
          import SimulationView from './components/SimulationView';
          import { OverlayProvider, useOverlay } from './components/overlays/OverlayProvider';
          import { ToastProvider } from './components/ui/Toast';
          import { ScrollProvider } from './providers';
          import { getOrchestrator } from './workers/ComputeOrchestrator';
          import './styles/index.css';
          usePhageStore.setState({ currentPhage: null });
          // Exercise the actual model registry, Comlink transport and fresh workers.
          // No mock numeric result is used in these comparisons.
          window.checkSeededModels = async () => {
            const outcomes = [];
            for (const { id } of SIMULATION_METADATA) {
              let manager = getOrchestrator({ maxWorkers: 2 });
              const initial = await manager.initSimulation({ simId: id, seed: 42 });
              const batch = await manager.stepSimulationBatch(initial, 1, 2);
              manager.dispose();
              manager = getOrchestrator({ maxWorkers: 2 });
              await manager.initSimulation({ simId: id, seed: 999 });
              const first = await manager.stepSimulation(initial, 1);
              await manager.initSimulation({ simId: id, seed: 777 });
              const second = await manager.stepSimulation(first, 1);
              outcomes.push({ id, first: JSON.stringify(first) === JSON.stringify(batch[0]),
                second: JSON.stringify(second) === JSON.stringify(batch[1]),
                checkpoint: second.randomState.algorithm === 'lcg32-v1', seed: second.randomState.seed });
              manager.dispose();
            }
            return outcomes;
          };
          function Fixture() {
            const { open, close, setOverlayData } = useOverlay();
            useEffect(() => {
              window.openSimulation = () => {
                const service = getOrchestrator();
                const step = service.stepSimulation.bind(service);
                const init = service.initSimulation.bind(service);
                const hold = async (kind, result) => {
                  if (window.holdNextSimulationReply !== kind) return result;
                  window.holdNextSimulationReply = null;
                  window.simulationReplyReady = true;
                  await new Promise(resolve => { window.releaseSimulationReply = resolve; });
                  window.simulationReplyReleased = true;
                  return result;
                };
                service.stepSimulation = async (...args) => hold('step', await step(...args));
                service.initSimulation = async (...args) => hold('init', await init(...args));
                setOverlayData('simulationView.simId', 'plaque-automata');
                open('simulationView');
              };
              window.closeSimulation = () => close('simulationView');
            }, []);
            return <SimulationView />;
          }
          createRoot(document.getElementById('root')).render(
            <ScrollProvider><ToastProvider><OverlayProvider><Fixture /></OverlayProvider></ToastProvider></ScrollProvider>
          );
        `;
      },
      configureServer(vite) {
        vite.middlewares.use('/simulation-lifecycle-fixture', (_request, response, next) => {
          void vite.transformIndexHtml('/simulation-lifecycle-fixture', '<div id="root"></div><script type="module" src="/src/simulation-lifecycle-fixture.tsx"></script>')
            .then(html => { response.setHeader('Content-Type', 'text/html'); response.end(html); }).catch(next);
        });
      },
    }],
  } satisfies InlineConfig));
  const errors: string[] = [];
  page.on('pageerror', error => errors.push(error.message));
  try {
    await server.listen();
    await page.goto(`${server.resolvedUrls!.local[0]}simulation-lifecycle-fixture`);
    await expect.poll(() => page.evaluate(() => typeof (window as any).openSimulation)).toBe('function');
    const outcomes = await page.evaluate(() => (window as any).checkSeededModels());
    expect(outcomes).toHaveLength(7);
    for (const outcome of outcomes) expect(outcome, outcome.id).toMatchObject({ first: true, second: true, checkpoint: true, seed: 42 });

    await page.evaluate(() => (window as any).openSimulation());
    const overlay = page.getByTestId('overlay-simulationView');
    const snapshot = overlay.getByTestId('simulation-state');
    const state = async () => JSON.parse((await snapshot.textContent())!);
    await overlay.getByTitle('Pause (Space)', { exact: true }).click();
    await overlay.getByLabel('Simulation seed', { exact: true }).fill('0');
    await overlay.getByRole('button', { name: 'Apply seed & reset', exact: true }).click();
    await expect.poll(async () => { try { return (await state()).randomState.seed; } catch { return null; } }).toBe(0);
    await expect(overlay.getByTitle('Play (Space)', { exact: true })).toBeEnabled();
    const initial = await state();
    await overlay.getByTitle('Step Forward (.)', { exact: true }).click();
    await expect(overlay).toContainText('1 accepted steps');
    const first = await state();
    expect(first.randomState.cursor).not.toBe(initial.randomState.cursor);
    await overlay.getByTitle('Reset (R)', { exact: true }).click();
    await expect.poll(async () => { try { return await state(); } catch { return null; } }).toEqual(initial);
    await overlay.getByTitle('Step Forward (.)', { exact: true }).click();
    await expect.poll(async () => await state()).toEqual(first);

    // Grid size must rebuild both typed arrays, not merely relabel a later frame.
    const slider = overlay.locator('input[type=range]').first();
    await slider.focus();
    await slider.press('Home');
    await expect(slider).toHaveValue('10');
    await expect(overlay).toContainText('0 accepted steps');
    await expect(slider).toBeEnabled();
    const changed = await state();
    expect(changed.params).not.toEqual(first.params);
    expect(changed.gridSize).toBe(10);
    expect(Object.keys(changed.grid)).toHaveLength(100);
    expect(Object.keys(changed.infectionTimes)).toHaveLength(100);
    expect(changed.time).toBe(initial.time);

    const holdReply = async (kind: 'step' | 'init') => page.evaluate(kind => {
      (window as any).simulationReplyReady = false;
      (window as any).simulationReplyReleased = false;
      (window as any).holdNextSimulationReply = kind;
    }, kind);
    await holdReply('step');
    await overlay.getByTitle('Step Forward (.)', { exact: true }).click();
    await expect.poll(() => page.evaluate(() => (window as any).simulationReplyReady)).toBe(true);
    await overlay.getByRole('button', { name: 'Cancel simulation work', exact: true }).click();
    await page.evaluate(() => (window as any).releaseSimulationReply());
    await expect.poll(() => page.evaluate(() => (window as any).simulationReplyReleased)).toBe(true);
    expect(await state()).toEqual(changed);
    await expect(overlay).toContainText('0 accepted steps');

    await holdReply('init');
    await overlay.getByTitle('Reset (R)', { exact: true }).click();
    await expect.poll(() => page.evaluate(() => (window as any).simulationReplyReady)).toBe(true);
    await overlay.getByRole('button', { name: 'Cancel simulation work', exact: true }).click();
    await page.evaluate(() => (window as any).releaseSimulationReply());
    await expect.poll(() => page.evaluate(() => (window as any).simulationReplyReleased)).toBe(true);
    await expect(snapshot).toHaveText('—');
    await expect(overlay.getByRole('button', { name: 'Initialize / Retry', exact: true })).toBeEnabled();
    await overlay.getByRole('button', { name: 'Initialize / Retry', exact: true }).click();
    await expect.poll(async () => { try { return await state(); } catch { return null; } }).toEqual(changed);
    await page.evaluate(() => (window as any).closeSimulation());
    await expect(overlay).toHaveCount(0);
    expect(errors).toEqual([]);
  } finally { await server.close(); }
});
