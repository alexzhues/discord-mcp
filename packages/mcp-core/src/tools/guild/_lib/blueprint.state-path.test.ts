import { join, resolve } from 'node:path';
import { describe, expect, it } from 'vitest';
import { resolveBlueprintPlanPath, resolveBlueprintStatePath } from './blueprint.state-path.js';

const planRef = `gcp1.${'a'.repeat(64)}`;

describe('blueprint state paths', () => {
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
