/**
 * Windsurf MCP server snippet generator.
 *
 * Cascade uses the standard `mcpServers` schema. Current Devin Desktop stores
 * its configuration under devin; older Windsurf releases use .codeium/windsurf.
 */
import { renderMcpServersJson } from './_shared.js';
import type { ClientGenerator, Snippet, SnippetConfig } from './types.js';

// biome-ignore lint/suspicious/noTemplateCurlyInString: native environment reference
const TOKEN_REFERENCE = '${env:DISCORD_TOKEN}';

const CONFIG_PATH = [
  'Cascade (macOS/Linux): ~/.config/devin/mcp_config.json',
  'Cascade (Windows):     %APPDATA%\\devin\\mcp_config.json',
  'Older Windsurf:        ~/.codeium/windsurf/mcp_config.json',
].join('\n');

const INSTRUCTIONS =
  // biome-ignore lint/suspicious/noTemplateCurlyInString: native environment reference
  'In Cascade, open Actions > MCPs > Open MCP config file and merge this entry under `mcpServers`, preserving other servers. Toggle the MCP server or restart the editor with DISCORD_TOKEN in its launch environment. The `${env:DISCORD_TOKEN}` reference reads that environment without storing the token. For the current Devin Local agent, use `--client devin` and its dedicated configuration guide.';

function renderWindsurfMcpServersJson(cfg: SnippetConfig): string {
  return renderMcpServersJson({ ...cfg, discordToken: cfg.discordToken ?? TOKEN_REFERENCE });
}

export const windsurfGenerator: ClientGenerator = {
  id: 'windsurf',
  displayName: 'Windsurf / Cascade (compatibility)',
  generate(cfg: SnippetConfig): Snippet {
    return {
      format: 'json',
      content: renderWindsurfMcpServersJson(cfg),
      configFilePath: CONFIG_PATH,
      instructions: INSTRUCTIONS,
    };
  },
};
