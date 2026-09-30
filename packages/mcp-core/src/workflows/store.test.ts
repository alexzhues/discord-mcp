import { mkdtemp, readFile, rm, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it, vi } from 'vitest';
import { WorkflowStore } from './store.js';
import type { WorkflowRecord } from './types.js';

const record: WorkflowRecord = {
  schema_version: 'workflow.v1',
  id: 'wf_0123456789abcdef0123456789abcdef',
  created_at: '2026-01-01T00:00:00.000Z',
  updated_at: '2026-01-01T00:00:00.000Z',
  status: 'queued',
  target: { profile_id: 'profile' },
  target_fingerprint: 'sha256:test',
  steps: [],
  current_step: 0,
  cancel_requested: false,
};

describe('WorkflowStore', () => {
  it('uses private directory/files and atomic JSON replacement', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'discord-mcp-workflow-store-'));
    try {
      const store = new WorkflowStore(dir, 'workflow-test-integrity-key-01234567890123456789');
      await store.init();
      await store.put(record);
      if (process.platform !== 'win32') {
        expect((await stat(dir)).mode & 0o777).toBe(0o700);
        expect((await stat(join(dir, `${record.id}.json`))).mode & 0o777).toBe(0o600);
      }
      expect(JSON.parse(await readFile(join(dir, `${record.id}.json`), 'utf8')).record.id).toBe(
        record.id,
      );
      await expect(store.get('../x')).rejects.toThrow(/Invalid workflow ID/);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  it('prevents two executors from holding one job lock', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'discord-mcp-workflow-lock-'));
    try {
      const store = new WorkflowStore(dir, 'workflow-test-integrity-key-01234567890123456789');
      await store.init();
      let release!: () => void;
      const held = store.withLock(
        record.id,
        () =>
          new Promise<void>((resolve) => {
            release = resolve;
          }),
      );
      for (let i = 0; i < 20 && release === undefined; i += 1)
        await new Promise((resolve) => setTimeout(resolve, 5));
      await expect(store.withLock(record.id, async () => undefined)).rejects.toThrow(
        /already being executed/,
      );
      release();
      await held;
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  it('rejects a tampered checkpoint', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'discord-mcp-workflow-tamper-'));
    try {
      const store = new WorkflowStore(dir, 'workflow-test-integrity-key-01234567890123456789');
      await store.init();
      await store.put(record);
      const path = join(dir, `${record.id}.json`);
      const value = JSON.parse(await readFile(path, 'utf8')) as {
        record: WorkflowRecord;
        mac: string;
      };
      value.record = { ...value.record, status: 'completed' };
      const { writeFile } = await import('node:fs/promises');
      await writeFile(path, JSON.stringify(value));
      await expect(store.get(record.id)).rejects.toThrow(/integrity/);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  it('rejects malformed checkpoint envelopes and a busy stale-lock recovery guard', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'discord-mcp-workflow-malformed-'));
    try {
      const store = new WorkflowStore(dir, 'workflow-test-integrity-key-01234567890123456789');
      await store.init();
      await writeFile(join(dir, `${record.id}.json`), JSON.stringify({ record }));
      await expect(store.get(record.id)).rejects.toThrow(/malformed/);
      await rm(join(dir, `${record.id}.json`), { force: true });
      await writeFile(join(dir, `${record.id}.lock`), '99999999\n');
      const kill = vi.spyOn(process, 'kill').mockImplementation(() => {
        const error = new Error('dead') as NodeJS.ErrnoException;
        error.code = 'ESRCH';
        throw error;
      });
      await writeFile(join(dir, `${record.id}.lock.recover`), 'other\n');
      await expect(store.withLock(record.id, async () => undefined)).rejects.toThrow(
        /already being executed/,
      );
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  it('rejects traversal for every file operation', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'discord-mcp-workflow-path-'));
    try {
      const store = new WorkflowStore(dir, 'workflow-test-integrity-key-01234567890123456789');
      await store.init();
      await expect(store.remove('../escape')).rejects.toThrow(/Invalid workflow ID/);
      await expect(store.withLock('../escape', async () => undefined)).rejects.toThrow(
        /Invalid workflow ID/,
      );
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  it('rejects an undersized integrity key before creating durable state', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'discord-mcp-workflow-key-'));
    try {
      expect(() => new WorkflowStore(dir, 'too-short')).toThrow(/at least 32/);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  it('allows only one concurrent executor to recover a stale lock', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'discord-mcp-workflow-stale-lock-'));
    try {
      const store = new WorkflowStore(dir, 'workflow-test-integrity-key-01234567890123456789');
      await store.init();
      await writeFile(join(dir, `${record.id}.lock`), '99999999\n');
      const kill = vi.spyOn(process, 'kill').mockImplementation(() => {
        const error = new Error('dead') as NodeJS.ErrnoException;
        error.code = 'ESRCH';
        throw error;
      });
      let release!: () => void;
      const gate = new Promise<void>((resolve) => {
        release = resolve;
      });
      const first = store.withLock(record.id, () => gate);
      try {
        for (
          let i = 0;
          i < 100 && !(await readFile(join(dir, `${record.id}.lock`), 'utf8').catch(() => ''));
          i += 1
        )
          await new Promise((resolve) => setTimeout(resolve, 5));
        await expect(store.withLock(record.id, async () => undefined)).rejects.toThrow(
          /already being executed/,
        );
        release();
        await first;
      } finally {
        kill.mockRestore();
      }
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });
});
