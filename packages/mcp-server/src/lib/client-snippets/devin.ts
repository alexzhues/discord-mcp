/**
 * Devin Local MCP server snippet generator.
 *
 * Devin Local and the Devin CLI use the standard `mcpServers` schema in
 * dedicated user, project, or project-local configuration files.
 */
import { renderMcpServersJson } from './_shared.js';
import type { ClientGenerator, Snippet, SnippetConfig } from './types.js';

// biome-ignore lint/suspicious/noTemplateCurlyInString: legacy init placeholder
const LEGACY_TOKEN_PLACEHOLDER = '${env:DISCORD_TOKEN}';

const CONFIG_PATH = [
  'User (macOS/Linux): ~/.config/devin/mcp_config.json',
  'User (Windows):     %APPDATA%\\devin\\mcp_config.json',
  'Project:             <project>/.devin/mcp_config.json',
  'Project-local:       <project>/.devin/mcp_config.local.json',
].join('\n');

const INSTRUCTIONS =
  'Merge this entry under `mcpServers` in the Devin CLI configuration, preserving existing servers. Launch Devin Local or the CLI with DISCORD_TOKEN set, restart the MCP connection, then run `devin mcp list`. The generated config omits the token field. If your host does not forward it, supply credentials through the private `.devin/mcp_config.local.json` file documented by Devin; keep that file out of version control.';

function renderDevinMcpServersJson(cfg: SnippetConfig): string {
  const { discordToken, ...rest } = cfg;
  return renderMcpServersJson({
    ...rest,
    ...(discordToken === undefined || discordToken === LEGACY_TOKEN_PLACEHOLDER
      ? {}
      : { discordToken }),
  });
}

export const devinGenerator: ClientGenerator = {
  id: 'devin',
  displayName: 'Devin Local',
  generate(cfg: SnippetConfig): Snippet {
    return {
      format: 'json',
      content: renderDevinMcpServersJson(cfg),
      configFilePath: CONFIG_PATH,
      instructions: INSTRUCTIONS,
    };
  },
};
