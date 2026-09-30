/** Continue.dev uses a YAML config with an mcpServers list. */
import { renderServerEntry } from './_shared.js';
import type { ClientGenerator, Snippet, SnippetConfig } from './types.js';

// biome-ignore lint/suspicious/noTemplateCurlyInString: legacy init placeholder
const LEGACY_TOKEN_PLACEHOLDER = '${env:DISCORD_TOKEN}';
// biome-ignore lint/suspicious/noTemplateCurlyInString: Continue secret reference
const TOKEN_REFERENCE = '${{ secrets.DISCORD_TOKEN }}';

const CONFIG_PATH = [
  'Project server file: <project>/.continue/mcpServers/discord-mcp.yaml',
  'Global merge:       ~/.continue/config.yaml (%USERPROFILE%\\.continue\\config.yaml on Windows)',
].join('\n');

const INSTRUCTIONS =
  // biome-ignore lint/suspicious/noTemplateCurlyInString: Continue secret reference
  'For project scope, save this complete YAML file as `<project>/.continue/mcpServers/discord-mcp.yaml`. For global scope, merge its `mcpServers` entry into `%USERPROFILE%\\.continue\\config.yaml`. Put `DISCORD_TOKEN=...` in `%USERPROFILE%\\.continue\\.env` or `<workspace>/.continue/.env`; Continue IDE extensions do not inherit secrets from the shell. Continue CLI can also resolve the same `${{ secrets.DISCORD_TOKEN }}` reference from its process environment. Reload the IDE after changing the configuration.';

function yamlString(value: string): string {
  return JSON.stringify(value);
}

function renderContinueYaml(cfg: SnippetConfig): string {
  const token =
    cfg.discordToken === undefined || cfg.discordToken === LEGACY_TOKEN_PLACEHOLDER
      ? TOKEN_REFERENCE
      : cfg.discordToken;
  const entry = renderServerEntry({ ...cfg, discordToken: token });
  const lines = [
    'name: "Discord MCP"',
    'version: "1.0.0"',
    'schema: "v1"',
    'mcpServers:',
    '  - name: "discord-mcp"',
    '    type: "stdio"',
    `    command: ${yamlString(entry.command)}`,
    '    args:',
    ...(entry.args.length === 0
      ? ['      []']
      : entry.args.map((arg) => `      - ${yamlString(arg)}`)),
    '    env:',
    ...Object.entries(entry.env ?? {}).map(
      ([name, value]) => `      ${yamlString(name)}: ${yamlString(value)}`,
    ),
    // Continue's connection timeout is consumed as milliseconds by its MCP client.
    '    connectionTimeout: 90000',
  ];
  return `${lines.join('\n')}\n`;
}

export const continueGenerator: ClientGenerator = {
  id: 'continue',
  displayName: 'Continue',
  generate(cfg: SnippetConfig): Snippet {
    return {
      format: 'yaml',
      content: renderContinueYaml(cfg),
      configFilePath: CONFIG_PATH,
      instructions: INSTRUCTIONS,
    };
  },
};
