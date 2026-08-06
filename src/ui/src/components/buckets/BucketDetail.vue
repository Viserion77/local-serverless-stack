<script setup lang="ts">
import { ref, computed, onMounted, watch } from 'vue';
import {
  TButton, TBadge, TStack, TSpinner, TAlert, TCard, TTable, TEmptyState,
  TGrid, TStat, TInput, TFormField, TTextarea, TText, TIcon, TLink, useToast,
} from '@treeui/vue';
import { api } from '../../services/api';
import type { BucketSnapshot, BucketObject } from '../../services/api';
import { useI18n } from '../../i18n';

const props = defineProps<{ bucketName: string }>();
const emit = defineEmits<{ (e: 'back'): void }>();

const { t } = useI18n();
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

// Computed rather than a module const: the headers have to go through t() at
// render time so switching language re-labels the table without a reload.
const objectColumns = computed(() => [
  { key: 'key', label: t('buckets.colKey') },
  { key: 'size', label: t('common.size'), align: 'right' as const },
  { key: 'lastModified', label: t('buckets.colModified') },
  { key: 'actions', label: '', align: 'right' as const },
]);

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
    error.value = err.message || t('buckets.detailLoadFailed');
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
      title: t('buckets.objectsLoadFailed'),
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
  if (!confirm(t('buckets.deleteConfirm', { key }))) return;
  try {
    await api.deleteBucketObject(props.bucketName, key);
    toast.add({ title: t('buckets.deleteSuccess'), variant: 'info' });
    await loadObjects();
  } catch (err: any) {
    toast.add({
      title: t('buckets.deleteFailed'),
      description: err.message,
      variant: 'danger',
    });
  }
}

