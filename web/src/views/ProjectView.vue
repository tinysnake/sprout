<script setup lang="ts">
import { ref } from 'vue';
import Icon from '../primitives/Icon.vue';
import Button from '../primitives/Button.vue';
import Badge from '../primitives/Badge.vue';
import StatusDot from '../primitives/StatusDot.vue';
import StatusPill from '../primitives/StatusPill.vue';

const selectedProjectId = ref('sprout-m2');
const activeTab = ref<'overview' | 'tasks' | 'chat'>('overview');
const activeChatChannel = ref('#general');

const projects = [
  { id: 'sprout-m2', name: 'Sprout M2 Operator', desc: 'Local multi-agent collaboration and environment-scheduling platform', status: 'Active' },
  { id: 'minesweeper', name: 'o7 Minesweeper Game', desc: 'Deterministic puzzle game testbed with agent validation harnesses', status: 'Active' },
  { id: 'tooling', name: 'Dev Pipeline Tooling', desc: 'Host orchestration, carrier overlay, and verification CLI', status: 'Maintenance' },
];

const currentProject = ref(projects[0]);

const projectMembers = [
  { id: 'agent-prog', name: 'Programmer', role: 'Lead Implementation Engineer', engine: 'Pi / Gemini 2.5', status: 'Active' },
  { id: 'agent-arch', name: 'Architect', role: 'System & Seams Architect', engine: 'Codex / GPT-5', status: 'Active' },
  { id: 'agent-fore', name: 'Foreman', role: 'Run Orchestrator & Coordinator', engine: 'Pi / Claude 3.7', status: 'Active' },
  { id: 'agent-res', name: 'Researcher', role: 'Primary Source & Baseline Analyst', engine: 'agy / DeepCode', status: 'Active' },
];

const boundWorkspaces = [
  { root: 'sprout-workspace', relPath: 'repos/sprout', host: 'Mac Studio M2 Max', status: 'Prepared & Ready' },
  { root: 'sprout-win-workspace', relPath: 'work/sprout', host: 'Windows Workstation 01', status: 'Lease Recovery' },
];

const tasks = [
  {
    id: '101',
    title: 'Refactor Environment State Manager into Decoupled Seams',
    stage: 'Active',
    stageVariant: 'success' as const,
    lead: 'Programmer',
    host: 'Mac Studio M2 Max',
    version: 'v2',
    lifecycleSentence: 'Task active · Run #2 running · Lease held exclusively',
  },
  {
    id: '104',
    title: 'Multi-Agent Simulation Validation & Host Porting',
    stage: 'Recovery',
    stageVariant: 'danger' as const,
    lead: 'Architect',
    host: 'Windows Workstation 01',
    version: 'v1',
    lifecycleSentence: 'Task recovery · Interrupted run #206 · Unresolved facts pending',
  },
  {
    id: '107',
    title: 'Validate Reka UI Headless Accessible Overlays & Focus Trap',
    stage: 'Validation',
    stageVariant: 'warning' as const,
    lead: 'Foreman',
    host: 'Local Worker',
    version: 'v3',
    lifecycleSentence: 'Task awaiting validation · 8 tests passing · Human decision required',
  },
  {
    id: '110',
    title: 'CSS-first Theme Variable Ladder for Comfortable & Compact Density',
    stage: 'Proposed',
    stageVariant: 'secondary' as const,
    lead: 'Researcher',
    host: 'Unassigned',
    version: 'v1',
    lifecycleSentence: 'Task proposed · Holds no lease · Awaiting Begin',
  },
  {
    id: '98',
    title: 'Audit M1 Baseline Seams & SQLite Transactional Safety',
    stage: 'Completed',
    stageVariant: 'info' as const,
    lead: 'Architect',
    host: 'Mac Studio M2 Max',
    version: 'v4',
    lifecycleSentence: 'Task completed · Safe task end · Lease released cleanly',
  },
];

const messages = [
  {
    id: 'm1',
    author: 'Foreman',
    role: 'Orchestrator',
    time: '10:14 AM',
    text: 'Opened Run scope #70. Initiating Ticket #74 vertical slice validation for Vue production Web foundation.',
  },
  {
    id: 'm2',
    author: 'Programmer',
    role: 'Lead Implementation',
    time: '10:15 AM',
    text: 'Allocated port block 41010-41019. Installed Vue 3.5.43, Tailwind CSS 4, and Reka UI with zero peer warnings. Verifying master/detail and 6 dimensions on Manage / Environments.',
  },
  {
    id: 'm3',
    author: 'Architect',
    role: 'System Architect',
    time: '10:18 AM',
    text: 'Confirmed ADR-0005 task-held lease safety. Emergency Force Release strictly retains the 3-gate human confirmation and does not preempt active leases.',
  },
  {
    id: 'm4',
    author: 'Programmer',
    role: 'Lead Implementation',
    time: '10:22 AM',
    text: 'All 541 tests passing. Server active on port 41010. Ready for Human review.',
  },
];
</script>

