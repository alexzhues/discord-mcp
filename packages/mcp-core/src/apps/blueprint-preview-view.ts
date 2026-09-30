/// <reference lib="dom" />
import { App } from '@modelcontextprotocol/ext-apps';

// biome-ignore lint/suspicious/noExplicitAny: the server output is validated by the tool schema before it reaches the view.
type PreviewData = Record<string, any>;
const root = document.getElementById('app')!;
const app = new App({ name: 'discord-mcp-blueprint-preview', version: '1.0.0' }, {});
const text = (value: unknown) => {
  const node = document.createElement('span');
  node.textContent = String(value ?? '');
  return node.innerHTML;
};
const list = (values: unknown[]) =>
  values.length
    ? `<ul>${values.map((value) => `<li>${text(typeof value === 'string' ? value : JSON.stringify(value))}</li>`).join('')}</ul>`
    : '<p class="muted">None reported</p>';
const countOrUnknown = (value: unknown) =>
  typeof value === 'number' && Number.isFinite(value) ? value : '—';

function render(data: PreviewData) {
  if (data.scope && Array.isArray(data.messages)) return renderContext(data);
  if (typeof data.id === 'string' && data.id.startsWith('wf_')) return renderWorkflow(data);
  if (Array.isArray(data.operations) && !data.blueprint && 'snapshot_id' in data)
    return renderChanges(data);
  if (Array.isArray(data.channels) && typeof data.user_id === 'string') return renderAccess(data);
  const blueprint = data.blueprint ?? {};
  const hasBlueprint = typeof blueprint.schema_version === 'string';
  const guild = blueprint.guild ?? {};
  const summary = data.summary ?? {};
  const verification = data.verification ?? {};
  const target = data.target ?? {};
  const blockers = Array.isArray(data.blockers)
    ? data.blockers
    : Array.isArray(verification.blockers)
      ? verification.blockers
      : [];
  const warnings = Array.isArray(data.warnings)
    ? data.warnings
    : Array.isArray(verification.warnings)
      ? verification.warnings
      : [];
  const status = String(data.status ?? 'unknown');
  const canRequestApply =
    status === 'ready' && blockers.length === 0 && typeof data.plan_id === 'string';
  root.innerHTML = `<h1>${text(guild.name || 'Discord blueprint preview')}</h1><p class="muted">${text(data.request || 'Target-bound, read-only plan')}</p>
    <div class="card"><span class="pill ${status === 'blocked' ? 'blocked' : 'ready'}">${text(status)}</span> <span class="muted">No Discord mutation was performed by this view.</span></div>
    <section class="card"><h2>Target and policy</h2><p>Guild: <b>${text(target.guild_id || 'unresolved')}</b> · Bot: <b>${text(target.bot_id || 'unresolved')}</b></p><p>Profile: ${text(blueprint.profile || 'unreported')} · Policy: ${text(blueprint.policy_version || 'unreported')}</p><p>Plan: <code>${text(data.plan_id || data.blueprint_id || 'unreported')}</code></p></section>
    <section class="card"><h2>Planned shape</h2><div class="grid"><div class="stat"><strong>${countOrUnknown(hasBlueprint && blueprint.roles?.length)}</strong><span class="muted">roles</span></div><div class="stat"><strong>${countOrUnknown(hasBlueprint && blueprint.categories?.length)}</strong><span class="muted">categories</span></div><div class="stat"><strong>${countOrUnknown(hasBlueprint && blueprint.channels?.length)}</strong><span class="muted">channels</span></div><div class="stat"><strong>${countOrUnknown(summary.total_operations)}</strong><span class="muted">operations</span></div><div class="stat"><strong>${countOrUnknown(summary.high_risk_operations)}</strong><span class="muted">high risk</span></div></div></section>
    <section class="card"><h2>Resources</h2><p><b>Roles</b></p>${list(((hasBlueprint && blueprint.roles) || []).map((item: PreviewData) => `${item.name} (${item.permissions?.join(', ') || 'no explicit permissions'})`))}<p><b>Channels</b></p>${list(((hasBlueprint && blueprint.channels) || []).map((item: PreviewData) => `${item.name} · ${item.type} · ${item.parent_key || 'no category'}`))}</section>
    <section class="card"><h2>Operations</h2>${list((data.operations || []).map((item: PreviewData) => `${item.summary || item.action || item.kind || 'operation'} · ${item.resource || item.key || 'target'}${item.risk === 'high' ? ' · high risk' : ''}`))}</section>
    <section class="card"><h2>Permission impact</h2><p>Bot missing: ${text((data.bot_permissions?.missing || []).join(', ') || 'none reported')}</p><p>Generated roles remain below bot: ${text(blueprint.bot_boundary?.generated_roles_must_remain_below_bot)}</p><p>Auto-grant permissions: ${text(blueprint.bot_boundary?.auto_grant_permissions)}</p></section>
    <section class="card"><h2>Verification and Activity Evidence</h2><p>Blueprint: ${text(verification.blueprint_validation || 'not reported')} · Target readback: ${text(verification.target_readback || verification.readback || 'not reported')}</p><p>Evidence status: ${text(data.status === 'verified' || data.status === 'drifted' ? data.status : 'not supplied')}</p><p>Evidence ID: ${text(data.evidence_id || 'not supplied')} · Completed operations: ${countOrUnknown(data.record?.observed?.completed_operation_ids?.length)}</p><p>Observed resources: roles ${countOrUnknown(verification.current_snapshot?.resources?.roles)}, categories ${countOrUnknown(verification.current_snapshot?.resources?.categories)}, channels ${countOrUnknown(verification.current_snapshot?.resources?.channels)}</p><p class="muted">The view reports only evidence returned by the server; it does not infer completion.</p></section>
    <section class="card"><h2>Blockers</h2>${list(blockers.map((item: PreviewData) => item && (item.message || item.code || item)))}</section>
    ${warnings.length ? `<section class="card"><h2>Warnings</h2>${list(warnings)}</section>` : ''}
    <section class="card"><h2>Next step</h2><p class="muted">This asks the host to continue the existing server workflow. Applying still requires explicit review and approval.</p><button id="request" ${canRequestApply ? '' : 'disabled'}>Request apply review</button></section>`;
  const button = document.getElementById('request') as HTMLButtonElement | null;
  if (button && canRequestApply)
    button.onclick = async () => {
      button.disabled = true;
      try {
        const result = await app.sendMessage({
          role: 'user',
          content: [
            {
              type: 'text',
              text: `Please review this exact blueprint plan and ask for explicit approval before applying it: ${data.plan_id}.`,
            },
          ],
        });
        if (result.isError) throw new Error('Host rejected the review request.');
        button.textContent = 'Review requested';
      } catch (error) {
        button.disabled = false;
        button.textContent = error instanceof Error ? error.message : 'Review request failed';
      }
    };
}

