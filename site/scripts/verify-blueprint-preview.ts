import { chromium, type FrameLocator, type Page } from 'playwright';
import { buildBlueprintPreviewHtml } from '../../packages/mcp-core/src/apps/build-preview.mjs';

const screenshotDir = `${process.env.TEMP ?? process.env.TMP ?? '.'}`;
const screenshots = {
  desktopReady: `${screenshotDir}/discord-mcp-blueprint-preview-desktop-ready.png`,
  desktopEvidence: `${screenshotDir}/discord-mcp-blueprint-preview-desktop-evidence.png`,
  mobile: `${screenshotDir}/discord-mcp-blueprint-preview-mobile.png`,
};
const planId = `sha256:${'a'.repeat(64)}`;
type HostMessage = {
  readonly method?: string;
  readonly params?: { readonly content?: ReadonlyArray<{ readonly text?: string }> };
};

function assert(condition: unknown, message: string): asserts condition {
  if (!condition) throw new Error(`Blueprint preview QA failed: ${message}`);
}

async function createHost(page: Page, html: string, width: number, height: number) {
  const externalRequests: string[] = [];
  page.on('request', (request) => {
    if (/^https?:/i.test(request.url())) externalRequests.push(request.url());
  });
  await page.setViewportSize({ width, height });
  await page.setContent('<iframe id="view" style="width:100%;height:100%;border:0"></iframe>');
  await page.evaluate(() => {
    const host = window as unknown as Window & {
      hostMessages: Array<Record<string, unknown>>;
      rejectNext?: boolean;
    };
    host.hostMessages = [];
    window.addEventListener('message', (event) => {
      const message = event.data;
      host.hostMessages.push(message);
      if (message?.method === 'ui/initialize') {
        event.source?.postMessage(
          {
            jsonrpc: '2.0',
            id: message.id,
            result: {
              protocolVersion: '2026-01-26',
              hostCapabilities: { serverTools: {} },
              hostContext: {},
              hostInfo: { name: 'discord-mcp-qa-host', version: '1.0.0' },
            },
          },
          { targetOrigin: '*' },
        );
      }
      if (message?.method === 'ui/message') {
        event.source?.postMessage(
          { jsonrpc: '2.0', id: message.id, result: host.rejectNext ? { isError: true } : {} },
          { targetOrigin: '*' },
        );
      }
      if (message?.method === 'tools/call') {
        event.source?.postMessage(
          {
            jsonrpc: '2.0',
            id: message.id,
            result: {
              content: [],
              structuredContent: {
                id: 'wf_' + 'a'.repeat(32),
                status: 'completed',
                target: { profile_id: 'qa' },
                completed_steps: 2,
                total_steps: 2,
                updated_at: '2026-10-01T00:00:00Z',
              },
            },
          },
          { targetOrigin: '*' },
        );
      }
    });
  });
  await page.locator('#view').evaluate((element, source) => {
    (element as HTMLIFrameElement).srcdoc = source;
  }, html);
  await page.waitForFunction(() => {
    const messages =
      (window as Window & { hostMessages?: Array<{ method?: string }> }).hostMessages ?? [];
    return messages.some((message) => message.method === 'ui/notifications/initialized');
  });
  return externalRequests;
}

async function postToolResult(page: Page, result: Record<string, unknown>, expectedText?: string) {
  await page.evaluate((message) => {
    const view = document.getElementById('view') as HTMLIFrameElement | null;
    view?.contentWindow?.postMessage(
      { jsonrpc: '2.0', method: 'ui/notifications/tool-result', params: message },
      { targetOrigin: '*' },
    );
  }, result);
  if (expectedText) await frame(page).getByText(expectedText, { exact: false }).waitFor();
}

function frame(page: Page): FrameLocator {
  return page.locator('#view').contentFrame();
}

const html = await buildBlueprintPreviewHtml();
const browser = await chromium.launch({ headless: true });
const assertions: string[] = [];
const check = (condition: unknown, message: string) => {
  assert(condition, message);
  assertions.push(message);
};

