<script setup lang="ts">
import { ref, computed, onMounted, watch } from 'vue';
import {
  TButton, TBadge, TStack, TSpinner, TAlert, TCard, TTable, TEmptyState,
  TGrid, TStat, TInput, useToast,
} from '@treeui/vue';
import { api } from '../../services/api';
import type { BucketSnapshot, BucketObject } from '../../services/api';

const props = defineProps<{ bucketName: string }>();
const emit = defineEmits<{ (e: 'back'): void }>();

const toast = useToast();

const bucket = ref<BucketSnapshot | null>(null);
const objects = ref<BucketObject[]>([]);
const prefix = ref<string>('');
const loading = ref(true);
const loadingObjects = ref(false);
const error = ref<string | null>(null);

// Upload state
const uploadKey = ref('');
const uploadBody = ref('');
const uploadContentType = ref('text/plain');
const uploading = ref(false);

const objectColumns = [
  { key: 'key', label: 'Key' },
  { key: 'size', label: 'Size', align: 'right' as const },
  { key: 'lastModified', label: 'Modified' },
  { key: 'actions', label: '', align: 'right' as const },
];

const totalSize = computed(() =>
  objects.value.reduce((s, o) => s + (o.size || 0), 0),
);

function formatBytes(bytes?: number): string {
  if (bytes === undefined || bytes === null) return '—';
  if (bytes === 0) return '0 B';
  const units = ['B', 'KB', 'MB', 'GB', 'TB'];
  const i = Math.floor(Math.log(bytes) / Math.log(1024));
  return `${(bytes / Math.pow(1024, i)).toFixed(i === 0 ? 0 : 1)} ${units[i]}`;
}

function formatDate(ts?: number): string {
  if (!ts) return '—';
  return new Date(ts).toLocaleString();
}

async function loadBucket() {
  try {
    bucket.value = await api.getBucket(props.bucketName);
    error.value = null;
  } catch (err: any) {
    error.value = err.message || 'Failed to load bucket';
    bucket.value = null;
  } finally {
    loading.value = false;
  }
}

async function loadObjects() {
  loadingObjects.value = true;
  try {
    const result = await api.listBucketObjects(props.bucketName, {
      prefix: prefix.value || undefined,
      maxKeys: 200,
    });
    objects.value = result.objects;
  } catch (err: any) {
    toast.add({
      title: 'Failed to load objects',
      description: err.message,
      variant: 'danger',
    });
  } finally {
    loadingObjects.value = false;
  }
}

function previewUrl(key: string): string {
  return api.bucketObjectContentUrl(props.bucketName, key, false);
}

function downloadUrl(key: string): string {
  return api.bucketObjectContentUrl(props.bucketName, key, true);
}

async function deleteObject(key: string) {
  if (!confirm(`Delete object "${key}"?`)) return;
  try {
    await api.deleteBucketObject(props.bucketName, key);
    toast.add({ title: 'Object deleted', variant: 'info' });
    await loadObjects();
  } catch (err: any) {
    toast.add({
      title: 'Failed to delete object',
      description: err.message,
      variant: 'danger',
    });
  }
}

async function uploadObject() {
  if (!uploadKey.value || !uploadBody.value) {
    toast.add({ title: 'Key and body are required', variant: 'warning' });
    return;
  }
  uploading.value = true;
  try {
    await api.putBucketObject(props.bucketName, {
      key: uploadKey.value,
      body: uploadBody.value,
      contentType: uploadContentType.value || undefined,
    });
    toast.add({ title: 'Object uploaded', variant: 'info' });
    uploadKey.value = '';
    uploadBody.value = '';
    await loadObjects();
    await loadBucket();
  } catch (err: any) {
    toast.add({
      title: 'Failed to upload object',
      description: err.message,
      variant: 'danger',
    });
  } finally {
    uploading.value = false;
  }
}

onMounted(() => {
  loadBucket();
  loadObjects();
});

watch(() => props.bucketName, () => {
  loadBucket();
  loadObjects();
});
</script>

