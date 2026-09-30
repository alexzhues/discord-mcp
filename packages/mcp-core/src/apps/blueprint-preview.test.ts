import { describe, expect, it } from 'vitest';
import {
  BLUEPRINT_PREVIEW_HTML,
  BLUEPRINT_PREVIEW_RESOURCE_META,
  BLUEPRINT_PREVIEW_RESOURCE_URI,
  BLUEPRINT_PREVIEW_UI_META,
  createBlueprintPreviewResource,
} from './blueprint-preview.js';

describe('blueprint preview MCP App resource', () => {
  it('returns a stable self-contained MCP Apps resource', () => {
    const resource = createBlueprintPreviewResource();
    expect(resource).toEqual({
      uri: BLUEPRINT_PREVIEW_RESOURCE_URI,
      mimeType: 'text/html;profile=mcp-app',
      text: BLUEPRINT_PREVIEW_HTML,
      _meta: BLUEPRINT_PREVIEW_RESOURCE_META,
    });
    expect(resource.text).toContain('Content-Security-Policy');
    expect(resource.text).toContain('ui/initialize');
    expect(resource.text).toContain('ui/notifications/tool-result');
  });

  it('exposes only UI linkage metadata; apply remains a host request', () => {
    expect(BLUEPRINT_PREVIEW_UI_META).toEqual({
      ui: {
        resourceUri: BLUEPRINT_PREVIEW_RESOURCE_URI,
        visibility: ['model'],
      },
    });
    expect(BLUEPRINT_PREVIEW_HTML).not.toContain('__confirm:');
  });

  it('keeps the view offline and free of executable network dependencies', () => {
    expect(BLUEPRINT_PREVIEW_HTML).not.toMatch(/<script[^>]+src=/i);
    expect(BLUEPRINT_PREVIEW_HTML).not.toMatch(/<link[^>]+href=/i);
    expect(BLUEPRINT_PREVIEW_HTML).toContain("default-src 'none'");
  });
});
