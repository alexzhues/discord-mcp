import { describe, expect, it } from 'vitest';
import { parse } from 'yaml';
import { continueGenerator } from './continue.js';
import type { SnippetConfig } from './types.js';

const baseConfig: SnippetConfig = {
  serverPath: 'npx',
  serverArgs: ['-y', '@discord-mcp/cli@0.28.0', 'serve', '--profile', 'devbot'],
};

describe('continueGenerator', () => {
  it('renders a complete parseable Continue YAML document', () => {
    const snippet = continueGenerator.generate(baseConfig);
    const value = parse(snippet.content) as {
      name: string;
      version: string;
      schema: string;
      mcpServers: Array<Record<string, unknown>>;
    };
    expect(value).toMatchObject({ name: 'Discord MCP', version: '1.0.0', schema: 'v1' });
    expect(value.mcpServers).toHaveLength(1);
    expect(value.mcpServers[0]).toMatchObject({
      name: 'discord-mcp',
      type: 'stdio',
      command: 'npx',
      args: baseConfig.serverArgs,
      // biome-ignore lint/suspicious/noTemplateCurlyInString: Continue secret reference
      env: { DISCORD_TOKEN: '${{ secrets.DISCORD_TOKEN }}' },
      connectionTimeout: 90000,
    });
  });

  it('preserves an explicit token and appends gateway', () => {
    const value = parse(
      continueGenerator.generate({
        ...baseConfig,
        discordToken: 'Bot continue',
        gateway: true,
        envVars: { DISCORD_EXPECTED_BOT_ID: '987' },
      }).content,
    ) as { mcpServers: Array<{ args: string[]; env: Record<string, string> }> };
    expect(value.mcpServers[0]?.args).toContain('--gateway');
    expect(value.mcpServers[0]?.env).toEqual({
      DISCORD_TOKEN: 'Bot continue',
      DISCORD_EXPECTED_BOT_ID: '987',
    });
  });

  it('replaces the legacy placeholder with Continue secret syntax', () => {
    const value = parse(
      continueGenerator.generate({
        ...baseConfig,
        // biome-ignore lint/suspicious/noTemplateCurlyInString: legacy init placeholder
        discordToken: '${env:DISCORD_TOKEN}',
      }).content,
    ) as { mcpServers: Array<{ env: Record<string, string> }> };
    // biome-ignore lint/suspicious/noTemplateCurlyInString: Continue secret reference
    expect(value.mcpServers[0]?.env.DISCORD_TOKEN).toBe('${{ secrets.DISCORD_TOKEN }}');
  });

  it('documents project and global paths plus IDE secret handling', () => {
    const snippet = continueGenerator.generate(baseConfig);
    expect(snippet.configFilePath).toContain('<project>/.continue/mcpServers/discord-mcp.yaml');
    expect(snippet.configFilePath).toContain('%USERPROFILE%');
    expect(snippet.instructions).toContain('.continue/.env');
  });
});
