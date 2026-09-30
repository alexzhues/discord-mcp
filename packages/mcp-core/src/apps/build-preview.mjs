import { fileURLToPath } from 'node:url';
import { build } from 'esbuild';

export const BLUEPRINT_PREVIEW_GENERATED_MODULE = './blueprint-preview.generated.js';

export async function buildBlueprintPreviewHtml() {
  const result = await build({
    absWorkingDir: fileURLToPath(new URL('../..', import.meta.url)),
    entryPoints: ['src/apps/blueprint-preview-view.ts'],
    bundle: true,
    format: 'iife',
    platform: 'browser',
    write: false,
    minify: true,
  });
  const css = `<style>:root{color-scheme:light dark;--bg:#fff;--fg:#17202a;--muted:#68727d;--card:#f3f5f7;--line:#d9dee5;--accent:#5865f2;--danger:#b42318;--ok:#087443}@media(prefers-color-scheme:dark){:root{--bg:#15171a;--fg:#eef1f4;--muted:#a8b0ba;--card:#20242a;--line:#343a43;--accent:#8d96ff;--danger:#ff9b91;--ok:#72d6a5}}*{box-sizing:border-box}body{margin:0;padding:16px;background:var(--bg);color:var(--fg);font:14px/1.45 system-ui,sans-serif}main{max-width:860px;margin:auto}h1{font-size:20px;margin:0 0 4px}h2{font-size:15px;margin:0 0 10px}.muted{color:var(--muted)}.grid{display:grid;grid-template-columns:repeat(auto-fit,minmax(170px,1fr));gap:8px}.card{background:var(--card);border:1px solid var(--line);border-radius:10px;padding:11px;margin:10px 0}.stat strong{display:block;font-size:20px}.pill{display:inline-block;border-radius:99px;padding:2px 8px;background:var(--card);border:1px solid var(--line);font-size:12px}.ready{color:var(--ok)}.blocked{color:var(--danger)}ul{padding-left:20px}code{overflow-wrap:anywhere;word-break:break-word}button{border:0;border-radius:7px;padding:9px 12px;background:var(--accent);color:white;font-weight:650;cursor:pointer}button:disabled{opacity:.55}</style>`;
  const script = new TextDecoder().decode(result.outputFiles[0].contents);
  return `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><meta http-equiv="Content-Security-Policy" content="default-src 'none';style-src 'unsafe-inline';script-src 'unsafe-inline';img-src data:">${css}</head><body><main id="app">Waiting for a blueprint result…</main><script>${script}</script></body></html>`;
}

/** tsdown/Vitest plugin for the generated HTML module; no vendor bundle is checked in. */
export function createBlueprintPreviewVirtualPlugin() {
  const virtualId = `\0discord-mcp/${BLUEPRINT_PREVIEW_GENERATED_MODULE}`;
  return {
    name: 'discord-mcp-blueprint-preview-html',
    enforce: 'pre',
    resolveId(source) {
      return source === BLUEPRINT_PREVIEW_GENERATED_MODULE ? virtualId : undefined;
    },
    async load(id) {
      if (id !== virtualId) return undefined;
      return `export const BLUEPRINT_PREVIEW_HTML = ${JSON.stringify(await buildBlueprintPreviewHtml())};`;
    },
  };
}
