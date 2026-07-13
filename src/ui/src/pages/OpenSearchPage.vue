<script setup lang="ts">
import { useRouter } from 'vue-router';
import OpenSearchCollectionsList from '../components/opensearch/OpenSearchCollectionsList.vue';

const router = useRouter();

function open(name: string) {
  router.push(`/opensearch/${encodeURIComponent(name)}`);
}
</script>

<template>
  <OpenSearchCollectionsList @open="open" />
</template>
