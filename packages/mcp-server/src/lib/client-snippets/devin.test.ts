import { describe, expect, it } from 'vitest';
import { devinGenerator } from './devin.js';
import type { SnippetConfig } from './types.js';

const baseConfig: SnippetConfig = {
  serverPath: 'npx',
  serverArgs: ['@discord-mcp/cli'],
  // biome-ignore lint/suspicious/noTemplateCurlyInString: native environment reference
  discordToken: '${env:DISCORD_TOKEN}',
};

function entry(content: string): Record<string, unknown> {
  return (JSON.parse(content) as { mcpServers: { 'discord-mcp': Record<string, unknown> } })
    .mcpServers['discord-mcp'];
}

describe('devinGenerator', () => {
  it('renders Devin Local mcpServers without a literal legacy placeholder', () => {
    const value = entry(devinGenerator.generate(baseConfig).content);
    expect(value).toMatchObject({
      command: 'npx',
      args: ['@discord-mcp/cli'],
    });
    expect(value.env).toBeUndefined();
  });

  it('preserves explicit token, gateway, and envVars', () => {
    const value = entry(
      devinGenerator.generate({
        ...baseConfig,
        discordToken: 'Bot explicit',
        gateway: true,
        envVars: { ALLOWED_GUILDS: '123' },
      }).content,
    );
    expect(value).toMatchObject({
      args: ['@discord-mcp/cli', '--gateway'],
      env: { DISCORD_TOKEN: 'Bot explicit', ALLOWED_GUILDS: '123' },
    });
  });

  it('documents current user, project, and local Devin config files', () => {
    const snippet = devinGenerator.generate(baseConfig);
    expect(snippet.configFilePath).toContain('~/.config/devin/mcp_config.json');
    expect(snippet.configFilePath).toContain('<project>/.devin/mcp_config.json');
    expect(snippet.configFilePath).toContain('.devin/mcp_config.local.json');
    expect(snippet.instructions).toContain('devin mcp list');
  });
});
