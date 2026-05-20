<script setup lang="ts">
import { useRouter } from 'vue-router';
import DynamoTableDetail from '../components/dynamo/DynamoTableDetail.vue';

defineProps<{ tableName: string }>();
const router = useRouter();

function back() {
  router.push('/dynamo');
}
</script>

<template>
  <DynamoTableDetail :table-name="tableName" @back="back" />
</template>
