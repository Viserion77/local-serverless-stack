<script setup lang="ts">
import { useRouter } from 'vue-router';
import WebFunctionDetail from '../components/lambdas/WebFunctionDetail.vue';

defineProps<{ service: string; name: string }>();
const router = useRouter();

function back() {
  router.push('/lambdas');
}
</script>

<template>
  <WebFunctionDetail :service="service" :name="name" @back="back" />
</template>
