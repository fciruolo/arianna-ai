<script setup lang="ts">
import { computed } from 'vue';

import { messageTime } from '../lib/message-time.ts';

/** When a message was sent (D-112): short in the line, full date and time in the title. */
const props = defineProps<{ ts: string; now: Date }>();
const time = computed(() => messageTime(props.ts, props.now));
</script>

<template>
  <time v-if="time !== undefined" :datetime="ts" :title="time.full">{{ time.text }}</time>
</template>
