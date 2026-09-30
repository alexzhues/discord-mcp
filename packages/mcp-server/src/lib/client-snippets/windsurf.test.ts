import { describe, expect, it } from 'vitest';
import type { SnippetConfig } from './types.js';
import { windsurfGenerator } from './windsurf.js';

const baseConfig: SnippetConfig = {
  serverPath: 'node',
  serverArgs: ['/srv/discord-mcp.js'],
  // biome-ignore lint/suspicious/noTemplateCurlyInString: legacy init placeholder
  discordToken: '${env:DISCORD_TOKEN}',
};

function entry(content: string): Record<string, unknown> {
  return (JSON.parse(content) as { mcpServers: { 'discord-mcp': Record<string, unknown> } })
    .mcpServers['discord-mcp'];
}

describe('windsurfGenerator', () => {
  it('renders the standard server shape and inherits the guided token', () => {
    const value = entry(windsurfGenerator.generate(baseConfig).content);
    expect(value).toMatchObject({ command: 'node', args: ['/srv/discord-mcp.js'] });
    // biome-ignore lint/suspicious/noTemplateCurlyInString: native environment reference
    expect(value.env).toMatchObject({ DISCORD_TOKEN: '${env:DISCORD_TOKEN}' });
  });

  it('preserves explicit token, gateway, and extra environment', () => {
    const value = entry(
      windsurfGenerator.generate({
        ...baseConfig,
        discordToken: 'Bot explicit',
        gateway: true,
        envVars: { ALLOWED_GUILDS: '123' },
      }).content,
    );
    expect(value).toMatchObject({
      args: ['/srv/discord-mcp.js', '--gateway'],
      env: { DISCORD_TOKEN: 'Bot explicit', ALLOWED_GUILDS: '123' },
    });
  });

  it('documents the config paths and UI workflow', () => {
    const snippet = windsurfGenerator.generate(baseConfig);
    expect(snippet.configFilePath).toContain('~/.config/devin/mcp_config.json');
    expect(snippet.configFilePath).toContain('.codeium/windsurf/mcp_config.json');
    expect(snippet.instructions).toContain('Open MCP config file');
  });
});