try {
  const desktop = await browser.newPage();
  const desktopRequests = await createHost(desktop, html, 1200, 900);
  check(
    await desktop.evaluate(() =>
      ((window as Window & { hostMessages?: Array<{ method?: string }> }).hostMessages ?? []).some(
        (message) => message.method === 'ui/initialize',
      ),
    ),
    'host observes App SDK initialize handshake',
  );
  await postToolResult(
    desktop,
    {
      content: [],
      structuredContent: {
        status: 'ready',
        plan_id: planId,
        target: { guild_id: 'guild-1', bot_id: 'bot-1' },
        blueprint: {
          schema_version: 'guild_blueprint.v1',
          guild: { name: '<img src=x onerror=window.__xss=1>' },
          roles: [{ name: 'Moderator', permissions: ['MANAGE_MESSAGES'] }],
          categories: [{ name: 'Community' }],
          channels: [{ name: 'general', type: 'text' }],
          bot_boundary: {},
        },
        summary: { total_operations: 2, high_risk_operations: 1 },
        operations: [{ summary: 'Create channel', risk: 'high' }],
        verification: {},
        blockers: [],
        warnings: [],
        plan_ref: 'fake-plan-ref',
        plan_token: 'fake-plan-token',
        approval_id: 'fake-approval-id',
      },
    },
    'ready',
  );
  check(desktopRequests.length === 0, 'preview makes no external network requests');
  check(await frame(desktop).getByRole('button').isEnabled(), 'ready enables button');
  check(
    await desktop.locator('#view').evaluate((element) => {
      const document = (element as HTMLIFrameElement).contentDocument;
      return (
        !!document && document.documentElement.scrollWidth <= document.documentElement.clientWidth
      );
    }),
    'desktop digest does not overflow horizontally',
  );
  const readyText = await desktop
    .locator('#view')
    .evaluate((element) => (element as HTMLIFrameElement).contentDocument?.body.innerText ?? '');
  check(
    readyText.includes('<img src=x onerror=window.__xss=1>'),
    'untrusted guild name is rendered as text',
  );
  check(
    await desktop
      .locator('#view')
      .evaluate(
        (element) =>
          ((element as HTMLIFrameElement).contentWindow as Window & { __xss?: number }).__xss ===
          undefined,
      ),
    'untrusted guild name does not execute as script',
  );
  check(
    !readyText.includes('fake-plan-token') && !readyText.includes('fake-approval-id'),
    'private plan credentials are not rendered',
  );
  await desktop.screenshot({ path: screenshots.desktopReady });
  await desktop.evaluate(() => {
    (window as Window & { rejectNext?: boolean }).rejectNext = true;
  });
  await frame(desktop).getByRole('button').click();
  await frame(desktop).getByRole('button', { name: 'Host rejected the review request.' }).waitFor();
  check(
    await frame(desktop).getByRole('button').isEnabled(),
    'host rejection re-enables review button',
  );
  const message = await desktop.evaluate(() =>
    (window as Window & { hostMessages?: HostMessage[] }).hostMessages?.find(
      (item) => item?.method === 'ui/message',
    ),
  );
  const sentText = message?.params?.content?.[0]?.text ?? '';
  check(
    sentText.includes(planId) &&
      !sentText.includes('__confirm') &&
      !sentText.includes('fake-plan-token') &&
      !sentText.includes('fake-approval-id'),
    'button sends plan-only review message',
  );
  await postToolResult(
    desktop,
    {
      content: [],
      structuredContent: {
        status: 'verified',
        evidence_id: 'sha256:evidence1',
        verification: {
          current_snapshot: { resources: { roles: 3, categories: 2, channels: 7 } },
          blockers: [{ message: 'No current blocker' }],
          warnings: ['Snapshot was read back.'],
        },
        record: { observed: { completed_operation_ids: ['a'] } },
      },
    },
    'roles 3',
  );
  const evidenceText = await desktop
    .locator('#view')
    .evaluate((element) => (element as HTMLIFrameElement).contentDocument?.body.innerText ?? '');
  check(
    evidenceText.includes('roles 3') &&
      evidenceText.includes('categories 2') &&
      evidenceText.includes('channels 7'),
    'evidence-only counts render',
  );
  check(
    !evidenceText.includes('guild_blueprint_activity_evidence.v1'),
    'schema version is not evidence ID',
  );
  check(evidenceText.includes('Snapshot was read back.'), 'evidence warnings render');
  await desktop.screenshot({ path: screenshots.desktopEvidence });
  await postToolResult(
    desktop,
    {
      content: [],
      isError: true,
      structuredContent: { code: 'BOT_MISMATCH', recovery_hint: 'Select profile' },
    },
    'BOT_MISMATCH',
  );
  const errorText = await desktop
    .locator('#view')
    .evaluate((element) => (element as HTMLIFrameElement).contentDocument?.body.innerText ?? '');
  check(
    errorText.includes('BOT_MISMATCH') && errorText.includes('Select profile'),
    'error code and recovery hint render',
  );
  await postToolResult(
    desktop,
    {
      content: [],
      structuredContent: {
        status: 'ready',
        plan_id: planId,
        snapshot_id: planId,
        blockers: [],
        risks: ['Permissions change'],
        plan_ref: 'private-change-ref',
        approval_id: 'private-change-approval',
        operations: [
          {
            kind: 'channel_patch',
            resource_id: '111111111111111111',
            before: { name: 'old', topic: 'keep' },
            after: { name: '<img src=x onerror=window.__xss=1>', topic: 'keep' },
          },
        ],
      },
    },
    'Existing server changes',
  );
  const changeText = await frame(desktop).locator('body').innerText();
  check(
    changeText.includes('Before') && changeText.includes('After') && changeText.includes('keep'),
    'existing changes show before and after',
  );
  check(
    !changeText.includes('private-change-ref') && !changeText.includes('private-change-approval'),
    'change preview omits private plan credentials',
  );
  check(
    await frame(desktop).getByRole('button', { name: 'Request change review' }).isEnabled(),
    'ready change plan requests host review',
  );

  await postToolResult(
    desktop,
    {
      content: [],
      structuredContent: {
        scope: { channel_id: '111111111111111111', scope: 'thread' },
        returned_count: 2,
        scanned_count: 4,
        pages_scanned: 1,
        coverage: { partial: true, direction: 'older', reasons: ['Unreadable reply'] },
        next_cursor: '222222222222222222',
        messages: [
          {
            id: '222222222222222222',
            content: '<script>window.__xss=2</script>',
            citation: {
              jump_url:
                'https://discord.com/channels/333333333333333333/111111111111111111/222222222222222222',
            },
          },
          {
            id: '444444444444444444',
            content: 'unsafe link',
            citation: { jump_url: 'javascript:alert(1)' },
          },
        ],
      },
    },
    'Conversation context',
  );
  check(
    (await frame(desktop).getByRole('link').count()) === 1,
    'context allows only canonical Discord citation links',
  );
  check(
    (await frame(desktop).locator('body').innerText()).includes('<script>window.__xss=2</script>'),
    'conversation content is escaped text',
  );
  check(
    (await frame(desktop).locator('body').innerText()).includes('Partial context'),
    'context shows incomplete coverage',
  );

  await postToolResult(
    desktop,
    {
      content: [],
      structuredContent: {
        id: 'wf_' + 'a'.repeat(32),
        status: 'running',
        target: { profile_id: 'qa' },
        completed_steps: 1,
        total_steps: 2,
        updated_at: '2026-10-01T00:00:00Z',
      },
    },
    'Background workflow',
  );
  await frame(desktop).getByRole('button', { name: 'Refresh progress' }).click();
  await frame(desktop).getByText('2 / 2 steps completed').waitFor();
  check(
    (await frame(desktop).locator('body').innerText()).includes('completed'),
    'workflow refresh uses read-only status tool',
  );
  check(desktopRequests.length === 0, 'all operation views remain offline');
  await desktop.close();

  const mobile = await browser.newPage();
  const mobileRequests = await createHost(mobile, html, 390, 844);
  check(mobileRequests.length === 0, 'mobile preview makes no external network requests');
  await postToolResult(
    mobile,
    {
      content: [],
      structuredContent: {
        status: 'ready',
        plan_id: planId,
        target: { guild_id: 'guild-1', bot_id: 'bot-1' },
        blueprint: {
          schema_version: 'guild_blueprint.v1',
          guild: { name: 'Mobile QA' },
          roles: [],
          categories: [],
          channels: [],
        },
        blockers: [],
        verification: {},
      },
    },
    'Mobile QA',
  );
  check(await frame(mobile).getByRole('button').isEnabled(), 'mobile ready enables button');
  check(
    await mobile.locator('#view').evaluate((element) => {
      const document = (element as HTMLIFrameElement).contentDocument;
      return (
        !!document && document.documentElement.scrollWidth <= document.documentElement.clientWidth
      );
    }),
    'mobile digest does not overflow horizontally',
  );
  await postToolResult(
    mobile,
    {
      content: [],
      structuredContent: {
        status: 'blocked',
        blueprint: {},
        blockers: [{ message: 'Review required' }],
        verification: {},
      },
    },
    'Review required',
  );
  check(await frame(mobile).getByRole('button').isDisabled(), 'blocked disables button');
  check(
    await mobile.locator('#view').evaluate((element) => {
      const document = (element as HTMLIFrameElement).contentDocument;
      return (
        !!document && document.documentElement.scrollWidth <= document.documentElement.clientWidth
      );
    }),
    'mobile layout does not overflow horizontally',
  );
  await mobile.screenshot({ path: screenshots.mobile });
  await mobile.close();
} finally {
  await browser.close();
}

console.log(JSON.stringify({ assertions, screenshots }, null, 2));
