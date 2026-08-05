<script setup lang="ts">
import { ref, computed, watch } from 'vue';
import {
  TModal, TButton, TStack, TTextarea, TAlert, TBadge, TText, useToast,
} from '@treeui/vue';
import { api } from '../../services/api';
import { useI18n } from '../../i18n';

const { t } = useI18n();

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
  if (props.mode === 'create') return t('dynamo.editorCreateTitle', { table: props.tableName });
  if (props.mode === 'view') return t('dynamo.editorViewTitle', { table: props.tableName });
  return t('dynamo.editorEditTitle', { table: props.tableName });
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
      parseError.value = t('dynamo.errItemNotObject');
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
      title: props.mode === 'create' ? t('dynamo.itemCreated') : t('dynamo.itemSaved'),
      variant: 'success',
    });
    emit('saved');
    isOpen.value = false;
  } catch (err: any) {
    toast.add({ title: t('dynamo.saveFailed'), description: err.message, variant: 'danger' });
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
        <TText tone="muted" size="xs">
          {{ t('dynamo.editorHint') }}
        </TText>
        <TBadge v-if="readOnly" tone="neutral" variant="soft">{{ t('dynamo.readOnly') }}</TBadge>
      </TStack>

      <TTextarea
        v-model="draft"
        :rows="18"
        :readonly="readOnly"
        spellcheck="false"
        family="mono"
        @blur="tryParse"
      />
    </TStack>

    <template #footer>
      <TStack direction="horizontal" gap="0.5rem" justify="space-between">
        <TStack direction="horizontal" gap="0.5rem">
          <TButton v-if="!readOnly" size="sm" variant="ghost" @click="formatDraft">
            {{ t('dynamo.formatJson') }}
          </TButton>
          <template v-if="readOnly">
            <TButton size="sm" variant="soft" @click="emit('request-edit')">{{ t('dynamo.edit') }}</TButton>
            <TButton size="sm" variant="ghost" @click="emit('request-clone')">{{ t('dynamo.clone') }}</TButton>
            <!-- Destructive intent is a TButton *variant*, not a tone: `tone`
                 is not a TButton prop, so it fell through to the <button> as an
                 inert attribute and the delete action rendered like the others. -->
            <TButton size="sm" variant="danger" @click="emit('request-delete')">{{ t('common.delete') }}</TButton>
          </template>
        </TStack>
        <TStack direction="horizontal" gap="0.5rem">
          <TButton size="sm" variant="ghost" @click="isOpen = false">
            {{ readOnly ? t('common.close') : t('common.cancel') }}
          </TButton>
          <TButton
            v-if="!readOnly"
            size="sm"
            variant="solid"
            :loading="saving"
            :disabled="!!parseError"
            @click="save"
          >
            {{ mode === 'create' ? t('dynamo.create') : t('common.save') }}
          </TButton>
        </TStack>
      </TStack>
    </template>
  </TModal>
</template>
