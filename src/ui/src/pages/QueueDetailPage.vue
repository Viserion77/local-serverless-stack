<script setup lang="ts">
import { useRouter } from 'vue-router';
import QueueDetail from '../components/queues/QueueDetail.vue';

defineProps<{ queueName: string }>();
const router = useRouter();

function back() {
  router.push('/queues');
}
</script>

<template>
  <QueueDetail :queue-name="queueName" @back="back" />
</template>