<template>
  <TStack direction="vertical" gap="1rem">
    <TStack direction="horizontal" gap="0.5rem" align="center" justify="space-between">
      <TStack direction="horizontal" gap="0.5rem" align="center">
        <TButton size="sm" variant="ghost" @click="emit('back')">← Buckets</TButton>
        <strong style="font-size: 1.1rem;">{{ bucketName }}</strong>
        <TBadge v-if="bucket?.versioning" tone="info" variant="soft">Versioning</TBadge>
      </TStack>
      <TButton size="sm" variant="ghost" :loading="loadingObjects" @click="loadObjects()">Refresh</TButton>
    </TStack>

    <TAlert v-if="error" variant="danger" dismissible @dismiss="error = null">
      {{ error }}
    </TAlert>

    <div v-if="loading && !bucket" style="display: flex; justify-content: center; padding: 2rem;">
      <TSpinner label="Loading bucket..." />
    </div>

    <template v-else-if="bucket">
      <TGrid :columns="4" gap="0.75rem">
        <TStat label="Objects" :value="bucket.objectCount ?? 0" tone="info" />
        <TStat label="Size" :value="formatBytes(bucket.totalSize)" tone="neutral" />
        <TStat
          label="Versioning"
          :value="bucket.versioning ? 'Enabled' : 'Disabled'"
          :tone="bucket.versioning ? 'success' : 'neutral'"
        />
        <TStat
          label="Notifications"
          :value="bucket.notifications ?? 0"
          :tone="(bucket.notifications ?? 0) > 0 ? 'info' : 'neutral'"
        />
      </TGrid>

      <TCard variant="outline">
        <template #header>
          <strong>Upload object</strong>
        </template>
        <TStack direction="vertical" gap="0.5rem">
          <TInput v-model="uploadKey" placeholder="object/key.txt" label="Key" />
          <TInput v-model="uploadContentType" placeholder="text/plain" label="Content-Type" />
          <label class="muted" style="font-size: 0.875rem;">Body</label>
          <textarea
            v-model="uploadBody"
            rows="4"
            style="width: 100%; font-family: var(--tree-font-mono, monospace); padding: 0.5rem;"
            placeholder="Hello, world!"
          ></textarea>
          <TStack direction="horizontal" justify="flex-end">
            <TButton size="sm" :loading="uploading" @click="uploadObject">Upload</TButton>
          </TStack>
        </TStack>
      </TCard>

      <TCard variant="outline">
        <template #header>
          <TStack direction="horizontal" gap="0.5rem" align="center" justify="space-between">
            <strong>Objects ({{ objects.length }} · {{ formatBytes(totalSize) }})</strong>
            <TStack direction="horizontal" gap="0.5rem" align="center">
              <TInput
                v-model="prefix"
                placeholder="prefix filter"
                size="sm"
                @keyup.enter="loadObjects()"
              />
              <TButton size="sm" variant="ghost" @click="loadObjects()">Apply</TButton>
            </TStack>
          </TStack>
        </template>

        <div v-if="loadingObjects" style="display: flex; justify-content: center; padding: 2rem;">
          <TSpinner label="Loading objects..." />
        </div>

        <TEmptyState
          v-else-if="!objects.length"
          title="No objects"
          description="This bucket is empty (or the prefix filter excluded everything)."
        />

        <TTable v-else :columns="objectColumns" :rows="objects">
          <template #cell-key="{ row }">
            <a
              :href="previewUrl(String(row.key))"
              target="_blank"
              rel="noopener noreferrer"
              style="text-decoration: none; font-weight: 500;"
            >
              {{ row.key }}
            </a>
          </template>
          <template #cell-size="{ row }">
            {{ formatBytes(Number(row.size)) }}
          </template>
          <template #cell-lastModified="{ row }">
            {{ formatDate(row.lastModified as number | undefined) }}
          </template>
          <template #cell-actions="{ row }">
            <TStack direction="horizontal" gap="0.25rem" justify="flex-end">
              <a
                :href="downloadUrl(String(row.key))"
                target="_blank"
                rel="noopener noreferrer"
                style="text-decoration: none;"
              >
                <TButton size="sm" variant="ghost">Download</TButton>
              </a>
              <TButton
                size="sm"
                variant="ghost"
                tone="danger"
                @click="deleteObject(String(row.key))"
              >
                Delete
              </TButton>
            </TStack>
          </template>
        </TTable>
      </TCard>
    </template>
  </TStack>
</template>
