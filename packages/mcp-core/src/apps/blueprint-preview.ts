import { BLUEPRINT_PREVIEW_HTML } from './blueprint-preview.generated.js';

export const BLUEPRINT_PREVIEW_RESOURCE_URI = 'ui://discord-mcp/blueprint-preview.html';
export const MCP_APPS_RESOURCE_MIME_TYPE = 'text/html;profile=mcp-app';

export const BLUEPRINT_PREVIEW_UI_META = {
  ui: {
    resourceUri: BLUEPRINT_PREVIEW_RESOURCE_URI,
    visibility: ['model'] as const,
  },
} as const;

export const BLUEPRINT_PREVIEW_RESOURCE_META = {
  ui: { csp: { connectDomains: [], resourceDomains: [] } },
} as const;

export interface BlueprintPreviewResource {
  readonly uri: string;
  readonly mimeType: string;
  readonly text: string;
  readonly _meta: typeof BLUEPRINT_PREVIEW_RESOURCE_META;
}

export function createBlueprintPreviewResource(): BlueprintPreviewResource {
  return {
    uri: BLUEPRINT_PREVIEW_RESOURCE_URI,
    mimeType: MCP_APPS_RESOURCE_MIME_TYPE,
    text: BLUEPRINT_PREVIEW_HTML,
    _meta: BLUEPRINT_PREVIEW_RESOURCE_META,
  };
}

export { BLUEPRINT_PREVIEW_HTML };
