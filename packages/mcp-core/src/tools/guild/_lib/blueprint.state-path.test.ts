import { homedir } from 'node:os';
import { join, resolve } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { loadConfig } from '../../../config.js';
import {
  resolveBlueprintPlanPath,
  resolveBlueprintStateDirectory,
  resolveBlueprintStatePath,
} from './blueprint.state-path.js';

const planRef = `gcp1.${'a'.repeat(64)}`;

describe('blueprint state paths', () => {
  afterEach(() => vi.unstubAllEnvs());

  it('keeps the default application namespace under the configured OS state root', () => {
    const base = resolve('custom-state');
    vi.stubEnv('LOCALAPPDATA', base);
    vi.stubEnv('XDG_STATE_HOME', base);
    const config = loadConfig({ DISCORD_TOKEN: 't'.repeat(64) });
    expect(resolveBlueprintStateDirectory(config)).toBe(
      process.platform === 'darwin'
        ? join(homedir(), 'Library', 'Application Support', 'discord-mcp', 'blueprints')
        : join(base, 'discord-mcp', 'blueprints'),
    );
  });

  it('keeps generated plan artifacts directly under the configured state directory', () => {
    const directory = 'C:/discord-mcp/custom-state';
    expect(resolveBlueprintPlanPath(directory, planRef, '.json')).toBe(
      join(resolve(directory), `${'a'.repeat(64)}.json`),
    );
    expect(resolveBlueprintPlanPath(directory, planRef, '.checkpoint.json')).toContain(
      `${'a'.repeat(64)}.checkpoint.json`,
    );
  });

  it('rejects path separators and malformed plan references', () => {
    expect(() => resolveBlueprintStatePath('C:/state', '..')).toThrow(
      'Invalid blueprint state path',
    );
    expect(() => resolveBlueprintStatePath('C:/state', '.')).toThrow(
      'Invalid blueprint state path',
    );
    expect(() => resolveBlueprintStatePath('C:/state', '../outside')).toThrow(
      'Invalid blueprint state path',
    );
    expect(() => resolveBlueprintStatePath('C:/state', 'nested/file.json')).toThrow(
      'Invalid blueprint state path',
    );
    expect(() => resolveBlueprintPlanPath('C:/state', 'gcp1../outside', '.json')).toThrow(
      'Invalid guild change plan reference',
    );
  });
});
