<script setup lang="ts">
import { ref, computed, watch, onMounted } from 'vue';
import { useRoute, useRouter } from 'vue-router';
import Icon from '../primitives/Icon.vue';
import Button from '../primitives/Button.vue';
import Badge from '../primitives/Badge.vue';

const route = useRoute();
const router = useRouter();

const selectedProjectId = ref('sprout-m2');
const activeTab = ref<'overview' | 'tasks' | 'chat'>('overview');
const activeChatChannel = ref('#general');
const isMobileChatDetailOpen = ref(false);

function syncTabFromRoute() {
  const tabParam = route.params.tab as string | undefined;
  if (tabParam === 'tasks' || tabParam === 'chat' || tabParam === 'overview') {
    activeTab.value = tabParam;
  } else if (route.path.endsWith('/tasks')) {
    activeTab.value = 'tasks';
  } else if (route.path.endsWith('/chat')) {
    activeTab.value = 'chat';
  } else {
    activeTab.value = 'overview';
  }
}

onMounted(() => {
  syncTabFromRoute();
});

watch(
  () => route.path,
  () => {
    syncTabFromRoute();
  }
);

const projects = [
  { id: 'sprout-m2', name: 'Sprout M2 Operator', desc: 'Local multi-agent collaboration and environment-scheduling platform', status: 'Active' },
  { id: 'minesweeper', name: 'o7 Minesweeper Game', desc: 'Deterministic puzzle game testbed with agent validation harnesses', status: 'Active' },
  { id: 'tooling', name: 'Dev Pipeline Tooling', desc: 'Host orchestration, carrier overlay, and verification CLI', status: 'Maintenance' },
];

const currentProject = computed(() => projects.find((p) => p.id === selectedProjectId.value) ?? projects[0]);

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
    lifecycleSentence: 'Task completed · All verification runs green · Released lease',
  },
];

interface ChatScope {
  id: string;
  label: string;
  kind: 'channel' | 'working-group' | 'dm';
  lastSnippet: string;
  lastTime: string;
  unread: number;
}

const chatScopes = ref<ChatScope[]>([
  {
    id: '#general',
    label: '#general',
    kind: 'channel',
    lastSnippet: 'All 8 Reka UI accessible dialog checks pass...',
    lastTime: '10:11 AM',
    unread: 0,
  },
  {
    id: 'wg-frontend',
    label: 'wg-frontend',
    kind: 'working-group',
    lastSnippet: 'Vue 3.5 + Tailwind 4 responsive chat layout...',
    lastTime: '10:05 AM',
    unread: 1,
  },
  {
    id: 'wg-core',
    label: 'wg-core',
    kind: 'working-group',
    lastSnippet: 'Carrier TLS stream reconnect latency ~14ms...',
    lastTime: '09:48 AM',
    unread: 0,
  },
  {
    id: '@Programmer',
    label: '@Programmer',
    kind: 'dm',
    lastSnippet: 'Verified remote-state ports and happy-dom tests.',
    lastTime: '10:08 AM',
    unread: 0,
  },
  {
    id: '@Architect',
    label: '@Architect',
    kind: 'dm',
    lastSnippet: 'ADR-0011 architectural foundation baseline confirmed.',
    lastTime: '10:04 AM',
    unread: 0,
  },
]);

const chatMessages = ref([
  {
    id: 'msg-1',
    author: 'Architect',
    role: 'System Architect',
    time: '10:04 AM',
    content: 'Reviewing Ticket #74 Vue foundation slice. Ensure ADR-0011 boundary holds: Shell + Environments are authoritative; Pinia owns only UI state.',
  },
  {
    id: 'msg-2',
    author: 'Programmer',
    role: 'Lead Implementer',
    time: '10:08 AM',
    content: 'Verified. Remote state stays behind EnvironmentService port. No global mutable StateManager. 541 automated tests passing cleanly.',
  },
  {
    id: 'msg-3',
    author: 'Foreman',
    role: 'Coordinator',
    time: '10:11 AM',
    content: 'All 8 Reka UI accessible dialog checks pass. Focus trap, Escape dismissal, and 3-gate Force Release safety verification green.',
  },
]);

