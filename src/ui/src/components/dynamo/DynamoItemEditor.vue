<script setup lang="ts">
import { ref, computed, watch } from 'vue';
import {
  TModal, TButton, TStack, TTextarea, TAlert, TBadge, useToast,
} from '@treeui/vue';
import { api } from '../../services/api';

type Mode = 'create' | 'edit' | 'view';

const props = defineProps<{
  open: boolean;
  tableName: string;
  mode: Mode;
  // For edit/view: pre-loaded item (already unmarshalled JSON object)
  item?: Record<string, unknown> | null;
  // For edit: key extracted from the original item (so we can detect key changes)
  originalKey?: Record<string, unknown> | null;
}>();

const emit = defineEmits<{
  (e: 'update:open', value: boolean): void;
  (e: 'saved'): void;
  (e: 'request-edit'): void;
  (e: 'request-clone'): void;
  (e: 'request-delete'): void;
}>();

const toast = useToast();
const draft = ref<string>('');
const parseError = ref<string | null>(null);
const saving = ref(false);

const isOpen = computed({
  get: () => props.open,
  set: (v: boolean) => emit('update:open', v),
});

const title = computed(() => {
  if (props.mode === 'create') return `Create item · ${props.tableName}`;
  if (props.mode === 'view') return `View item · ${props.tableName}`;
  return `Edit item · ${props.tableName}`;
});

const readOnly = computed(() => props.mode === 'view');

watch(
  () => [props.open, props.item, props.mode] as const,
  ([open]) => {
    if (open) {
      draft.value =
        props.item && Object.keys(props.item).length
          ? JSON.stringify(props.item, null, 2)
          : '{\n  \n}';
      parseError.value = null;
    }
  },
  { immediate: true },
);

function tryParse(): Record<string, unknown> | null {
  try {
    const parsed = JSON.parse(draft.value);
    if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) {
      parseError.value = 'Item must be a JSON object';
      return null;
    }
    parseError.value = null;
    return parsed as Record<string, unknown>;
  } catch (e: any) {
    parseError.value = e.message;
    return null;
  }
}

async function save() {
  const parsed = tryParse();
  if (!parsed) return;
  saving.value = true;
  try {
    // For edit, if the key attributes were changed, the old row would be orphaned.
    // Delete the original first to behave like an "update" instead of leaving a duplicate.
    if (props.mode === 'edit' && props.originalKey) {
      const keyChanged = Object.entries(props.originalKey).some(
        ([k, v]) => JSON.stringify(parsed[k]) !== JSON.stringify(v),
      );
      if (keyChanged) {
        await api.deleteDynamoItem(props.tableName, props.originalKey);
      }
    }
    await api.putDynamoItem(props.tableName, parsed);
    toast.add({
      title: props.mode === 'create' ? 'Item created' : 'Item saved',
      variant: 'success',
    });
    emit('saved');
    isOpen.value = false;
  } catch (err: any) {
    toast.add({ title: 'Save failed', description: err.message, variant: 'danger' });
  } finally {
    saving.value = false;
  }
}

function formatDraft() {
  const parsed = tryParse();
  if (parsed) draft.value = JSON.stringify(parsed, null, 2);
}
</script>

<template>
  <TModal v-model:open="isOpen" :title="title" size="lg">
    <TStack direction="vertical" gap="0.75rem">
      <TAlert v-if="parseError" variant="danger">
        {{ parseError }}
      </TAlert>

      <TStack direction="horizontal" gap="0.5rem" align="center" justify="space-between">
        <span class="muted" style="font-size: 0.75rem;">
          JSON object. Types are inferred — numbers, booleans, strings, arrays, nested objects are all supported.
        </span>
        <TBadge v-if="readOnly" tone="neutral" variant="soft">read-only</TBadge>
      </TStack>

      <TTextarea
        v-model="draft"
        :rows="18"
        :readonly="readOnly"
        spellcheck="false"
        class="mono"
        @blur="tryParse"
      />
    </TStack>

    <template #footer>
      <TStack direction="horizontal" gap="0.5rem" justify="space-between">
        <TStack direction="horizontal" gap="0.5rem">
          <TButton v-if="!readOnly" size="sm" variant="ghost" @click="formatDraft">
            Format JSON
          </TButton>
          <template v-if="readOnly">
            <TButton size="sm" variant="soft" @click="emit('request-edit')">Edit</TButton>
            <TButton size="sm" variant="ghost" @click="emit('request-clone')">Clone</TButton>
            <TButton size="sm" variant="ghost" tone="danger" @click="emit('request-delete')">Delete</TButton>
          </template>
        </TStack>
        <TStack direction="horizontal" gap="0.5rem">
          <TButton size="sm" variant="ghost" @click="isOpen = false">
            {{ readOnly ? 'Close' : 'Cancel' }}
          </TButton>
          <TButton
            v-if="!readOnly"
            size="sm"
            variant="solid"
            :loading="saving"
            :disabled="!!parseError"
            @click="save"
          >
            {{ mode === 'create' ? 'Create' : 'Save' }}
          </TButton>
        </TStack>
      </TStack>
    </template>
  </TModal>
</template>
