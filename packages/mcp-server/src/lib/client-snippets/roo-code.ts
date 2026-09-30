/**
 * Roo Code MCP server snippet generator.
 *
 * Roo Code uses the standard `mcpServers` document in global settings or a
 * project-local `.roo/mcp.json` file. DISCORD_TOKEN is inherited by the MCP
 * process from Roo Code's launch environment.
 */
import { renderMcpServersJson } from './_shared.js';
import type { ClientGenerator, Snippet, SnippetConfig } from './types.js';

// biome-ignore lint/suspicious/noTemplateCurlyInString: literal legacy placeholder
const LEGACY_TOKEN_PLACEHOLDER = '${env:DISCORD_TOKEN}';

const CONFIG_PATH = [
  'Global:  mcp_settings.json (Roo Code MCP settings)',
  'Project: <project>/.roo/mcp.json',
].join('\n');

const INSTRUCTIONS =
  'Open Roo Code MCP settings and choose Edit Global MCP, or edit `.roo/mcp.json` in the project root. Merge this entry under `mcpServers`, save, and restart the MCP server. Ensure DISCORD_TOKEN is set in the environment that launches Roo Code.';

function renderRooCodeMcpServersJson(cfg: SnippetConfig): string {
  const { discordToken, ...rest } = cfg;
  return renderMcpServersJson(
    discordToken === undefined || discordToken === LEGACY_TOKEN_PLACEHOLDER
      ? rest
      : { ...rest, discordToken },
  );
}

export const rooCodeGenerator: ClientGenerator = {
  id: 'roo-code',
  displayName: 'Roo Code',
  generate(cfg: SnippetConfig): Snippet {
    return {
      format: 'json',
      content: renderRooCodeMcpServersJson(cfg),
      configFilePath: CONFIG_PATH,
      instructions: INSTRUCTIONS,
    };
  },
};