<template>
  <div class="projects-view flex flex-col h-full bg-[var(--bg-app)]">
    <!-- Top Project Header & Selector -->
    <div class="px-4 py-3 bg-[var(--bg-surface)] border-b border-[var(--border-subtle)] flex items-center justify-between gap-4 flex-wrap">
      <div class="flex items-center gap-3">
        <div class="p-1.5 rounded bg-[var(--accent-bg)] text-[var(--accent-primary)]">
          <Icon name="project" :size="18" />
        </div>
        <div>
          <div class="flex items-center gap-2">
            <select
              v-model="selectedProjectId"
              class="font-bold text-sm text-[var(--text-primary)] bg-transparent border-0 focus:ring-0 cursor-pointer pr-4"
            >
              <option v-for="p in projects" :key="p.id" :value="p.id">
                {{ p.name }}
              </option>
            </select>
            <Badge variant="success">Active</Badge>
          </div>
          <span class="text-[11px] text-[var(--text-muted)] block">
            {{ currentProject.desc }}
          </span>
        </div>
      </div>

      <!-- Tab Switcher -->
      <div class="flex items-center gap-1 bg-[var(--bg-surface-elevated)] p-1 rounded-md border border-[var(--border-subtle)]" role="tablist">
        <button
          type="button"
          class="px-3 py-1 rounded text-xs font-semibold transition-colors cursor-pointer"
          :class="activeTab === 'overview' ? 'bg-[var(--accent-primary)] text-[var(--text-inverse)]' : 'text-[var(--text-secondary)] hover:text-[var(--text-primary)]'"
          role="tab"
          :aria-selected="activeTab === 'overview'"
          @click="activeTab = 'overview'"
        >
          Overview
        </button>
        <button
          type="button"
          class="px-3 py-1 rounded text-xs font-semibold transition-colors cursor-pointer"
          :class="activeTab === 'tasks' ? 'bg-[var(--accent-primary)] text-[var(--text-inverse)]' : 'text-[var(--text-secondary)] hover:text-[var(--text-primary)]'"
          role="tab"
          :aria-selected="activeTab === 'tasks'"
          @click="activeTab = 'tasks'"
        >
          Tasks ({{ tasks.length }})
        </button>
        <button
          type="button"
          class="px-3 py-1 rounded text-xs font-semibold transition-colors cursor-pointer"
          :class="activeTab === 'chat' ? 'bg-[var(--accent-primary)] text-[var(--text-inverse)]' : 'text-[var(--text-secondary)] hover:text-[var(--text-primary)]'"
          role="tab"
          :aria-selected="activeTab === 'chat'"
          @click="activeTab = 'chat'"
        >
          Chat (#general)
        </button>
      </div>
    </div>

    <!-- Main Tab Content Area -->
    <div class="flex-1 overflow-y-auto p-4 sm:p-6 max-w-6xl mx-auto w-full">
      <!-- 1. Overview Tab -->
      <div v-if="activeTab === 'overview'" class="flex flex-col gap-6">
        <!-- Goal & Collaboration Contract -->
        <div class="p-4 rounded-[var(--radius-md)] border border-[var(--border-subtle)] bg-[var(--bg-surface)] flex flex-col gap-3">
          <h3 class="text-xs uppercase tracking-wider font-bold text-[var(--text-muted)] flex items-center justify-between">
            <span>Project Collaboration Agreement (AGENTS.md)</span>
            <span class="text-[10px] text-[var(--text-secondary)] font-mono">Wake policy: Explicit + Mentions</span>
          </h3>
          <p class="text-xs text-[var(--text-primary)] leading-relaxed">
            Project goal: build, validate, and verify the Sprout M2 Local Operator platform. Multi-agent execution uses task-held leases under ADR-0005, preserving uncommitted host state across runs and interruptions.
          </p>
          <div class="p-2.5 rounded bg-[var(--bg-surface-elevated)] border border-[var(--border-subtle)] text-[11px] font-mono text-[var(--text-secondary)]">
            Precedence rule: Project conventions > Agent-specific instructions > Global defaults.
          </div>
        </div>

        <!-- Bound Workspaces -->
        <div class="flex flex-col gap-3">
          <h3 class="text-xs uppercase tracking-wider font-bold text-[var(--text-muted)] flex items-center gap-1.5">
            <Icon name="folder" :size="14" />
            <span>Bound Environment Workspaces (Host-Local Git Worktrees)</span>
          </h3>
          <div class="grid grid-cols-1 sm:grid-cols-2 gap-3">
            <div
              v-for="ws in boundWorkspaces"
              :key="ws.host"
              class="p-3 rounded-[var(--radius-sm)] border border-[var(--border-subtle)] bg-[var(--bg-surface)] flex items-center justify-between gap-2"
            >
              <div>
                <strong class="text-xs font-bold text-[var(--text-primary)] block">{{ ws.host }}</strong>
                <span class="text-[11px] text-[var(--text-secondary)] font-mono">{{ ws.root }}/{{ ws.relPath }}</span>
              </div>
              <StatusPill :status="ws.status === 'Prepared & Ready' ? 'green' : 'yellow'" class="text-[10px]">
                {{ ws.status }}
              </StatusPill>
            </div>
          </div>
        </div>

        <!-- Project Memberships -->
        <div class="flex flex-col gap-3">
          <h3 class="text-xs uppercase tracking-wider font-bold text-[var(--text-muted)] flex items-center gap-1.5">
            <Icon name="agents" :size="14" />
            <span>Active Project Memberships ({{ projectMembers.length }})</span>
          </h3>
          <div class="grid grid-cols-1 sm:grid-cols-2 gap-3">
            <div
              v-for="mem in projectMembers"
              :key="mem.id"
              class="p-3.5 rounded-[var(--radius-md)] border border-[var(--border-subtle)] bg-[var(--bg-surface)] flex items-center justify-between gap-3"
            >
              <div class="flex items-center gap-3">
                <div class="w-8 h-8 rounded-full bg-[var(--accent-bg)] border border-[var(--accent-border)] text-[var(--accent-primary)] font-bold flex items-center justify-center text-xs">
                  {{ mem.name[0] }}
                </div>
                <div>
                  <strong class="text-xs font-bold text-[var(--text-primary)] block">@{{ mem.name }}</strong>
                  <span class="text-[11px] text-[var(--text-secondary)] block">{{ mem.role }}</span>
                  <span class="text-[10px] text-[var(--text-muted)] font-mono">{{ mem.engine }}</span>
                </div>
              </div>
              <StatusDot status="green" size="sm" title="Active Member" />
            </div>
          </div>
        </div>
      </div>

      <!-- 2. Tasks Tab -->
      <div v-else-if="activeTab === 'tasks'" class="flex flex-col gap-3">
        <div class="flex items-center justify-between pb-2 border-b border-[var(--border-subtle)]">
          <h3 class="text-xs uppercase tracking-wider font-bold text-[var(--text-muted)]">
            Project Tasks & Operating Stages (ADR-0006)
          </h3>
          <Button variant="primary" size="xs">
            <Icon name="plus" :size="12" />
            <span>New Task</span>
          </Button>
        </div>

        <div class="flex flex-col gap-2.5">
          <div
            v-for="t in tasks"
            :key="t.id"
            class="p-4 rounded-[var(--radius-md)] border border-[var(--border-subtle)] bg-[var(--bg-surface)] hover:border-[var(--border-strong)] transition-all flex flex-col gap-2"
          >
            <div class="flex items-center justify-between gap-2">
              <div class="flex items-center gap-2">
                <span class="text-xs font-bold text-[var(--text-primary)]">Task #{{ t.id }}</span>
                <Badge :variant="t.stageVariant">{{ t.stage }}</Badge>
                <span class="text-[10px] font-mono text-[var(--text-muted)]">{{ t.version }}</span>
              </div>
              <span class="text-xs text-[var(--text-muted)]">Lead: <strong class="text-[var(--text-secondary)]">@{{ t.lead }}</strong></span>
            </div>

            <h4 class="text-xs sm:text-sm font-semibold text-[var(--text-primary)]">
              {{ t.title }}
            </h4>

            <div class="pt-2 border-t border-[var(--border-subtle)] flex items-center justify-between text-[11px] text-[var(--text-muted)] flex-wrap gap-1">
              <span class="font-mono">{{ t.lifecycleSentence }}</span>
              <span>Host: <strong>{{ t.host }}</strong></span>
            </div>
          </div>
        </div>
      </div>

      <!-- 3. Chat Tab -->
      <div v-else-if="activeTab === 'chat'" class="grid grid-cols-1 md:grid-cols-4 gap-4 h-[600px] rounded-[var(--radius-md)] border border-[var(--border-subtle)] bg-[var(--bg-surface)] overflow-hidden">
        <!-- Chat Channels & Scope List -->
        <div class="border-r border-[var(--border-subtle)] p-3 flex flex-col gap-4 bg-[var(--bg-surface-elevated)]">
          <div>
            <span class="text-[10px] font-bold uppercase tracking-wider text-[var(--text-muted)] block mb-1.5">
              Project Channels
            </span>
            <button
              type="button"
              class="w-full text-left px-2.5 py-1.5 rounded text-xs font-semibold flex items-center justify-between transition-colors cursor-pointer"
              :class="activeChatChannel === '#general' ? 'bg-[var(--accent-bg)] text-[var(--accent-primary)] font-bold' : 'text-[var(--text-secondary)] hover:bg-[var(--bg-surface)]'"
              @click="activeChatChannel = '#general'"
            >
              <span>#general</span>
              <span class="text-[10px] px-1 rounded bg-[var(--accent-primary)] text-white">4</span>
            </button>
          </div>

          <div>
            <span class="text-[10px] font-bold uppercase tracking-wider text-[var(--text-muted)] block mb-1.5">
              Working Groups
            </span>
            <button
              type="button"
              class="w-full text-left px-2.5 py-1.5 rounded text-xs font-medium flex items-center justify-between transition-colors cursor-pointer"
              :class="activeChatChannel === 'wg-frontend' ? 'bg-[var(--accent-bg)] text-[var(--accent-primary)] font-bold' : 'text-[var(--text-secondary)] hover:bg-[var(--bg-surface)]'"
              @click="activeChatChannel = 'wg-frontend'"
            >
              <span>wg-frontend</span>
            </button>
            <button
              type="button"
              class="w-full text-left px-2.5 py-1.5 rounded text-xs font-medium flex items-center justify-between transition-colors cursor-pointer"
              :class="activeChatChannel === 'wg-core' ? 'bg-[var(--accent-bg)] text-[var(--accent-primary)] font-bold' : 'text-[var(--text-secondary)] hover:bg-[var(--bg-surface)]'"
              @click="activeChatChannel = 'wg-core'"
            >
              <span>wg-core</span>
            </button>
          </div>

          <div>
            <span class="text-[10px] font-bold uppercase tracking-wider text-[var(--text-muted)] block mb-1.5">
              Direct Messages
            </span>
            <button
              type="button"
              class="w-full text-left px-2.5 py-1.5 rounded text-xs font-medium flex items-center gap-1.5 transition-colors cursor-pointer"
              :class="activeChatChannel === '@Programmer' ? 'bg-[var(--accent-bg)] text-[var(--accent-primary)] font-bold' : 'text-[var(--text-secondary)] hover:bg-[var(--bg-surface)]'"
              @click="activeChatChannel = '@Programmer'"
            >
              <StatusDot status="green" size="sm" />
              <span>@Programmer</span>
            </button>
          </div>
        </div>

        <!-- Chat Timeline & Composer -->
        <div class="md:col-span-3 flex flex-col justify-between h-full p-4">
          <!-- Timeline -->
          <div class="flex-1 overflow-y-auto space-y-4 pr-2">
            <div
              v-for="msg in messages"
              :key="msg.id"
              class="p-3 rounded-[var(--radius-sm)] bg-[var(--bg-surface-elevated)] border border-[var(--border-subtle)] flex flex-col gap-1 text-xs"
            >
              <div class="flex items-center justify-between text-[11px]">
                <div class="flex items-center gap-1.5">
                  <strong class="text-[var(--text-primary)]">@{{ msg.author }}</strong>
                  <span class="text-[10px] text-[var(--text-muted)]">({{ msg.role }})</span>
                </div>
                <span class="text-[10px] text-[var(--text-muted)] font-mono">{{ msg.time }}</span>
              </div>
              <p class="text-[var(--text-secondary)] leading-relaxed mt-0.5">
                {{ msg.text }}
              </p>
            </div>
          </div>

          <!-- Composer Bar -->
          <div class="pt-3 border-t border-[var(--border-subtle)] flex gap-2">
            <input
              type="text"
              placeholder="Send message to #general (@agent to mention, @all to broadcast)..."
              class="flex-1 h-9 rounded border border-[var(--border-subtle)] bg-[var(--bg-surface-elevated)] px-3 text-xs text-[var(--text-primary)] placeholder:text-[var(--text-muted)] focus-visible:outline-2 focus-visible:outline-[var(--border-focus)]"
            />
            <Button variant="primary" size="sm">
              Send
            </Button>
          </div>
        </div>
      </div>
    </div>
  </div>
</template>
