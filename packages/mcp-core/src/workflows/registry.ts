import type { WorkflowEngine } from './engine.js';

export function getWorkflowEngine(context: unknown): WorkflowEngine {
  const engine = (context as { workflowEngine?: WorkflowEngine } | undefined)?.workflowEngine;
  if (engine === undefined)
    throw new Error('Durable workflows are not configured for this server instance.');
  return engine;
}