async function uploadObject() {
  if (!uploadKey.value || !uploadBody.value) {
    toast.add({ title: t('buckets.uploadMissingFields'), variant: 'warning' });
    return;
  }
  uploading.value = true;
  try {
    await api.putBucketObject(props.bucketName, {
      key: uploadKey.value,
      body: uploadBody.value,
      contentType: uploadContentType.value || undefined,
    });
    toast.add({ title: t('buckets.uploadSuccess'), variant: 'info' });
    uploadKey.value = '';
    uploadBody.value = '';
    await loadObjects();
    await loadBucket();
  } catch (err: any) {
    toast.add({
      title: t('buckets.uploadFailed'),
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
        <TButton size="sm" variant="ghost" @click="emit('back')">
          <TIcon name="arrow-left" /> {{ t('buckets.backToBuckets') }}
        </TButton>
        <!-- Detail-screen identity, decorative: the back link names the S3
             bucket list this page came from. -->
        <TIcon name="aws-s3" />
        <TText size="lg" weight="semibold">{{ bucketName }}</TText>
        <TBadge v-if="bucket?.versioning" tone="info" variant="soft">{{ t('buckets.versioning') }}</TBadge>
      </TStack>
      <!-- `loading-label` is not decoration: TButton renders the spinner's
           label as the button's `aria-label`-equivalent text, and its default
           is the English literal "Loading". Without this the busy state of a
           trilingual UI announces in English (rule 6). -->
      <TButton
        size="sm"
        variant="ghost"
        :loading="loadingObjects"
        :loading-label="t('common.loading')"
        @click="loadObjects()"
      >
        {{ t('common.refresh') }}
      </TButton>
    </TStack>

    <TAlert v-if="error" variant="danger" dismissible @dismiss="error = null">
      {{ error }}
    </TAlert>

    <TStack v-if="loading && !bucket" direction="horizontal" justify="center" align="center">
      <TSpinner :label="t('buckets.detailLoading')" />
    </TStack>

    <template v-else-if="bucket">
      <TGrid :columns="4" gap="0.75rem">
        <TStat :label="t('buckets.statObjects')" :value="bucket.objectCount ?? 0" tone="info" />
        <TStat :label="t('common.size')" :value="formatBytes(bucket.totalSize)" tone="neutral" />
        <TStat
          :label="t('buckets.versioning')"
          :value="bucket.versioning ? t('buckets.enabled') : t('buckets.disabled')"
          :tone="bucket.versioning ? 'success' : 'neutral'"
        />
        <TStat
          :label="t('buckets.statNotifications')"
          :value="bucket.notifications ?? 0"
          :tone="(bucket.notifications ?? 0) > 0 ? 'info' : 'neutral'"
        />
      </TGrid>

      <TCard variant="outline">
        <template #header>
          <TText weight="semibold">{{ t('buckets.uploadTitle') }}</TText>
        </template>
        <TStack direction="vertical" gap="0.5rem">
          <!-- TInput/TTextarea carry no `label` prop: the label belongs to
               TFormField. (The key/content-type fields used to pass `:label` to
               TInput — it fell through to `$attrs`, landed on the inner
               `<input>` as a dead `label` attribute and rendered nothing.)
               The `id`/`html-for` pairs these three fields used to repeat by
               hand are gone: TFormField now mints the id and provides it to the
               nested control, which puts it on the real `<input>`/`<textarea>`,
               so the `<label for>` cannot drift from what it labels. -->
          <TFormField :label="t('buckets.keyLabel')">
            <TInput v-model="uploadKey" placeholder="object/key.txt" />
          </TFormField>
          <TFormField :label="t('buckets.contentTypeLabel')">
            <TInput v-model="uploadContentType" placeholder="text/plain" />
          </TFormField>
          <!-- The object body is machine text, so it gets the mono axis from
               the component rather than a local class: `family` lands on the
               `<textarea>` itself, not on the `<label>` that wraps it (that
               wrapper also hosts the loading spinner). -->
          <TFormField :label="t('buckets.bodyLabel')">
            <TTextarea
              v-model="uploadBody"
              family="mono"
              :rows="4"
              :placeholder="t('buckets.bodyPlaceholder')"
            />
          </TFormField>
          <TStack direction="horizontal" justify="flex-end">
            <TButton
              size="sm"
              :loading="uploading"
              :loading-label="t('common.loading')"
              @click="uploadObject"
            >
              {{ t('buckets.upload') }}
            </TButton>
          </TStack>
        </TStack>
      </TCard>

      <TCard variant="outline">
        <template #header>
          <TStack direction="horizontal" gap="0.5rem" align="center" justify="space-between">
            <TText weight="semibold">
              {{ t('buckets.objectsHeader', { count: objects.length, size: formatBytes(totalSize) }) }}
            </TText>
            <TStack direction="horizontal" gap="0.5rem" align="center">
              <TInput
                v-model="prefix"
                :placeholder="t('buckets.prefixPlaceholder')"
                :aria-label="t('buckets.prefixLabel')"
                size="sm"
                @keyup.enter="loadObjects()"
              />
              <TButton size="sm" variant="ghost" @click="loadObjects()">{{ t('buckets.apply') }}</TButton>
            </TStack>
          </TStack>
        </template>

        <TStack v-if="loadingObjects" direction="horizontal" justify="center" align="center">
          <TSpinner :label="t('buckets.objectsLoading')" />
        </TStack>

        <TEmptyState
          v-else-if="!objects.length"
          :title="t('buckets.objectsEmptyTitle')"
          :description="t('buckets.objectsEmptyDescription')"
        />

        <TTable
          v-else
          :columns="objectColumns"
          :rows="objects"
          :aria-label="t('buckets.objectsTableLabel')"
        >
          <template #cell-key="{ row }">
            <!-- No `weight`: TLink already defaults to `medium` (500). -->
            <TLink :href="previewUrl(String(row.key))" external>
              {{ row.key }}
            </TLink>
          </template>
          <template #cell-size="{ row }">
            {{ formatBytes(Number(row.size)) }}
          </template>
          <template #cell-lastModified="{ row }">
            {{ formatDate(row.lastModified as number | undefined) }}
          </template>
          <template #cell-actions="{ row }">
            <TStack direction="horizontal" gap="0.25rem" justify="flex-end">
              <!-- `as="a"` instead of an <a> wrapping a <button>: that nesting
                   is invalid HTML and gave the anchor two focus stops. TButton
                   already sets `text-decoration: none`. -->
              <TButton
                as="a"
                :href="downloadUrl(String(row.key))"
                target="_blank"
                rel="noopener noreferrer"
                size="sm"
                variant="ghost"
              >
                {{ t('buckets.download') }}
              </TButton>
              <!-- `tone` is a real TButton prop since 0.29, and this row is
                   why it exists: on `ghost` it inks only the label, so Delete
                   reads destructive next to a quiet Download instead of
                   outweighing it the way a filled `variant="danger"` would.
                   Writing `variant="ghost" tone="danger"` here used to be a
                   guess — the prop did not exist and Vue dropped it silently,
                   leaving this button indistinguishable from Download. -->
              <TButton
                size="sm"
                variant="ghost"
                tone="danger"
                @click="deleteObject(String(row.key))"
              >
                {{ t('common.delete') }}
              </TButton>
            </TStack>
          </template>
        </TTable>
      </TCard>
    </template>
  </TStack>
</template>
