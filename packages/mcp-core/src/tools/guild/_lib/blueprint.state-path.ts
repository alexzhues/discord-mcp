import { homedir } from 'node:os';
import { join, resolve, sep } from 'node:path';
import type { Config } from '../../../config.js';

const PLAN_REF_RE = /^gcp1\.([a-f0-9]{64})$/;
const SAFE_BASENAME_RE = /^(?!\.{1,2}$)[a-zA-Z0-9._-]+$/;

export function resolveBlueprintStateDirectory(config: Config): string {
  if (config.MCP_BLUEPRINT_STATE_DIR !== undefined) {
    return resolve(config.MCP_BLUEPRINT_STATE_DIR);
  }
  if (process.platform === 'win32') {
    const base = process.env.LOCALAPPDATA ?? join(homedir(), 'AppData', 'Local');
    return resolve(base, 'discord-mcp', 'blueprints');
  }
  if (process.platform === 'darwin') {
    return join(homedir(), 'Library', 'Application Support', 'discord-mcp', 'blueprints');
  }
  const base = process.env.XDG_STATE_HOME ?? join(homedir(), '.local', 'state');
  return resolve(base, 'discord-mcp', 'blueprints');
}

/** Resolve one generated state artifact without allowing a caller-controlled path segment. */
export function resolveBlueprintStatePath(directory: string, basename: string): string {
  if (!SAFE_BASENAME_RE.test(basename)) throw new Error('Invalid blueprint state path.');
  const root = resolve(directory);
  const candidate = resolve(root, basename);
  const prefix = root.endsWith(sep) ? root : `${root}${sep}`;
  if (!candidate.startsWith(prefix)) throw new Error('Invalid blueprint state path.');
  return candidate;
}

export function resolveBlueprintPlanPath(
  directory: string,
  planRef: string,
  suffix: '.json' | '.checkpoint.json' | '.lock' | '.lock.recover',
): string {
  const match = PLAN_REF_RE.exec(planRef);
  if (match === null) throw new Error('Invalid guild change plan reference.');
  return resolveBlueprintStatePath(directory, `${match[1]}${suffix}`);
}
