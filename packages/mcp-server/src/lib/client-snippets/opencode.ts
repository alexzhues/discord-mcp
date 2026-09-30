import { renderServerEntry } from './_shared.js';
import type { ClientGenerator, Snippet, SnippetConfig } from './types.js';

// biome-ignore lint/suspicious/noTemplateCurlyInString: legacy init placeholder
const LEGACY_TOKEN_PLACEHOLDER = '${env:DISCORD_TOKEN}';
const TOKEN_REFERENCE = '{env:DISCORD_TOKEN}';

export const opencodeGenerator: ClientGenerator = {
  id: 'opencode',
  displayName: 'OpenCode',
  generate(cfg: SnippetConfig): Snippet {
    const entry = renderServerEntry({
      ...cfg,
      discordToken:
        cfg.discordToken === undefined || cfg.discordToken === LEGACY_TOKEN_PLACEHOLDER
          ? TOKEN_REFERENCE
          : cfg.discordToken,
    });
    const doc = {
      mcp: {
        'discord-mcp': {
          type: 'local',
          command: [entry.command, ...entry.args],
          environment: entry.env,
          enabled: true,
          timeout: 90_000,
        },
      },
    };
    return {
      format: 'json',
      content: `${JSON.stringify(doc, null, 2)}\n`,
      configFilePath:
        'Global: ~/.config/opencode/opencode.json\nPer-project: <project>/opencode.json (or opencode.jsonc)',
      instructions:
        'Merge discord-mcp into the `mcp` object in your OpenCode config, preserving other settings. Launch OpenCode with DISCORD_TOKEN set and restart it, then check `opencode mcp list`. The `{env:DISCORD_TOKEN}` reference reads the environment without storing the token. The 90-second discovery timeout allows a cold pinned npx launch; it is not a tool-call timeout.',
    };
  },
};
