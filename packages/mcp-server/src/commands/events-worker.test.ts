import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { expect, it } from 'vitest';
import { acquireWorkerLock } from './events-worker.js';

it('allows only one listener/worker across connections and releases the lock for restart', () => {
  const directory = mkdtempSync(join(tmpdir(), 'discord-events-lock-'));
  try {
    const release = acquireWorkerLock(directory);
    expect(readFileSync(join(directory, 'worker.pid'), 'utf8')).toBe(String(process.pid));
    expect(() => acquireWorkerLock(directory)).toThrow('already owns');
    release();
    const next = acquireWorkerLock(directory);
    next();
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});
