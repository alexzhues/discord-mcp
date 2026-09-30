import { renderServerEntry } from './_shared.js';
import type { ClientGenerator, Snippet, SnippetConfig } from './types.js';

// biome-ignore lint/suspicious/noTemplateCurlyInString: VS Code environment reference
const TOKEN_REFERENCE = '${env:DISCORD_TOKEN}';

export const vscodeGenerator: ClientGenerator = {
  id: 'vscode',
  displayName: 'VS Code / GitHub Copilot',
  generate(cfg: SnippetConfig): Snippet {
    const doc = {
      servers: {
        'discord-mcp': {
          type: 'stdio',
          ...renderServerEntry({
            ...cfg,
            discordToken: cfg.discordToken ?? TOKEN_REFERENCE,
          }),
        },
      },
    };
    return {
      format: 'json',
      content: `${JSON.stringify(doc, null, 2)}\n`,
      configFilePath:
        'Workspace: <project>/.vscode/mcp.json\nUser-level: MCP: Open User Configuration',
      instructions:
        // biome-ignore lint/suspicious/noTemplateCurlyInString: native environment reference
        'Merge the discord-mcp entry into the `servers` object in `.vscode/mcp.json`, or run `MCP: Open User Configuration` for user scope. Preserve other servers and inputs. Launch VS Code with DISCORD_TOKEN set, restart the server through `MCP: List Servers`, and select its tools in Copilot Agent mode. The `${env:DISCORD_TOKEN}` reference reads the launch environment without saving the token.',
    };
  },
};
