<script setup lang="ts">
import { ref } from 'vue';
import {
  TCard, TButton, TStack, TBadge, TConfirmDialog, TText, TDescriptionList, TDescriptionItem, useToast,
} from '@treeui/vue';
import { api } from '../../services/api';
import { useI18n } from '../../i18n';

const props = defineProps<{
  tableName: string;
  seedFile: string;
  seedItemCount: number;
  tableItemCount: number;
}>();

const emit = defineEmits<{ (e: 'refresh'): void }>();

const { t } = useI18n();
const toast = useToast();

// Rendered from the template so t() runs per render and the badge follows a
// language switch.
function itemsLabel(count: number): string {
  return count === 1 ? t('dynamo.itemOne', { count }) : t('dynamo.itemOther', { count });
}
const applying = ref(false);
const redoing = ref(false);
const purging = ref(false);
const purgeDialog = ref(false);
const redoDialog = ref(false);

async function apply() {
  if (applying.value) return;
  applying.value = true;
  try {
    const res = await api.runSeed(props.tableName);
    const inserted = res.results.reduce((s, r) => s + (r.inserted || 0), 0);
    const skipped = res.results.find(r => r.skipped);
    if (skipped) {
      toast.add({
        title: t('dynamo.seedSkipped'),
        description: `${props.tableName}: ${skipped.reason || t('dynamo.unknownReason')}`,
        variant: 'warning',
      });
    } else {
      toast.add({
        title: t('dynamo.seedApplied'),
        description: t('dynamo.seedAppliedDesc', { count: inserted, table: props.tableName }),
        variant: 'success',
      });
    }
    emit('refresh');
  } catch (err: any) {
    toast.add({ title: t('dynamo.seedFailed'), description: err.message, variant: 'danger' });
  } finally {
    applying.value = false;
  }
}

async function purge() {
  if (purging.value) return;
  purging.value = true;
  try {
    const res = await api.clearSeed(props.tableName);
    const deleted = res.results.reduce((s, r) => s + (r.deleted || 0), 0);
    toast.add({
      title: t('dynamo.tablePurged'),
      description: t('dynamo.purgedDesc', { count: deleted, table: props.tableName }),
      variant: 'info',
    });
    emit('refresh');
  } catch (err: any) {
    toast.add({ title: t('dynamo.purgeFailed'), description: err.message, variant: 'danger' });
  } finally {
    purging.value = false;
    purgeDialog.value = false;
  }
}

async function redo() {
  if (redoing.value) return;
  redoing.value = true;
  try {
    const clearRes = await api.clearSeed(props.tableName);
    const deleted = clearRes.results.reduce((s, r) => s + (r.deleted || 0), 0);
    const runRes = await api.runSeed(props.tableName);
    const inserted = runRes.results.reduce((s, r) => s + (r.inserted || 0), 0);
    toast.add({
      title: t('dynamo.seedRedone'),
      description: t('dynamo.redoneDesc', { deleted, inserted, table: props.tableName }),
      variant: 'success',
    });
    emit('refresh');
  } catch (err: any) {
    toast.add({ title: t('dynamo.redoFailed'), description: err.message, variant: 'danger' });
  } finally {
    redoing.value = false;
    redoDialog.value = false;
  }
}
</script>

<template>
  <TStack direction="vertical" gap="1rem">
    <TCard variant="outline">
      <template #header>
        <TStack direction="horizontal" justify="space-between" align="center">
          <TText weight="semibold">{{ t('dynamo.seedFile') }}</TText>
          <TBadge tone="info" variant="soft">
            {{ itemsLabel(seedItemCount) }}
          </TBadge>
        </TStack>
      </template>

      <TDescriptionList>
        <TDescriptionItem :label="t('dynamo.path')">
          <TText family="mono" size="sm">{{ seedFile }}</TText>
        </TDescriptionItem>
        <TDescriptionItem :label="t('dynamo.currentRows')">
          <TText family="mono">{{ tableItemCount }}</TText>
        </TDescriptionItem>
      </TDescriptionList>
    </TCard>

    <TCard variant="outline">
      <template #header>
        <TText weight="semibold">{{ t('common.actions') }}</TText>
      </template>

      <TStack direction="vertical" gap="0.75rem">
        <TStack direction="horizontal" justify="space-between" align="center" gap="1rem">
          <TStack direction="vertical" gap="0.125rem">
            <TText weight="semibold">{{ t('dynamo.applySeed') }}</TText>
            <TText tone="muted" size="sm">
              {{ t('dynamo.applySeedDesc') }}
            </TText>
          </TStack>
          <TButton
            variant="solid"
            :loading="applying"
            :disabled="seedItemCount <= 0"
            @click="apply"
          >
            {{ t('dynamo.apply') }}
          </TButton>
        </TStack>

        <TStack direction="horizontal" justify="space-between" align="center" gap="1rem">
          <TStack direction="vertical" gap="0.125rem">
            <TText weight="semibold">{{ t('dynamo.redoSeed') }}</TText>
            <TText tone="muted" size="sm">
              {{ t('dynamo.redoSeedDesc') }}
            </TText>
          </TStack>
          <TButton
            variant="soft"
            :loading="redoing"
            :disabled="seedItemCount <= 0"
            @click="redoDialog = true"
          >
            {{ t('dynamo.redo') }}
          </TButton>
        </TStack>

        <TStack direction="horizontal" justify="space-between" align="center" gap="1rem">
          <TStack direction="vertical" gap="0.125rem">
            <TText weight="semibold">{{ t('dynamo.purgeTable') }}</TText>
            <TText tone="muted" size="sm">
              {{ t('dynamo.purgeTableDesc') }}
            </TText>
          </TStack>
          <TButton
            variant="danger"
            :loading="purging"
            @click="purgeDialog = true"
          >
            {{ t('dynamo.purge') }}
          </TButton>
        </TStack>
      </TStack>
    </TCard>

    <TConfirmDialog
      v-model:open="purgeDialog"
      :title="t('dynamo.purgeConfirmTitle', { table: tableName })"
      :description="t('dynamo.purgeConfirmDesc', { count: tableItemCount })"
      :confirm-label="t('dynamo.purge')"
      :cancel-label="t('common.cancel')"
      confirm-variant="danger"
      @confirm="purge"
    />

    <TConfirmDialog
      v-model:open="redoDialog"
      :title="t('dynamo.redoConfirmTitle', { table: tableName })"
      :description="t('dynamo.redoConfirmDesc', { current: tableItemCount, seeded: seedItemCount })"
      :confirm-label="t('dynamo.redo')"
      :cancel-label="t('common.cancel')"
      confirm-variant="danger"
      @confirm="redo"
    />
  </TStack>
</template>
