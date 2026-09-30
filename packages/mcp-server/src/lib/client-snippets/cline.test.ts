import { describe, expect, it } from 'vitest';
import { clineGenerator } from './cline.js';
import type { SnippetConfig } from './types.js';

const baseConfig: SnippetConfig = {
  serverPath: 'npx',
  serverArgs: ['@discord-mcp/cli'],
  // biome-ignore lint/suspicious/noTemplateCurlyInString: legacy init placeholder
  discordToken: '${env:DISCORD_TOKEN}',
};

function entry(content: string): Record<string, unknown> {
  return (JSON.parse(content) as { mcpServers: { 'discord-mcp': Record<string, unknown> } })
    .mcpServers['discord-mcp'];
}

describe('clineGenerator', () => {
  it('renders mcpServers and omits unsupported legacy interpolation', () => {
    const value = entry(clineGenerator.generate(baseConfig).content);
    expect(value).toMatchObject({ command: 'npx', args: ['@discord-mcp/cli'] });
    expect(value.env).toBeUndefined();
  });

  it('preserves explicit token, gateway, and envVars', () => {
    const value = entry(
      clineGenerator.generate({
        ...baseConfig,
        discordToken: 'Bot cline',
        gateway: true,
        envVars: { MCP_AUDIT_SINK: 'stderr' },
      }).content,
    );
    expect(value).toMatchObject({
      args: ['@discord-mcp/cli', '--gateway'],
      env: { DISCORD_TOKEN: 'Bot cline', MCP_AUDIT_SINK: 'stderr' },
    });
  });

  it('documents CLI and extension configuration entry points', () => {
    const snippet = clineGenerator.generate(baseConfig);
    expect(snippet.configFilePath).toContain('~/.cline/mcp.json');
    expect(snippet.configFilePath).toContain('cline_mcp_settings.json');
    expect(snippet.instructions).toContain('Configure MCP Servers');
  });
});
