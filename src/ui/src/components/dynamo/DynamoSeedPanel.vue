<script setup lang="ts">
import { ref } from 'vue';
import {
  TCard, TButton, TStack, TBadge, TConfirmDialog, TText, useToast,
} from '@treeui/vue';
import { api } from '../../services/api';

const props = defineProps<{
  tableName: string;
  seedFile: string;
  seedItemCount: number;
  tableItemCount: number;
}>();

const emit = defineEmits<{ (e: 'refresh'): void }>();

const toast = useToast();
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
        title: `Seed skipped`,
        description: `${props.tableName}: ${skipped.reason || 'unknown reason'}`,
        variant: 'warning',
      });
    } else {
      toast.add({
        title: `Seed applied`,
        description: `${inserted} item(s) inserted into ${props.tableName}`,
        variant: 'success',
      });
    }
    emit('refresh');
  } catch (err: any) {
    toast.add({ title: 'Seed failed', description: err.message, variant: 'danger' });
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
      title: `Table purged`,
      description: `${deleted} item(s) removed from ${props.tableName}`,
      variant: 'info',
    });
    emit('refresh');
  } catch (err: any) {
    toast.add({ title: 'Purge failed', description: err.message, variant: 'danger' });
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
      title: `Seed redone`,
      description: `${deleted} removed, ${inserted} inserted in ${props.tableName}`,
      variant: 'success',
    });
    emit('refresh');
  } catch (err: any) {
    toast.add({ title: 'Redo failed', description: err.message, variant: 'danger' });
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
          <TText weight="semibold">Seed file</TText>
          <TBadge tone="info" variant="soft">
            {{ seedItemCount }} item{{ seedItemCount === 1 ? '' : 's' }}
          </TBadge>
        </TStack>
      </template>

      <TStack direction="vertical" gap="0.5rem">
        <TStack direction="horizontal" justify="space-between" align="center">
          <TText tone="muted">Path</TText>
          <TText family="mono" size="sm">{{ seedFile }}</TText>
        </TStack>
        <TStack direction="horizontal" justify="space-between" align="center">
          <TText tone="muted">Current rows in table</TText>
          <TText family="mono">{{ tableItemCount }}</TText>
        </TStack>
      </TStack>
    </TCard>

    <TCard variant="outline">
      <template #header>
        <TText weight="semibold">Actions</TText>
      </template>

      <TStack direction="vertical" gap="0.75rem">
        <TStack direction="horizontal" justify="space-between" align="center" gap="1rem">
          <TStack direction="vertical" gap="0.125rem">
            <TText weight="semibold">Apply seed</TText>
            <TText tone="muted" size="sm">
              Inserts every item from the seed file. Existing items with the same key are overwritten.
            </TText>
          </TStack>
          <TButton
            variant="solid"
            :loading="applying"
            :disabled="seedItemCount <= 0"
            @click="apply"
          >
            Apply
          </TButton>
        </TStack>

        <TStack direction="horizontal" justify="space-between" align="center" gap="1rem">
          <TStack direction="vertical" gap="0.125rem">
            <TText weight="semibold">Redo seed</TText>
            <TText tone="muted" size="sm">
              Purges the table first, then re-applies the seed file. Use when stale rows are blocking a fresh load.
            </TText>
          </TStack>
          <TButton
            variant="soft"
            :loading="redoing"
            :disabled="seedItemCount <= 0"
            @click="redoDialog = true"
          >
            Redo
          </TButton>
        </TStack>

        <TStack direction="horizontal" justify="space-between" align="center" gap="1rem">
          <TStack direction="vertical" gap="0.125rem">
            <TText weight="semibold">Purge table</TText>
            <TText tone="muted" size="sm">
              Deletes every item currently in this table. The seed file is not touched.
            </TText>
          </TStack>
          <TButton
            variant="danger"
            :loading="purging"
            @click="purgeDialog = true"
          >
            Purge
          </TButton>
        </TStack>
      </TStack>
    </TCard>

    <TConfirmDialog
      v-model:open="purgeDialog"
      :title="`Purge ${tableName}?`"
      :description="`This deletes all ${tableItemCount} item(s) currently in the table. The seed file on disk is not affected.`"
      confirm-label="Purge"
      cancel-label="Cancel"
      confirm-variant="danger"
      @confirm="purge"
    />

    <TConfirmDialog
      v-model:open="redoDialog"
      :title="`Redo seed for ${tableName}?`"
      :description="`This purges all ${tableItemCount} current item(s), then re-applies ${seedItemCount} seeded item(s).`"
      confirm-label="Redo"
      cancel-label="Cancel"
      confirm-variant="danger"
      @confirm="redo"
    />
  </TStack>
</template>
