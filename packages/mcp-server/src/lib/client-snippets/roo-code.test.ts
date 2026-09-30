import { describe, expect, it } from 'vitest';
import { rooCodeGenerator } from './roo-code.js';
import type { SnippetConfig } from './types.js';

const baseConfig: SnippetConfig = {
  serverPath: 'node',
  serverArgs: ['server.js'],
  // biome-ignore lint/suspicious/noTemplateCurlyInString: legacy init placeholder
  discordToken: '${env:DISCORD_TOKEN}',
};

function entry(content: string): Record<string, unknown> {
  return (JSON.parse(content) as { mcpServers: { 'discord-mcp': Record<string, unknown> } })
    .mcpServers['discord-mcp'];
}

describe('rooCodeGenerator', () => {
  it('renders the standard shape with inherited token', () => {
    const value = entry(rooCodeGenerator.generate(baseConfig).content);
    expect(value).toMatchObject({ command: 'node', args: ['server.js'] });
    expect(value.env).toBeUndefined();
  });

  it('preserves explicit token, gateway, and envVars', () => {
    const value = entry(
      rooCodeGenerator.generate({
        ...baseConfig,
        discordToken: 'Bot roo',
        gateway: true,
        envVars: { DISCORD_EXPECTED_BOT_ID: '987' },
      }).content,
    );
    expect(value).toMatchObject({
      args: ['server.js', '--gateway'],
      env: { DISCORD_TOKEN: 'Bot roo', DISCORD_EXPECTED_BOT_ID: '987' },
    });
  });

  it('documents global and project configuration paths', () => {
    const snippet = rooCodeGenerator.generate(baseConfig);
    expect(snippet.configFilePath).toContain('mcp_settings.json');
    expect(snippet.configFilePath).toContain('<project>/.roo/mcp.json');
    expect(snippet.instructions).toContain('Edit Global MCP');
  });
});
