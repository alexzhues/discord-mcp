import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { ALL_GENERATORS } from '../../packages/mcp-server/src/lib/client-snippets/index.js';

const ROOT = join(fileURLToPath(new URL('.', import.meta.url)), '../..');

describe('client documentation stays aligned with the generator registry', () => {
  it('documents every registered client in both tab pages and the CLI reference', () => {
    const component = readFileSync(join(ROOT, 'site/src/components/docs/ClientTabs.astro'), 'utf8');
    const setup = readFileSync(join(ROOT, 'site/src/content/docs/start/client-setup.mdx'), 'utf8');
    const index = readFileSync(join(ROOT, 'site/src/content/docs/index.mdx'), 'utf8');
    const cli = readFileSync(join(ROOT, 'site/src/content/docs/reference/cli.mdx'), 'utf8');
    const clientOptions = cli
      .split('\n')
      .filter((line) => line.startsWith('| `--client <id>`') && line.includes('prompt if TTY'));
    expect(clientOptions).toHaveLength(2);

    for (const { id } of ALL_GENERATORS) {
      expect(component, `missing tab for ${id}`).toContain(`slot name="${id}"`);
      expect(setup, `missing setup slot for ${id}`).toContain(`slot="${id}"`);
      expect(index, `missing home slot for ${id}`).toContain(`slot="${id}"`);
      expect(setup, `missing setup command for ${id}`).toContain(`--client ${id}`);
      expect(index, `missing home command for ${id}`).toContain(`--client ${id}`);
      for (const option of clientOptions) {
        expect(option, `missing CLI client option for ${id}`).toContain(`\`${id}\``);
      }
    }
  });
});
