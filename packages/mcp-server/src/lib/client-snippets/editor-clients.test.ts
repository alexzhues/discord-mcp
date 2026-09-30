import { describe, expect, it } from 'vitest';
import { opencodeGenerator } from './opencode.js';
import { vscodeGenerator } from './vscode.js';
import { zedGenerator } from './zed.js';

const launcher = {
  serverPath: 'C:\\Program Files\\nodejs\\node.exe',
  serverArgs: ['C:\\My project\\cli.js', 'serve'],
  gateway: true,
  envVars: { MCP_TOOL_SURFACE: 'progressive', ALLOWED_GUILDS: '111122223333444455' },
};

describe('client-specific editor schemas', () => {
  it('generates the VS Code servers object with a native token reference', () => {
    const snippet = vscodeGenerator.generate(launcher);
    const doc = JSON.parse(snippet.content);
    expect(doc).toEqual({
      servers: {
        'discord-mcp': {
          type: 'stdio',
          command: launcher.serverPath,
          args: [...launcher.serverArgs, '--gateway'],
          env: {
            // biome-ignore lint/suspicious/noTemplateCurlyInString: VS Code reference
            DISCORD_TOKEN: '${env:DISCORD_TOKEN}',
            ...launcher.envVars,
          },
        },
      },
    });
    expect(snippet.configFilePath).toContain('.vscode/mcp.json');
  });

  it('generates Zed flat context_servers entries and inherits the token', () => {
    const snippet = zedGenerator.generate(launcher);
    expect(JSON.parse(snippet.content)).toEqual({
      context_servers: {
        'discord-mcp': {
          command: launcher.serverPath,
          args: [...launcher.serverArgs, '--gateway'],
          env: launcher.envVars,
        },
      },
    });
    expect(snippet.instructions).toContain('keep Gateway disabled');
  });

  it('generates OpenCode command arrays and its environment reference', () => {
    const snippet = opencodeGenerator.generate(launcher);
    expect(JSON.parse(snippet.content)).toEqual({
      mcp: {
        'discord-mcp': {
          type: 'local',
          command: [launcher.serverPath, ...launcher.serverArgs, '--gateway'],
          environment: { DISCORD_TOKEN: '{env:DISCORD_TOKEN}', ...launcher.envVars },
          enabled: true,
          timeout: 90_000,
        },
      },
    });
    expect(snippet.configFilePath).toContain('opencode.json');
  });

  it.each([
    vscodeGenerator,
    zedGenerator,
    opencodeGenerator,
  ])('$id preserves explicitly supplied tokens and safely escapes paths', (generator) => {
    const snippet = generator.generate({ ...launcher, discordToken: 'Bot "explicit"\\token' });
    const doc = JSON.parse(snippet.content);
    const entry = (doc.servers ?? doc.context_servers ?? doc.mcp)['discord-mcp'];
    expect((entry.env ?? entry.environment).DISCORD_TOKEN).toBe('Bot "explicit"\\token');
    expect(snippet.content.endsWith('\n')).toBe(true);
  });

  it('normalizes legacy init placeholders for Zed and OpenCode', () => {
    // biome-ignore lint/suspicious/noTemplateCurlyInString: legacy init placeholder
    const cfg = { serverPath: 'node', discordToken: '${env:DISCORD_TOKEN}' };
    expect(JSON.parse(zedGenerator.generate(cfg).content)).toEqual({
      context_servers: { 'discord-mcp': { command: 'node', args: [] } },
    });
    const entry = JSON.parse(opencodeGenerator.generate(cfg).content).mcp['discord-mcp'];
    expect(entry.command).toEqual(['node']);
    expect(entry.environment.DISCORD_TOKEN).toBe('{env:DISCORD_TOKEN}');
  });
});