const newMessage = ref('');

function selectChannel(channelId: string) {
  activeChatChannel.value = channelId;
  isMobileChatDetailOpen.value = true;
}

function sendMessage() {
  if (!newMessage.value.trim()) return;
  chatMessages.value.push({
    id: `msg-${Date.now()}`,
    author: 'Operator',
    role: 'Human Operator',
    time: 'Just now',
    content: newMessage.value.trim(),
  });
  newMessage.value = '';
}
</script>

<template>
  <div class="project-view flex flex-col h-full bg-[var(--bg-app)]">
    <!-- 1. Top Project Header & Selector (Without redundant sub-navigation tab strip) -->
    <div class="px-4 py-3 bg-[var(--bg-surface)] border-b border-[var(--border-subtle)] flex items-center justify-between gap-4 flex-wrap">
      <div class="flex items-center gap-3">
        <div class="p-2 rounded bg-[var(--accent-bg)] text-[var(--accent-primary)]">
          <Icon name="folder" :size="20" />
        </div>
        <div>
          <div class="flex items-center gap-2">
            <select
              v-model="selectedProjectId"
              class="font-bold text-sm text-[var(--text-primary)] bg-transparent border-0 focus:ring-0 cursor-pointer pr-4"
              aria-label="Select Project"
            >
              <option v-for="p in projects" :key="p.id" :value="p.id" class="bg-[var(--bg-surface)] text-[var(--text-primary)]">
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

      <!-- Action Buttons (Info & New Project) -->
      <div class="flex items-center gap-2">
        <Button variant="secondary" size="icon" title="Project Information & Metadata" aria-label="Project Information & Metadata">
          <Icon name="info" :size="16" />
        </Button>
        <Button variant="secondary" size="icon" title="Create New Project" aria-label="Create New Project">
          <Icon name="plus" :size="16" />
        </Button>
      </div>
    </div>

    <!-- 2. Main Content Area (Fluid width, ultra-wide screen adapted) -->
    <div class="flex-1 overflow-y-auto p-4 sm:p-6 w-full max-w-[1920px] mx-auto min-h-0">
      <!-- 1. Overview Tab -->
      <div v-if="activeTab === 'overview'" class="grid grid-cols-1 lg:grid-cols-3 gap-6">
        <!-- Left 2 Columns on Wide Screens: Contract & Workspaces -->
        <div class="lg:col-span-2 flex flex-col gap-6">
          <!-- Goal & Collaboration Contract -->
          <div class="p-4 rounded-[var(--radius-md)] border border-[var(--border-subtle)] bg-[var(--bg-surface)] flex flex-col gap-3 shadow-xs">
            <h3 class="text-xs uppercase tracking-wider font-bold text-[var(--text-muted)] flex items-center justify-between">
              <span>Project Collaboration Agreement (AGENTS.md)</span>
              <span class="text-[10px] text-[var(--text-secondary)] font-mono">Wake policy: Explicit + Mentions</span>
            </h3>
            <p class="text-xs text-[var(--text-primary)] leading-relaxed">
              Strict multi-agent boundaries: all worker turns must record verifiable evidence before advancing task lifecycle.
              No uncommitted code without passing test suites.
            </p>
            <div class="flex items-center gap-2 text-[11px] text-[var(--text-secondary)] pt-2 border-t border-[var(--border-subtle)]">
              <Icon name="shield" :size="14" class="text-[var(--green-ready)]" />
              <span>Host permissions verified · Task-held leases guaranteed exclusive (ADR-0005)</span>
            </div>
          </div>

          <!-- Bound Workspaces -->
          <div class="p-4 rounded-[var(--radius-md)] border border-[var(--border-subtle)] bg-[var(--bg-surface)] flex flex-col gap-3 shadow-xs">
            <div class="flex items-center justify-between">
              <h3 class="text-xs uppercase tracking-wider font-bold text-[var(--text-muted)]">Bound Host Workspaces</h3>
              <Badge variant="secondary">{{ boundWorkspaces.length }} Active Bindings</Badge>
            </div>
            <div class="grid grid-cols-1 sm:grid-cols-2 gap-3">
              <div
                v-for="ws in boundWorkspaces"
                :key="ws.root"
                class="p-3 rounded bg-[var(--bg-surface-elevated)] border border-[var(--border-subtle)] flex flex-col justify-between gap-2"
              >
                <div>
                  <div class="flex items-center justify-between gap-2 mb-1">
                    <strong class="text-xs text-[var(--text-primary)] font-mono">{{ ws.root }}</strong>
                    <Badge :variant="ws.status === 'Prepared & Ready' ? 'success' : 'danger'">{{ ws.status }}</Badge>
                  </div>
                  <span class="text-[11px] text-[var(--text-muted)] font-mono block truncate">{{ ws.relPath }}</span>
                </div>
                <div class="text-[10px] text-[var(--text-secondary)] pt-1 border-t border-[var(--border-subtle)]">
                  Host: {{ ws.host }}
                </div>
              </div>
            </div>
          </div>
        </div>

        <!-- Right 1 Column on Wide Screens: Memberships -->
        <div class="p-4 rounded-[var(--radius-md)] border border-[var(--border-subtle)] bg-[var(--bg-surface)] flex flex-col gap-3 shadow-xs h-fit">
          <div class="flex items-center justify-between">
            <h3 class="text-xs uppercase tracking-wider font-bold text-[var(--text-muted)]">Active Memberships</h3>
            <Badge variant="info">{{ projectMembers.length }} Agents</Badge>
          </div>
          <div class="flex flex-col gap-2">
            <div
              v-for="m in projectMembers"
              :key="m.id"
              class="p-2.5 rounded bg-[var(--bg-surface-elevated)] border border-[var(--border-subtle)] flex items-center justify-between gap-2"
            >
              <div class="flex items-center gap-2.5">
                <div class="w-8 h-8 rounded-full bg-[var(--purple-agent-bg)] border border-[var(--purple-agent-border)] text-[var(--purple-agent)] font-bold flex items-center justify-center text-xs">
                  {{ m.name[0] }}
                </div>
                <div>
                  <strong class="text-xs text-[var(--text-primary)] block">@{{ m.name }}</strong>
                  <span class="text-[10px] text-[var(--text-muted)] block">{{ m.role }}</span>
                </div>
              </div>
              <Badge variant="secondary" class="font-mono text-[9px]">{{ m.engine }}</Badge>
            </div>
          </div>
        </div>
      </div>

      <!-- 2. Tasks Tab (Ultra-wide grid) -->
      <div v-else-if="activeTab === 'tasks'" class="flex flex-col gap-4">
        <div class="flex items-center justify-between gap-2 flex-wrap">
          <div class="flex items-center gap-2">
            <h3 class="text-sm font-bold text-[var(--text-primary)]">Project Tasks & Run States</h3>
            <Badge variant="info">{{ tasks.length }} Tasks</Badge>
          </div>
          <Button variant="primary" size="sm">
            <Icon name="plus" :size="14" />
            <span>New Task</span>
          </Button>
        </div>

        <div class="grid grid-cols-1 xl:grid-cols-2 gap-3">
          <div
            v-for="task in tasks"
            :key="task.id"
            class="p-4 rounded-[var(--radius-md)] border border-[var(--border-subtle)] bg-[var(--bg-surface)] hover:border-[var(--border-strong)] transition-all flex flex-col justify-between gap-3 shadow-xs"
          >
            <div>
              <div class="flex items-center justify-between gap-2 mb-1.5">
                <div class="flex items-center gap-2">
                  <Badge :variant="task.stageVariant">{{ task.stage.toUpperCase() }}</Badge>
                  <span class="text-xs font-mono font-bold text-[var(--text-muted)]">#{{ task.id }}</span>
                </div>
                <span class="text-[11px] font-mono text-[var(--text-muted)]">{{ task.version }}</span>
              </div>
              <h4 class="text-sm font-bold text-[var(--text-primary)] mb-1">
                {{ task.title }}
              </h4>
              <p class="text-xs text-[var(--text-secondary)] font-mono">
                {{ task.lifecycleSentence }}
              </p>
            </div>

            <div class="pt-2 border-t border-[var(--border-subtle)] flex items-center justify-between text-xs text-[var(--text-muted)]">
              <span>Lead: @{{ task.lead }} · Host: {{ task.host }}</span>
              <span class="text-[var(--accent-primary)] font-semibold cursor-pointer hover:underline">Inspect Task →</span>
            </div>
          </div>
        </div>
      </div>

      <!-- 3. Chat Tab (Responsive: Wide screen side-by-side, narrow screen drill-down with back button) -->
      <div v-else-if="activeTab === 'chat'" class="rounded-[var(--radius-md)] border border-[var(--border-subtle)] bg-[var(--bg-surface)] overflow-hidden flex flex-col md:flex-row h-[750px] shadow-xs">
        <!-- Chat Channels Cards / List: Visible on Desktop, or on Mobile when NOT drilled down -->
        <div
          class="w-full md:w-72 lg:w-80 bg-[var(--bg-surface-elevated)] md:border-r border-[var(--border-subtle)] p-3 flex flex-col gap-2 shrink-0 overflow-y-auto"
          :class="isMobileChatDetailOpen ? 'hidden md:flex' : 'flex'"
        >
          <div class="flex items-center justify-between px-2 mb-1">
            <span class="text-[10px] uppercase font-bold text-[var(--text-muted)] tracking-wider">Conversations & Groups</span>
            <span class="text-[10px] text-[var(--text-muted)]">{{ chatScopes.length }} Active</span>
          </div>

          <!-- Chat Scope Cards List -->
          <div class="flex flex-col gap-1.5">
            <button
              v-for="scope in chatScopes"
              :key="scope.id"
              type="button"
              class="w-full text-left p-3 rounded-[var(--radius-sm)] border transition-all cursor-pointer select-none flex flex-col gap-1"
              :class="activeChatChannel === scope.id ? 'bg-[var(--bg-surface)] border-[var(--accent-primary)] shadow-xs ring-1 ring-[var(--accent-primary)]' : 'bg-[var(--bg-surface)] border-[var(--border-subtle)] hover:border-[var(--border-strong)]'"
              @click="selectChannel(scope.id)"
            >
              <div class="flex items-center justify-between gap-2">
                <div class="flex items-center gap-2 truncate">
                  <div class="p-1 rounded bg-[var(--bg-surface-elevated)] text-[var(--text-secondary)]">
                    <Icon :name="scope.kind === 'channel' ? 'chat' : scope.kind === 'working-group' ? 'project' : 'agents'" :size="14" />
                  </div>
                  <strong class="text-xs font-bold text-[var(--text-primary)] truncate">{{ scope.label }}</strong>
                </div>
                <span class="text-[10px] text-[var(--text-muted)] font-mono shrink-0">{{ scope.lastTime }}</span>
              </div>

              <p class="text-[11px] text-[var(--text-secondary)] truncate pl-7">
                {{ scope.lastSnippet }}
              </p>

              <div v-if="scope.unread > 0" class="flex justify-end pt-0.5">
                <span class="px-1.5 py-0.2 rounded-full text-[9px] font-bold bg-[var(--accent-primary)] text-[var(--text-inverse)]">
                  {{ scope.unread }} new
                </span>
              </div>
            </button>
          </div>
        </div>

        <!-- Chat Timeline & Composer: Visible on Desktop, or on Mobile when drilled down -->
        <div
          class="flex-1 flex flex-col justify-between h-full bg-[var(--bg-surface)] min-w-0"
          :class="!isMobileChatDetailOpen ? 'hidden md:flex' : 'flex'"
        >
          <!-- Mobile-only Chat Back Header (Hidden on md+) -->
          <div class="md:hidden px-3 py-2.5 border-b border-[var(--border-subtle)] bg-[var(--bg-surface-elevated)] flex items-center justify-between gap-2">
            <button
              type="button"
              class="flex items-center gap-1.5 text-xs font-semibold text-[var(--accent-primary)] hover:underline cursor-pointer py-1 px-2 rounded bg-[var(--accent-bg)] border border-[var(--accent-border)] min-h-[36px]"
              title="Return to Conversations List"
              aria-label="Return to Conversations List"
              @click="isMobileChatDetailOpen = false"
            >
              <Icon name="chevron-left" :size="16" />
              <span>Back to Chats</span>
            </button>
            <div class="flex items-center gap-1.5 truncate">
              <Icon name="chat" :size="14" class="text-[var(--accent-primary)]" />
              <strong class="text-xs text-[var(--text-primary)] truncate">{{ activeChatChannel }}</strong>
            </div>
          </div>

          <!-- Standard Channel Header (Always visible on Desktop) -->
          <div class="hidden md:flex px-4 py-3 border-b border-[var(--border-subtle)] items-center justify-between bg-[var(--bg-surface)]">
            <div class="flex items-center gap-2">
              <Icon name="chat" :size="16" class="text-[var(--accent-primary)]" />
              <strong class="text-xs font-bold text-[var(--text-primary)]">{{ activeChatChannel }}</strong>
              <span class="text-[10px] text-[var(--text-muted)]">Active multi-agent message timeline</span>
            </div>
            <Badge variant="secondary">3 Members Online</Badge>
          </div>

          <!-- Messages Scroll Area -->
          <div class="flex-1 overflow-y-auto p-4 flex flex-col gap-4">
            <div
              v-for="msg in chatMessages"
              :key="msg.id"
              class="flex items-start gap-3"
            >
              <div class="w-8 h-8 rounded-full bg-[var(--purple-agent-bg)] border border-[var(--purple-agent-border)] text-[var(--purple-agent)] font-bold flex items-center justify-center text-xs shrink-0">
                {{ msg.author[0] }}
              </div>
              <div class="flex flex-col gap-1 min-w-0 flex-1">
                <div class="flex items-center gap-2">
                  <strong class="text-xs font-bold text-[var(--text-primary)]">@{{ msg.author }}</strong>
                  <span class="text-[10px] text-[var(--text-muted)]">{{ msg.role }}</span>
                  <span class="text-[10px] text-[var(--text-muted)] ml-auto font-mono">{{ msg.time }}</span>
                </div>
                <div class="p-3 rounded-lg bg-[var(--bg-surface-elevated)] border border-[var(--border-subtle)] text-xs text-[var(--text-primary)] leading-relaxed">
                  {{ msg.content }}
                </div>
              </div>
            </div>
          </div>

          <!-- Composer Bar -->
          <div class="p-3 border-t border-[var(--border-subtle)] bg-[var(--bg-surface-elevated)] flex items-center gap-2">
            <input
              v-model="newMessage"
              type="text"
              :placeholder="`Send message to ${activeChatChannel} (@mention supported)...`"
              class="flex-1 px-3 py-2 text-xs rounded bg-[var(--bg-surface)] border border-[var(--border-subtle)] text-[var(--text-primary)] placeholder-[var(--text-muted)] focus:outline-none focus:border-[var(--border-focus)]"
              @keydown.enter="sendMessage"
            />
            <Button variant="primary" size="sm" @click="sendMessage">
              Send
            </Button>
          </div>
        </div>
      </div>
    </div>
  </div>
</template>
