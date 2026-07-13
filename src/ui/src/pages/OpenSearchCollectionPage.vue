<script setup lang="ts">
import { useRouter } from 'vue-router';
import OpenSearchCollectionView from '../components/opensearch/OpenSearchCollectionView.vue';

defineProps<{ name: string }>();
const router = useRouter();

function back() {
  router.push('/opensearch');
}
</script>

<template>
  <OpenSearchCollectionView :name="name" @back="back" />
</template>