function reviewButton(id: string, label: string, message: string) {
  const button = document.getElementById(id) as HTMLButtonElement | null;
  if (!button) return;
  button.onclick = async () => {
    button.disabled = true;
    try {
      const result = await app.sendMessage({
        role: 'user',
        content: [{ type: 'text', text: message }],
      });
      if (result.isError) throw new Error('Host rejected the request.');
      button.textContent = 'Requested';
    } catch (error) {
      button.disabled = false;
      button.textContent = error instanceof Error ? error.message : label;
    }
  };
}

function renderChanges(data: PreviewData) {
  const ready =
    data.status === 'ready' && !data.blockers?.length && typeof data.plan_id === 'string';
  root.innerHTML = `<h1>Existing server changes</h1><p class="pill">${text(data.status)}</p>
    <p>Plan: <code>${text(data.plan_id)}</code></p>
    ${(data.operations || []).map((operation: PreviewData, index: number) => `<section class="card"><h2>${index + 1}. ${text(operation.kind)} · ${text(operation.resource_id)}</h2><div class="grid"><div><b>Before</b><pre>${text(JSON.stringify(operation.changed?.before ?? operation.before, null, 2))}</pre></div><div><b>After</b><pre>${text(JSON.stringify(operation.changed?.after ?? operation.after, null, 2))}</pre></div></div></section>`).join('')}
    <section class="card"><h2>Blockers</h2>${list(data.blockers || [])}<h2>Permission and configuration risks</h2>${list(data.risks || [])}</section>
    <p>Review the changes and member access report before applying.</p><button id="review-changes" ${ready ? '' : 'disabled'}>Request change review</button>`;
  if (ready)
    reviewButton(
      'review-changes',
      'Request change review',
      `Please review this exact existing-server change plan and request explicit approval before applying: ${data.plan_id}.`,
    );
}

