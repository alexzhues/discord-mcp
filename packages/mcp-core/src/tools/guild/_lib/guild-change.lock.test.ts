import { mkdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it, vi } from 'vitest';
import { loadConfig } from '../../../config.js';
import { resolveBlueprintStatePath } from './blueprint.state-path.js';
import { acquireGuildChangeLock, getGuildChangeContext } from './guild-change.js';

describe('guild change lock recovery', () => {
  it('recovers one stale directory and admits only one concurrent claimant', async () => {
    const state = await import('node:fs/promises').then(({ mkdtemp }) =>
      mkdtemp(join(tmpdir(), 'guild-change-lock-')),
    );
    const planRef = `gcp1.${'a'.repeat(64)}`;
    const config = loadConfig({
      DISCORD_TOKEN: 'test-token'.padEnd(64, 'x'),
      MCP_BLUEPRINT_STATE_DIR: state,
    });
    const directory = getGuildChangeContext(config).directory;
    const lock = join(directory, `${planRef.slice(5)}.lock`);
    await mkdir(lock, { recursive: true });
    await writeFile(
      resolveBlueprintStatePath(lock, 'owner.json'),
      JSON.stringify({ pid: 99999999 }),
    );
    const kill = vi.spyOn(process, 'kill').mockImplementation(() => {
      const error = new Error('dead') as NodeJS.ErrnoException;
      error.code = 'ESRCH';
      throw error;
    });
    try {
      const results = await Promise.allSettled([
        acquireGuildChangeLock(planRef, config),
        acquireGuildChangeLock(planRef, config),
      ]);
      expect(results.filter((result) => result.status === 'fulfilled')).toHaveLength(1);
      expect(results.filter((result) => result.status === 'rejected')).toHaveLength(1);
      const winner = results.find((result) => result.status === 'fulfilled');
      if (winner?.status !== 'fulfilled') throw new Error('no winner');
      await winner.value();
      const next = await acquireGuildChangeLock(planRef, config);
      await next();
    } finally {
      kill.mockRestore();
      await rm(state, { recursive: true, force: true });
    }
  });
});
