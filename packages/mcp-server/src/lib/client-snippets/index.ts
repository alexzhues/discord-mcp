/**
 * Registry of all supported MCP client snippet generators - Plan 9 Phase D.
 *
 * Order is intentional: Claude Desktop first (most common entry point
 * for new users), Claude Code second (Anthropic CLI), Codex third,
 * Antigravity CLI fourth, Cursor Agent CLI fifth, Grok Build CLI sixth, Gemini CLI
 * seventh, Cursor editor eighth, DeepSeek Harness ninth, followed by other
 * editors and coding clients, with Generic last (fallback). The numeric order also drives the
 * default index in interactive `init` choice prompts.
 *
 * To add a new client: implement {@link ClientGenerator} in a new file
 * under this directory, register the singleton here, and add a test.
 * `init` reads from this array. Extend the profile client IDs, CLI help, and
 * documentation tabs alongside the registry so guided setup stays consistent.
 */
import { antigravityCliGenerator } from './antigravity-cli.js';
import { claudeCodeGenerator } from './claude-code.js';
import { claudeDesktopGenerator } from './claude-desktop.js';
import { clineGenerator } from './cline.js';
import { codexGenerator } from './codex.js';
import { continueGenerator } from './continue.js';
import { cursorGenerator } from './cursor.js';
import { cursorCliGenerator } from './cursor-cli.js';
import { deepseekHarnessGenerator } from './deepseek-harness.js';
import { devinGenerator } from './devin.js';
import { geminiCliGenerator } from './gemini-cli.js';
import { genericGenerator } from './generic.js';
import { grokCliGenerator } from './grok-cli.js';
import { opencodeGenerator } from './opencode.js';
import { rooCodeGenerator } from './roo-code.js';
import type { ClientGenerator } from './types.js';
import { vscodeGenerator } from './vscode.js';
import { windsurfGenerator } from './windsurf.js';
import { zedGenerator } from './zed.js';

export type { ClientGenerator, Snippet, SnippetConfig } from './types.js';

export const ALL_GENERATORS: readonly ClientGenerator[] = [
  claudeDesktopGenerator,
  claudeCodeGenerator,
  codexGenerator,
  antigravityCliGenerator,
  cursorCliGenerator,
  grokCliGenerator,
  geminiCliGenerator,
  cursorGenerator,
  deepseekHarnessGenerator,
  vscodeGenerator,
  windsurfGenerator,
  devinGenerator,
  clineGenerator,
  rooCodeGenerator,
  continueGenerator,
  zedGenerator,
  opencodeGenerator,
  genericGenerator,
];
