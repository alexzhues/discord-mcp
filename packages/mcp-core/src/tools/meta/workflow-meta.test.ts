import { describe, expect, it, vi } from 'vitest';
import { getWorkflowEngine } from '../../workflows/registry.js';
import workflowCancel from './workflow-cancel.js';
import workflowResume from './workflow-resume.js';
import workflowStart from './workflow-start.js';
import workflowStatus from './workflow-status.js';

const target = {
  profile_id: 'default',
  bot_id: '100000000000000000',
  guild_id: '200000000000000000',
};
const summary = {
  id: 'wf_0123456789abcdef0123456789abcdef',
  status: 'queued',
  target,
  current_step: 0,
  total_steps: 1,
  completed_steps: 0,
  cancel_requested: false,
  updated_at: new Date().toISOString(),
};

function tool(definition: typeof workflowStart) {
  const Tool = definition;
  return new Tool(
    { name: 'workflow', path: 'inline', root: 'inline', store: null as never },
    { name: 'workflow', enabled: true },
  ).run as (args: unknown, ctx: unknown) => Promise<{ structuredContent: Record<string, unknown> }>;
}

describe('workflow meta wrappers', () => {
  it('delegates start, status, cancel, and resume to the trusted engine', async () => {
    const engine = {
      start: vi.fn().mockResolvedValue(summary),
      status: vi.fn().mockResolvedValue(summary),
      cancel: vi.fn().mockResolvedValue({ ...summary, status: 'cancel_requested' }),
      resume: vi.fn().mockResolvedValue(summary),
    };
    const ctx = { workflowEngine: engine, trustedTarget: target };
    const start = await tool(workflowStart)({ target, steps: [{ tool: 'x', args: {} }] }, ctx);
    const status = await tool(workflowStatus)({ id: summary.id, target }, ctx);
    const cancel = await tool(workflowCancel)({ id: summary.id, target }, ctx);
    const resume = await tool(workflowResume)({ id: summary.id, target }, ctx);
    expect(start.structuredContent.id).toBe(summary.id);
    expect(status.structuredContent.status).toBe('queued');
    expect(cancel.structuredContent.status).toBe('cancel_requested');
    expect(resume.structuredContent.id).toBe(summary.id);
    expect(engine.start).toHaveBeenCalledOnce();
    expect(engine.status).toHaveBeenCalledOnce();
    expect(engine.cancel).toHaveBeenCalledOnce();
    expect(engine.resume).toHaveBeenCalledOnce();
  });

  it('fails closed when a server did not inject a trusted workflow engine', () => {
    expect(() => getWorkflowEngine({})).toThrow('Durable workflows are not configured');
  });
});
