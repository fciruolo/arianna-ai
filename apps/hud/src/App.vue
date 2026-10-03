<script setup lang="ts">
import { onBeforeUnmount, onMounted, ref } from 'vue';

import ApprovalCard from './components/ApprovalCard.vue';
import ChatView from './components/ChatView.vue';
import ConversationList from './components/ConversationList.vue';
import NewConversation from './components/NewConversation.vue';
import { ACTION_TEXT, DECISION_TEXT, REMOTE_CHANNEL_TEXT } from './lib/labels.ts';
import { createChatStore } from './store.ts';

const store = createChatStore();
const { conversations, archived, chat, current, tasks, approvals, models, projects, remoteDecisions, live, error, sending } = store;

function timeOf(ts: string): string {
  return new Date(ts).toLocaleTimeString('it-IT', { hour: '2-digit', minute: '2-digit' });
}
const showSidebar = ref(false);

onMounted(() => {
  store.start();
});
onBeforeUnmount(() => {
  store.stop();
});

async function openConversation(id: string): Promise<void> {
  showSidebar.value = false;
  await store.open(id);
}

async function createConversation(mode: 'work' | 'private', project?: string): Promise<void> {
  showSidebar.value = false;
  await store.create(mode, project);
}
</script>

<template>
  <div class="flex h-full flex-col md:flex-row">
    <!-- Conversations -->
    <aside
      class="flex-col border-stone-200 bg-white md:flex md:w-72 md:shrink-0 md:border-r dark:border-stone-800 dark:bg-stone-900"
      :class="showSidebar ? 'flex border-b' : 'hidden'"
    >
      <div class="flex items-center gap-2 px-4 py-4">
        <span class="text-lg font-semibold tracking-tight">Arianna</span>
        <span
          class="ml-auto inline-flex items-center gap-1.5 text-xs text-stone-500 dark:text-stone-400"
          :title="live === 'open' ? 'Collegata al nucleo' : 'Riconnessione in corso'"
        >
          <span class="size-2 rounded-full" :class="live === 'open' ? 'bg-emerald-500' : 'bg-amber-500 animate-pulse'" />
          {{ live === 'open' ? 'in linea' : 'riconnessione' }}
        </span>
      </div>
      <NewConversation class="px-4" :projects="projects" @create="createConversation" @refresh="store.refreshProjects" />
      <ConversationList
        class="mt-4 min-h-0 flex-1 overflow-y-auto px-2 pb-4"
        :conversations="conversations"
        :archived="archived"
        :selected="chat?.conversationId ?? null"
        :rename="store.rename"
        @open="openConversation"
        @archive="store.archive"
        @purge="store.purge"
      />
    </aside>

    <!-- Chat -->
    <main class="flex min-h-0 min-w-0 flex-1 flex-col">
      <div class="flex items-center gap-3 border-b border-stone-200 px-4 py-3 md:hidden dark:border-stone-800">
        <button
          type="button"
          class="rounded-md px-2 py-1 text-sm font-medium text-stone-600 hover:bg-stone-100 dark:text-stone-300 dark:hover:bg-stone-800"
          @click="showSidebar = !showSidebar"
        >
          {{ showSidebar ? 'Chiudi' : 'Conversazioni' }}
        </button>
        <span class="font-semibold">Arianna</span>
      </div>

      <p
        v-if="error !== null"
        role="alert"
        class="mx-4 mt-3 rounded-lg border border-rose-200 bg-rose-50 px-3 py-2 text-sm text-rose-800 dark:border-rose-900 dark:bg-rose-950 dark:text-rose-200"
      >
        {{ error }}
      </p>

      <ChatView
        v-if="chat !== null && current !== undefined"
        class="min-h-0 flex-1"
        :chat="chat"
        :conversation="current"
        :tasks="tasks"
        :sending="sending"
        :models="models"
        @send="store.send"
        @choose-model="store.chooseModel"
        @restore="store.archive(current.id, false)"
      />
      <div v-else class="flex flex-1 items-center justify-center p-8 text-center text-stone-500 dark:text-stone-400">
        <div class="max-w-sm">
          <p class="text-base font-medium text-stone-700 dark:text-stone-200">Apri o crea una conversazione</p>
          <p class="mt-2 text-sm">
            Una conversazione <strong>privata</strong> resta sul modello locale; una <strong>di lavoro</strong> può usare il cloud ma
            non vede dati privati.
          </p>
        </div>
      </div>
    </main>

    <!-- Approvals: "Attende te" -->
    <aside
      v-if="approvals.length > 0 || remoteDecisions.length > 0"
      class="max-h-[45vh] overflow-y-auto border-t border-stone-200 bg-white p-4 md:max-h-none md:w-96 md:shrink-0 md:border-t-0 md:border-l dark:border-stone-800 dark:bg-stone-900"
    >
      <template v-if="approvals.length > 0">
        <h2 class="mb-3 text-sm font-semibold text-stone-700 dark:text-stone-200">
          Attende te <span class="font-normal text-stone-500">({{ approvals.length }})</span>
        </h2>
        <div class="flex flex-col gap-3">
          <ApprovalCard v-for="approval in approvals" :key="approval.id" :approval="approval" :decide="store.decide" />
        </div>
      </template>
      <template v-if="remoteDecisions.length > 0">
        <h2 class="mb-2 text-sm font-semibold text-stone-700 dark:text-stone-200" :class="approvals.length > 0 ? 'mt-5' : ''">Decise altrove</h2>
        <ul class="flex flex-col gap-2">
          <li
            v-for="decision in remoteDecisions"
            :key="decision.approvalId"
            class="flex items-center gap-2 rounded-lg border border-sky-200 bg-sky-50 px-3 py-2 text-xs dark:border-sky-900 dark:bg-sky-950/40"
          >
            <span class="font-semibold">{{ decision.action === undefined ? 'Richiesta' : (ACTION_TEXT[decision.action] ?? decision.action) }}</span>
            <span :class="decision.state === 'approved' ? 'text-emerald-700 dark:text-emerald-400' : 'text-rose-700 dark:text-rose-400'">
              {{ DECISION_TEXT[decision.state] }}
            </span>
            <span class="text-stone-500">da {{ REMOTE_CHANNEL_TEXT[decision.via] }} · {{ timeOf(decision.ts) }}</span>
            <button
              type="button"
              class="ml-auto rounded px-1 text-stone-500 hover:bg-sky-100 dark:hover:bg-sky-900"
              aria-label="Nascondi"
              @click="store.dismissDecision(decision.approvalId)"
            >
              ×
            </button>
          </li>
        </ul>
      </template>
    </aside>
  </div>
</template>
