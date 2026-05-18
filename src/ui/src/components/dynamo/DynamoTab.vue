<script setup lang="ts">
import { ref } from 'vue';
import DynamoTablesList from './DynamoTablesList.vue';
import DynamoTableDetail from './DynamoTableDetail.vue';

const selected = ref<string | null>(null);

function open(name: string) {
  selected.value = name;
}

function back() {
  selected.value = null;
}
</script>

<template>
  <DynamoTableDetail
    v-if="selected"
    :table-name="selected"
    @back="back"
  />
  <DynamoTablesList v-else @open="open" />
</template>
