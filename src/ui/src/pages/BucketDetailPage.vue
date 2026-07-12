<script setup lang="ts">
import { useRouter } from 'vue-router';
import BucketDetail from '../components/buckets/BucketDetail.vue';

defineProps<{ bucketName: string }>();
const router = useRouter();

function back() {
  router.push('/buckets');
}
</script>

<template>
  <BucketDetail :bucket-name="bucketName" @back="back" />
</template>
