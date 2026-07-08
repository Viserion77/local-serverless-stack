<script setup lang="ts">
import { useRouter } from 'vue-router';
import LambdaDetail from '../components/lambdas/LambdaDetail.vue';

defineProps<{ functionName: string }>();
const router = useRouter();

function back() {
  router.push('/lambdas');
}
</script>

<template>
  <LambdaDetail :function-name="functionName" @back="back" />
</template>
