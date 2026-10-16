<script setup lang="ts">
/**
 * The attachments of a message in its bubble (D-247): a small preview of each
 * image, served by the core with a sandbox (it opens whole in a new tab), and
 * each text file as its name, downloaded on a click.
 */
import { attachmentSize, attachmentUrl } from '../lib/attachments.ts';
import type { AttachmentInfo } from '../lib/types.ts';
import Icon from './Icon.vue';

defineProps<{ attachments: readonly AttachmentInfo[] }>();
</script>

<template>
  <ul class="flex max-w-[90%] flex-wrap justify-end gap-2 md:max-w-[78%]" aria-label="Allegati">
    <li v-for="item in attachments" :key="item.id">
      <a
        v-if="item.kind === 'image'"
        :href="attachmentUrl(item.id)"
        target="_blank"
        rel="noopener noreferrer"
        class="block overflow-hidden rounded-xl border border-line"
        :title="`${item.name} · ${attachmentSize(item.size)} · Privato, letto solo sul Mac`"
      >
        <img :src="attachmentUrl(item.id)" :alt="item.name" loading="lazy" class="block max-h-40 max-w-[240px] object-contain" />
      </a>
      <a
        v-else
        :href="attachmentUrl(item.id)"
        :download="item.name"
        class="flex max-w-[240px] items-center gap-2 rounded-xl border border-line bg-surface-2 px-3 py-2 text-[13px] text-ink hover:border-line-strong"
        :title="`${item.name} · ${attachmentSize(item.size)} · Privato, letto solo sul Mac`"
      >
        <Icon name="file" :size="16" class="shrink-0 text-muted" />
        <span class="truncate">{{ item.name }}</span>
      </a>
    </li>
  </ul>
</template>
