/**
 * Cline MCP server snippet generator.
 *
 * Cline's CLI and VS Code extension both use the standard `mcpServers`
 * document. The server process inherits DISCORD_TOKEN from the launcher.
 */
import { renderMcpServersJson } from './_shared.js';
import type { ClientGenerator, Snippet, SnippetConfig } from './types.js';

// biome-ignore lint/suspicious/noTemplateCurlyInString: literal legacy placeholder
const LEGACY_TOKEN_PLACEHOLDER = '${env:DISCORD_TOKEN}';

const CONFIG_PATH = [
  'CLI: ~/.cline/mcp.json',
  'IDE: cline_mcp_settings.json (open via MCP Servers → Configure MCP Servers)',
].join('\n');

const INSTRUCTIONS =
  'For Cline CLI, merge this entry under `mcpServers` in `~/.cline/mcp.json`. In the Cline extension, open MCP Servers → Configure MCP Servers and merge it into the JSON, then restart the server. Ensure DISCORD_TOKEN is set in the environment that launches Cline.';

function renderClineMcpServersJson(cfg: SnippetConfig): string {
  const { discordToken, ...rest } = cfg;
  return renderMcpServersJson(
    discordToken === undefined || discordToken === LEGACY_TOKEN_PLACEHOLDER
      ? rest
      : { ...rest, discordToken },
  );
}

export const clineGenerator: ClientGenerator = {
  id: 'cline',
  displayName: 'Cline',
  generate(cfg: SnippetConfig): Snippet {
    return {
      format: 'json',
      content: renderClineMcpServersJson(cfg),
      configFilePath: CONFIG_PATH,
      instructions: INSTRUCTIONS,
    };
  },
};
