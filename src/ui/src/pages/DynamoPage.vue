<script setup lang="ts">
import { useRouter } from 'vue-router';
import DynamoTablesList from '../components/dynamo/DynamoTablesList.vue';

const router = useRouter();

function open(name: string) {
  router.push(`/dynamo/${encodeURIComponent(name)}`);
}
</script>

<template>
  <DynamoTablesList @open="open" />
</template>