function renderContext(data: PreviewData) {
  const coverage = data.coverage || {};
  root.innerHTML = `<h1>Conversation context</h1><p>Channel: <code>${text(data.scope.channel_id)}</code> · ${text(data.scope.scope)}</p>
    <p>${text(data.returned_count)} messages returned · ${text(data.scanned_count)} scanned · ${text(data.pages_scanned)} pages</p>
    <section class="card"><h2>Coverage</h2><p>${coverage.partial ? 'Partial context' : 'Bounded context'} · ${text(coverage.direction)}</p>${list(coverage.reasons || [])}<p>Next cursor: <code>${text(data.next_cursor || 'none')}</code></p></section>
    ${(data.messages || [])
      .map((message: PreviewData) => {
        const url = message.citation?.jump_url;
        const valid =
          typeof url === 'string' &&
          /^https:\/\/discord\.com\/channels\/(?:\d{17,20}|@me)\/\d{17,20}\/\d{17,20}$/.test(url);
        return `<article class="card"><h2>${text(message.author_name || message.author?.username || message.id)}</h2><p>${text(message.timestamp)}</p><pre>${text(message.content || '[No text content exposed]')}</pre>${message.reply_reference ? `<p>Reply: ${text(message.reply_reference.content || message.reply_reference.reason || message.reply_reference.message_id)}</p>` : ''}${valid ? `<a href="${text(url)}" target="_blank" rel="noopener noreferrer">Open source message</a>` : '<p class="muted">Source URL unavailable</p>'}</article>`;
      })
      .join('')}`;
}

function renderWorkflow(data: PreviewData) {
  root.innerHTML = `<h1>Background workflow</h1><p class="pill">${text(data.status)}</p><p>Operation: <code>${text(data.id)}</code></p>
    <section class="card"><h2>Progress</h2><p>${text(data.completed_steps)} / ${text(data.total_steps)} steps completed</p><progress max="${Number(data.total_steps) || 1}" value="${Number(data.completed_steps) || 0}"></progress><p>Updated: ${text(data.updated_at)}</p>${data.failure ? list([data.failure.code, data.failure.message]) : ''}</section>
    <button id="refresh-workflow">Refresh progress</button> <button id="resume-workflow">Request resume review</button> <button id="cancel-workflow">Request cancellation</button><p id="workflow-error" class="blocked"></p>`;
  reviewButton(
    'resume-workflow',
    'Request resume review',
    `Review the checkpoint and resume workflow ${data.id} only if its previous outcomes and original approvals permit it.`,
  );
  reviewButton(
    'cancel-workflow',
    'Request cancellation',
    `Cancel workflow ${data.id}. Report which steps completed; cancellation does not undo their effects.`,
  );
  const refresh = document.getElementById('refresh-workflow') as HTMLButtonElement;
  refresh.onclick = async () => {
    refresh.disabled = true;
    try {
      const result = await app.callServerTool({
        name: 'workflow_status',
        arguments: { id: data.id, target: data.target },
      });
      if (result.isError || !result.structuredContent)
        throw new Error('Could not refresh workflow progress.');
      render(result.structuredContent as PreviewData);
    } catch (error) {
      document.getElementById('workflow-error')!.textContent =
        error instanceof Error ? error.message : 'Refresh failed';
      refresh.disabled = false;
    }
  };
}

function renderAccess(data: PreviewData) {
  root.innerHTML = `<h1>Member access report</h1><p>Member: <code>${text(data.user_id)}</code> · Guild: <code>${text(data.guild_id)}</code></p><p>${data.complete ? 'Complete selected channel coverage' : 'Partial coverage'}</p>${list(data.warnings || [])}
    ${(data.channels || []).map((channel: PreviewData) => `<section class="card"><h2>${text(channel.name || channel.channel_id)}</h2><p>View: ${text(channel.view)} · Send: ${text(channel.send)} · Manage: ${text(channel.manage)}</p><p>${text(channel.reason)}</p></section>`).join('')}`;
}

app.ontoolresult = (result) => {
  if (result.isError) {
    const structured =
      result.structuredContent && typeof result.structuredContent === 'object'
        ? (result.structuredContent as PreviewData)
        : {};
    const detail = {
      ...structured,
      status: 'blocked',
      blockers:
        structured.code || structured.recovery_hint
          ? [{ message: [structured.code, structured.recovery_hint].filter(Boolean).join(': ') }]
          : structured.blockers || [
              { message: 'The server could not produce a blueprint preview.' },
            ],
    };
    render(detail);
    return;
  }
  if (result.structuredContent && typeof result.structuredContent === 'object')
    render(result.structuredContent as PreviewData);
};
app.ontoolinput = (input) => {
  if (!root.textContent?.trim() && input.arguments?.request)
    root.textContent = String(input.arguments.request);
};
void app.connect().catch((error) => {
  root.innerHTML = `<div class="card blocked"><h2>Preview unavailable</h2><p>${text(error instanceof Error ? error.message : 'The host could not initialize this preview.')}</p></div>`;
});
