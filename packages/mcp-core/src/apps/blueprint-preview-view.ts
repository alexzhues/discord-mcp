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
