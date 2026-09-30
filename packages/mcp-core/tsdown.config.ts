import { defineConfig } from 'tsdown';
import { createBlueprintPreviewVirtualPlugin } from './src/apps/build-preview.mjs';

export default defineConfig({
  plugins: [createBlueprintPreviewVirtualPlugin()],
  entry: ['src/index.ts'],
  format: 'esm',
  target: 'node20',
  outExtensions: () => ({ js: '.js', dts: '.d.ts' }),
  dts: true,
  sourcemap: true,
  clean: true,
  deps: {
    neverBundle: [
      '@modelcontextprotocol/server',
      '@discordjs/rest',
      '@sapphire/pieces',
      'pino',
      'zod',
      'discord-api-types',
    ],
  },
});
