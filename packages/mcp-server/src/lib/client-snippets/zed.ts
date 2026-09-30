import { renderServerEntry } from './_shared.js';
import type { ClientGenerator, Snippet, SnippetConfig } from './types.js';

// biome-ignore lint/suspicious/noTemplateCurlyInString: legacy init placeholder
const LEGACY_TOKEN_PLACEHOLDER = '${env:DISCORD_TOKEN}';

export const zedGenerator: ClientGenerator = {
  id: 'zed',
  displayName: 'Zed',
  generate(cfg: SnippetConfig): Snippet {
    const { discordToken, ...rest } = cfg;
    const doc = {
      context_servers: {
        'discord-mcp': renderServerEntry({
          ...rest,
          ...(discordToken === undefined || discordToken === LEGACY_TOKEN_PLACEHOLDER
            ? {}
            : { discordToken }),
        }),
      },
    };
    return {
      format: 'json',
      content: `${JSON.stringify(doc, null, 2)}\n`,
      configFilePath: 'User settings: zed: open settings file',
      instructions:
        'Run `zed: open settings file` and merge discord-mcp into `context_servers`, preserving other settings. Launch Zed with DISCORD_TOKEN in its environment and restart the MCP server in Settings > AI > MCP Servers. Use Zed Agent for the configured tools; terminal agents use their own MCP configuration. Zed supports tools and prompts, so keep Gateway disabled for this setup.',
    };
  },
};
