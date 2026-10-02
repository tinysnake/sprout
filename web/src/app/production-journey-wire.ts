import type { TaskView } from '../../../src/web/views.ts';
import { feedTarget, type FeedSnapshot } from '../../../src/web/feed.ts';

/** Wire records only: every page still uses the actual production adapter. */
export function journeyWire() {
  const at = Date.now();
  const option = { id: 'option-a', engine: 'pi', workModel: 'journey-model', effort: 'high' };
  const project = {
    id: 'project-a', displayName: 'Journey Project A', status: 'active', memberIds: ['agent-a'],
    content: { currentVersion: 1, versions: [{ version: 1, at, reason: 'Created', goal: 'Exact Project goal A', rules: ['Portable facts'], completionGuidance: 'Inspect evidence', wakePolicy: 'explicit-only', routingIntervalMs: 30000, memberships: [
      { memberId: 'operator', memberKind: 'human', responsibilities: [], collaborationInstructions: '', startedAt: at },
      { memberId: 'agent-a', memberKind: 'agent', responsibilities: ['Verify'], collaborationInstructions: '', startedAt: at },
    ] }] }, createdAt: at, updatedAt: at,
  };
  const agent = { id: 'agent-a', displayName: 'Journey Agent A', status: 'active', workOptions: [option], configuration: { currentVersion: 1, versions: [{ version: 1, at, reason: 'Created', instructions: 'Exact Agent instructions A', options: [option] }] }, createdAt: at, updatedAt: at };
  const enrollment = { id: 'enroll-a', environmentInstanceId: 'instance-a', displayName: 'Journey Environment A', status: 'approved', platform: 'linux', identityDigest: 'test-digest', capabilityPermissions: { 'agent-run': true }, createdAt: at, updatedAt: at, decisions: [] };
  const readiness = { environmentInstanceId: 'instance-a', enrollmentStatus: 'approved', summary: { level: 'yellow', reason: 'Exact recovery reason A' }, connection: { state: 'online', lastConfirmedAt: at }, compatibility: { state: 'compatible' }, capabilities: [{ name: 'agent-run', permission: 'allowed', required: true }], engines: [{ engine: 'pi', installed: true, readiness: 'ready', required: true, models: { state: 'available', models: ['journey-model'] } }], workSafety: { state: 'recovery-required' } };
  const recovery = { id: 'recovery-a', environmentInstanceId: 'instance-a', leaseId: 'lease-a', holderKind: 'task', taskId: 'task-a', cause: 'worker-channel-lost', phase: 'recovery', startedAt: at, updatedAt: at, unresolvedFacts: ['Exact retained evidence A'], evidenceSynchronized: false, decisions: [] };
  const task: TaskView = { id: 'task-a', projectId: project.id, title: 'Journey Task A', goal: 'Exact Task goal A', constraints: ['Exact constraint A'], status: 'in-progress', admission: { proposalId: 'proposal-a', proposalRevision: 1, contentVersion: 1, validationCriteria: ['Exact validation A'], lead: { memberId: agent.id, memberKind: 'agent' }, contextAgentId: agent.id, approvedBy: { memberId: 'operator', memberKind: 'human' }, approvedAt: at, approvalReason: 'Approved' }, environmentInstanceId: 'instance-a', environmentLeaseId: 'lease-a', environmentLifecycleState: 'recovery', taskContextState: 'recovery-retained', createdAt: at, updatedAt: at };
  const run = { id: 'run-a', agentId: agent.id, projectId: project.id, taskId: task.id, status: 'completed', createdAt: at, workOption: { ...option, configurationVersion: 1 } };
  const taskRun = { runId: run.id, agentId: agent.id, sequence: 1, linkedAt: at, contentVersion: 1, actor: { memberId: agent.id, memberKind: 'agent' } };
  const messages = [{ id: 'message-a', scopeId: 'channel-a', projectId: project.id, authorId: 'operator', authorKind: 'human', body: 'Exact Chat message A', createdAt: at }];
  const scope = { id: 'channel-a', projectId: project.id, kind: 'project', createdAt: at, updatedAt: at };
  const activity = { id: 'usage-a', kind: 'agent_run', status: 'completed', engine: 'pi', model: 'journey-model', createdAt: at, settledAt: at, wallDurationMs: 1234, correlation: { runId: run.id, projectId: project.id, agentId: agent.id, taskId: task.id } };
  const aggregate = { totalActivities: 1, tokens: {}, tokenCoverage: { complete: 0, partial: 0, unavailable: 1 }, cost: { byProvenance: {} }, costCoverage: { available: 0, pending: 0, unavailable: 1 }, billedCost: { status: 'unavailable' }, activityIdentities: [{ activityId: activity.id, kind: activity.kind, status: activity.status, runId: run.id }] };
  const targets = [
    feedTarget({ surface: 'project-chat', projectId: project.id }),
    feedTarget({ surface: 'environment-detail', environmentId: enrollment.id }),
    feedTarget({ surface: 'agent-detail', agentId: agent.id }),
    feedTarget({ surface: 'project-overview', projectId: project.id }),
    feedTarget({ surface: 'project-task-detail', projectId: project.id, taskId: task.id }),
  ];
  const feed: FeedSnapshot = { scopes: [{ id: 'feed:all', kind: 'all', label: 'All Projects', attentionCount: 0 }, { id: project.id, kind: 'project', label: project.displayName, attentionCount: 0 }], attention: [], inFlight: [], activity: targets.map((target, i) => ({ id: `journey-${i}`, kind: 'message', summary: `Exact Feed destination ${i}`, scopes: [project.id], target, at })) };
  let sessions = [{ id: 'session-current', current: true, createdAt: at, lastSeenAt: at, absoluteExpiresAt: at + 86400000, idleExpiresAt: at + 3600000 }, { id: 'session-other', current: false, createdAt: at, lastSeenAt: at, absoluteExpiresAt: at + 86400000, idleExpiresAt: at + 3600000 }];
  const unknown: string[] = [];
  let authorized = true;
  return {
    project, agent, enrollment, task, taskRun, feed, messages, unknown,
    expire() { authorized = false; },
    async respond(input: string, init?: RequestInit): Promise<Response> {
      const url = new URL(input, 'http://journey.invalid');
      const path = url.pathname;
      const projectPath = '/api/projects/' + encodeURIComponent(project.id);
      const environmentPath = '/api/environments/enrollments/' + encodeURIComponent(enrollment.id);
      const method = init?.method ?? 'GET';
      let body: unknown;
      let status = 200;
      if (!authorized && path !== '/api/auth/session') return new Response('{}', { status: 401 });
      if (path === '/api/auth/session' && method === 'POST') { authorized = true; body = { csrfToken: 'journey-test-proof' }; }
      else if (path === '/api/auth/sessions') body = { sessions, csrfToken: 'journey-test-proof' };
      else if (path === '/api/auth/sessions/session-other/revoke') { sessions = sessions.filter(s => s.current); body = { revoked: true }; }
      else if (path === '/api/projects/authorities') body = { projects: [project] };
      else if (path === projectPath) body = { project };
      else if (path === projectPath + '/access') body = { access: [{ projectId: project.id, environmentInstanceId: 'instance-a', status: 'active', startedAt: at, updatedAt: at, current: { bindingId: 'binding-a', workspaceId: 'workspace-a', kind: 'relative', path: 'repos/journey', boundAt: at }, history: [] }] };
      else if (path === '/api/agents') body = { agents: [agent] };
      else if (path === '/api/agents/agent-a') body = { agent };
      else if (path === '/api/agents/agent-a/compatibility') body = { agentId: agent.id, environmentInstanceId: 'instance-a', available: true, firstAvailable: option, options: [{ option, state: 'available', reason: 'Exact compatible option A' }] };
      else if (path === '/api/environments/enrollments') body = { enrollments: [enrollment] };
      else if (path === environmentPath) body = { enrollment };
      else if (path === environmentPath + '/readiness') body = { readiness, probes: [] };
      else if (path === environmentPath + '/recovery') body = { recovery: [recovery], forceReleases: [] };
      else if (path === '/api/tasks') body = { tasks: [task] };
      else if (path === '/api/tasks/task-a') body = { task, runs: [taskRun] };
      else if (path === projectPath + '/task-proposals') body = { proposals: [] };
      else if (path === '/api/runs') body = { runs: [run] };
      else if (path === '/api/projects/project-a/scopes') body = { scopes: [scope] };
      else if (path === '/api/scopes/channel-a') body = { scope, state: { scopeId: scope.id, writable: true }, context: { scopeId: scope.id, projectId: project.id, kind: 'project', project: { contentVersion: 1, goal: 'Exact Chat context A', rules: [] } } };
      else if (path === '/api/messages') body = { messages };
      else if (path === '/api/projects/project-a/routing-batches') body = { batches: [] };
      else if (path === '/api/projects/project-a/events') body = { events: [] };
      else if (path === '/api/feed') body = feed;
      else if (path === '/api/usage/activities') body = { activities: [activity] };
      else if (path === '/api/usage/activities/usage-a') body = { activity, observations: [], supersessionHistory: [] };
      else if (path.startsWith('/api/usage/')) body = aggregate;
      else if (path === '/api/operator/diagnostics') body = { format: 1, scope: 'web', versions: { sprout: 'journey-version', web: 'journey-version', worker: 'journey-version', workerProtocol: { minMajor: 2, maxMajor: 2 } }, schema: 24, service: 'running', data: 'accessible', environments: [], events: [] };
      else if (path === '/api/operator/settings') body = { versions: { sprout: 'journey-version', web: 'journey-version', worker: 'journey-version', workerProtocol: { minMajor: 2, maxMajor: 2 } }, session: { authenticated: true, activeCount: sessions.length }, access: { boundary: 'private-network-and-authentication', publicInternetSupported: false }, responsibilities: { web: ['sessions'], hostLocal: ['credentials'] } };
      else if (/^\/api\/(agents|projects|environments\/enrollments)\//.test(path)) { body = { error: 'Record not found' }; status = 404; }
      else { unknown.push(path); body = { error: 'Unimplemented wire route' }; status = 404; }
      return new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });
    },
  };
}
