<script setup lang="ts">
// Settings: edit lss.config.json from the dashboard. Saving PUTs only the
// fields the user actually changed, so resolved defaults and env-var values
// are never baked into the file; the human reviews and commits the diff.
// Boot-materialized keys come back in restartRequired (lss stop && lss start).
import { computed, onMounted, reactive, ref } from 'vue';
import {
  TCard, TStack, TGrid, TBadge, TButton, TSpinner, TText, TIcon, TAlert,
  TFormField, TInput, TSelect, TSwitch, TToggleGroup, useToast,
} from '@treeui/vue';
import { api } from '../services/api';
import type { LssConfigSnapshot, LssConfigUpdate } from '../services/api';
import { regionOptions } from '../services/region';
import { useI18n } from '../i18n';

const { t } = useI18n();
const toast = useToast();
const snapshot = ref<LssConfigSnapshot | null>(null);
const loading = ref(true);
const saving = ref(false);
const reloading = ref(false);
const error = ref<string | null>(null);
const restartKeys = ref<string[]>([]);
const envMasked = ref<string[]>([]);

// Computed rather than module consts: the labels must go through t() on every
// render so a language switch re-labels the options without a reload.
const executionOptions = computed(() => [
  { value: 'auto', label: t('settings.executionAuto') },
  { value: 'artifact', label: t('settings.executionArtifact') },
  { value: 'source', label: t('settings.executionSource') },
]);
const watchOptions = computed(() => [
  { value: 'default', label: t('settings.watchDefault') },
  { value: 'on', label: t('settings.watchOn') },
  { value: 'off', label: t('settings.watchOff') },
]);
const themeOptions = computed(() => [
  { value: 'dark', label: t('settings.themeDark') },
  { value: 'light', label: t('settings.themeLight') },
]);

// Flat form model — every field scalar so dirty tracking is a plain compare.
const form = reactive({
  serverPort: 3100,
  region: 'us-east-1',
  persistence: true,
  debug: false,
  sePort: 14566,
  seAccount: '000000000000',
  seMemoryBudgetMb: 128,
  seIdleUnloadMs: 300000,
  seFsync: false,
  seFallback: '',
  proxyEnabled: false,
  proxyPort: 8000,
  lrEnabled: true,
  lrExecution: 'auto',
  lrWatch: 'default',
  lrInvokePortOffset: 10000,
  lrInvokeHost: '',
  autoPackage: false,
  packageCommand: '',
  packageTimeoutMs: 300000,
  seedsDir: '',
  brTitle: '',
  brSubtitle: '',
  brTheme: 'dark',
});

type FormKey = keyof typeof form;
let original: Record<FormKey, unknown> | null = null;

function formValues(): Record<FormKey, unknown> {
  return { ...form };
}

function applySnapshot(s: LssConfigSnapshot) {
  snapshot.value = s;
  form.serverPort = s.serverPort;
  form.region = s.region;
  form.persistence = s.persistence;
  form.debug = s.debug;
  form.sePort = s.selfEngine.port;
  form.seAccount = s.selfEngine.account;
  form.seMemoryBudgetMb = s.selfEngine.memoryBudgetMb;
  form.seIdleUnloadMs = s.selfEngine.idleUnloadMs;
  form.seFsync = s.selfEngine.fsync;
  form.seFallback = s.selfEngine.fallbackEndpoint || '';
  form.proxyEnabled = s.dynamoProxy.enabled;
  form.proxyPort = s.dynamoProxy.port;
  form.lrEnabled = s.lambdaRuntime.enabled;
  form.lrExecution = s.lambdaRuntime.execution;
  form.lrWatch = s.lambdaRuntime.watch === null ? 'default' : s.lambdaRuntime.watch ? 'on' : 'off';
  form.lrInvokePortOffset = s.lambdaRuntime.invokePortOffset;
  form.lrInvokeHost = s.lambdaRuntime.invokeHost;
  form.autoPackage = s.autoPackage;
  form.packageCommand = s.packageCommand;
  form.packageTimeoutMs = s.packageTimeoutMs;
  form.seedsDir = s.seedsDir;
  form.brTitle = s.branding.title;
  form.brSubtitle = s.branding.subtitle;
  form.brTheme = s.branding.defaultTheme;
  original = formValues();
}

const dirtyKeys = computed<FormKey[]>(() => {
  if (!original) return [];
  const current = formValues();
  return (Object.keys(current) as FormKey[]).filter(key => current[key] !== original![key]);
});
const dirtyCount = computed(() => dirtyKeys.value.length);

function isEnvMasked(configKey: string): boolean {
  return Boolean(snapshot.value?.envOverrides.includes(configKey));
}

function envHint(configKey: string, normal: string): string {
  return isEnvMasked(configKey) ? t('settings.maskedByEnv') : normal;
}

// Only the fields the user touched go into the patch; a blank optional string
// becomes null, which deletes the override from the file (default returns).
function buildPatch(): { patch: LssConfigUpdate; errors: string[] } {
  const errors: string[] = [];
  const dirty = new Set<FormKey>(dirtyKeys.value);
  const patch: LssConfigUpdate = {};

  const asPort = (value: unknown, label: string): number => {
    const n = Number(value);
    if (!Number.isInteger(n) || n < 1 || n > 65535) {
      errors.push(t('settings.errorPort', { label }));
    }
    return n;
  };
  const asPositive = (value: unknown, label: string): number => {
    const n = Number(value);
    if (!Number.isInteger(n) || n <= 0) {
      errors.push(t('settings.errorPositive', { label }));
    }
    return n;
  };
  const orNull = (value: string): string | null => value.trim() || null;

  if (dirty.has('serverPort')) patch.serverPort = asPort(form.serverPort, t('settings.serverPort'));
  if (dirty.has('region')) patch.region = form.region;
  if (dirty.has('persistence')) patch.persistence = form.persistence;
  if (dirty.has('debug')) patch.debug = form.debug;
  if (dirty.has('proxyEnabled')) patch.enableDynamoProxy = form.proxyEnabled;
  if (dirty.has('proxyPort')) patch.dynamoProxyPort = asPort(form.proxyPort, t('settings.proxyPort'));
  if (dirty.has('autoPackage')) patch.autoPackage = form.autoPackage;
  if (dirty.has('packageCommand')) patch.packageCommand = orNull(form.packageCommand);
  if (dirty.has('packageTimeoutMs')) patch.packageTimeoutMs = asPositive(form.packageTimeoutMs, t('settings.packageTimeout'));
  if (dirty.has('seedsDir')) patch.seedsDir = orNull(form.seedsDir);

  const selfEngine: NonNullable<LssConfigUpdate['selfEngine']> = {};
  if (dirty.has('sePort')) selfEngine.port = asPort(form.sePort, t('settings.selfEnginePort'));
  if (dirty.has('seAccount')) {
    if (!form.seAccount.trim()) errors.push(t('settings.errorAccountEmpty'));
    selfEngine.account = form.seAccount.trim();
  }
  if (dirty.has('seMemoryBudgetMb')) selfEngine.memoryBudgetMb = asPositive(form.seMemoryBudgetMb, t('settings.memoryBudget'));
  if (dirty.has('seIdleUnloadMs')) selfEngine.idleUnloadMs = asPositive(form.seIdleUnloadMs, t('settings.idleUnload'));
  if (dirty.has('seFsync')) selfEngine.fsync = form.seFsync;
  if (dirty.has('seFallback')) selfEngine.fallbackEndpoint = orNull(form.seFallback);
  if (Object.keys(selfEngine).length) patch.selfEngine = selfEngine;

  const lambdaRuntime: NonNullable<LssConfigUpdate['lambdaRuntime']> = {};
  if (dirty.has('lrEnabled')) lambdaRuntime.enabled = form.lrEnabled;
  if (dirty.has('lrExecution')) lambdaRuntime.execution = form.lrExecution as 'auto' | 'artifact' | 'source';
  if (dirty.has('lrWatch')) lambdaRuntime.watch = form.lrWatch === 'default' ? null : form.lrWatch === 'on';
  if (dirty.has('lrInvokePortOffset')) lambdaRuntime.invokePortOffset = asPositive(form.lrInvokePortOffset, t('settings.invokePortOffset'));
  if (dirty.has('lrInvokeHost')) lambdaRuntime.invokeHost = orNull(form.lrInvokeHost);
  if (Object.keys(lambdaRuntime).length) patch.lambdaRuntime = lambdaRuntime;

  const branding: NonNullable<LssConfigUpdate['branding']> = {};
  if (dirty.has('brTitle')) branding.title = orNull(form.brTitle);
  if (dirty.has('brSubtitle')) branding.subtitle = orNull(form.brSubtitle);
  if (dirty.has('brTheme')) branding.defaultTheme = form.brTheme as 'dark' | 'light';
  if (Object.keys(branding).length) patch.branding = branding;

  return { patch, errors };
}

async function load() {
  try {
    applySnapshot(await api.getConfig());
  } catch (err) {
    error.value = err instanceof Error ? err.message : t('settings.loadFailed');
  } finally {
    loading.value = false;
  }
}

async function save() {
  const { patch, errors } = buildPatch();
  if (errors.length) {
    error.value = errors.join('; ');
    return;
  }
  saving.value = true;
  error.value = null;
  // The form stays interactive while the PUT is in flight; anything edited in
  // that window is re-applied over the fresh snapshot below so it stays dirty
  // instead of being silently clobbered.
  const atClick = formValues();
  try {
    const res = await api.updateConfig(patch);
    const during = formValues();
    applySnapshot(res.config);
    (Object.keys(during) as FormKey[]).forEach(key => {
      if (during[key] !== atClick[key]) {
        (form as unknown as Record<FormKey, unknown>)[key] = during[key];
      }
    });
    restartKeys.value = res.restartRequired;
    envMasked.value = res.envOverridden;
    toast.add({
      title: t('settings.savedTitle'),
      description: t('settings.savedDescription', { path: res.configPath }),
      variant: 'success',
    });
  } catch (err) {
    error.value = err instanceof Error ? err.message : t('settings.saveFailed');
  } finally {
    saving.value = false;
  }
}

async function reloadFromDisk() {
  reloading.value = true;
  error.value = null;
  try {
    const res = await api.reloadConfig();
    applySnapshot(res.config);
    restartKeys.value = res.restartRequired;
    envMasked.value = [];
    toast.add({
      title: t('settings.reloadedTitle'),
      description: res.configPath || t('settings.reloadedNoFile'),
      variant: 'success',
    });
  } catch (err) {
    error.value = err instanceof Error ? err.message : t('settings.reloadFailed');
  } finally {
    reloading.value = false;
  }
}

function discard() {
  if (snapshot.value) applySnapshot(snapshot.value);
}

onMounted(load);
</script>

<template>
  <TStack direction="vertical" gap="1.5rem">
    <TCard variant="outline">
      <TStack direction="vertical" gap="0.75rem">
        <TStack direction="horizontal" justify="space-between" align="center" wrap gap="0.75rem">
          <TStack direction="horizontal" gap="0.75rem" align="center">
            <TIcon name="settings" />
            <TStack direction="vertical" gap="0.125rem">
              <TText size="xl" weight="semibold">{{ t('settings.title') }}</TText>
              <TText tone="muted" size="sm">
                {{ t('settings.subtitle') }}
              </TText>
            </TStack>
          </TStack>
          <TStack direction="horizontal" gap="0.5rem" align="center" wrap>
            <TBadge v-if="dirtyCount" tone="warning" variant="soft">
              {{ dirtyCount > 1
                ? t('settings.unsavedChanges', { count: dirtyCount })
                : t('settings.unsavedChange', { count: dirtyCount }) }}
            </TBadge>
            <TButton size="sm" variant="ghost" @click="$router.push('/onboarding')">
              {{ t('settings.reopenOnboarding') }}
            </TButton>
            <TButton size="sm" variant="outline" :loading="reloading" @click="reloadFromDisk">
              <template #icon><TIcon name="refresh-cw" /></template>
              {{ t('settings.reloadFromDisk') }}
            </TButton>
            <TButton size="sm" variant="ghost" :disabled="!dirtyCount || saving" @click="discard">
              {{ t('settings.discard') }}
            </TButton>
            <TButton size="sm" variant="solid" :loading="saving" :disabled="!dirtyCount" @click="save">
              {{ t('settings.saveChanges') }}
            </TButton>
          </TStack>
        </TStack>
        <TText tone="muted" size="xs" family="mono">
          {{ snapshot?.configPath
            || t('settings.noConfigFile', { root: snapshot?.projectRoot || t('settings.projectRoot') }) }}
        </TText>
      </TStack>
    </TCard>

    <TAlert v-if="error" variant="danger" dismissible @dismiss="error = null">
      {{ error }}
    </TAlert>

    <TAlert v-if="restartKeys.length" variant="warning" dismissible @dismiss="restartKeys = []">
      {{ t('settings.restartRequired', { keys: restartKeys.join(', ') }) }}
      {{ t('settings.restartRun') }} <TText family="mono">lss stop &amp;&amp; lss start</TText>
      {{ t('settings.restartTask') }}
    </TAlert>

    <TAlert v-if="envMasked.length" variant="info" dismissible @dismiss="envMasked = []">
      {{ t('settings.envMaskedAlert', { keys: envMasked.join(', ') }) }}
    </TAlert>

    <TStack v-if="loading" direction="horizontal" justify="center" align="center">
      <TSpinner :label="t('settings.loadingConfig')" />
    </TStack>

    <template v-else-if="snapshot">
      <TGrid :columns="2" gap="1rem">
        <TCard variant="outline">
          <template #header>
            <TText weight="semibold">{{ t('settings.serverCard') }}</TText>
          </template>
          <TStack direction="vertical" gap="0.75rem">
            <TFormField :label="t('settings.serverPort')" :hint="envHint('serverPort', t('settings.serverPortHint'))">
              <TInput v-model.number="form.serverPort" type="number" min="1" max="65535" />
            </TFormField>
            <TFormField :label="t('settings.defaultRegion')" :hint="envHint('region', t('settings.defaultRegionHint'))">
              <TSelect v-model="form.region" :options="regionOptions" />
            </TFormField>
            <TFormField :label="t('settings.persistence')" :hint="envHint('persistence', t('settings.persistenceHint'))">
              <TSwitch v-model="form.persistence" />
            </TFormField>
            <TFormField :label="t('settings.debug')" :hint="envHint('debug', t('settings.debugHint'))">
              <TSwitch v-model="form.debug" />
            </TFormField>
            <TFormField :label="t('settings.seedsDir')" :hint="envHint('seedsDir', t('settings.seedsDirHint'))">
              <TInput v-model="form.seedsDir" placeholder="./seeds" />
            </TFormField>
          </TStack>
        </TCard>

        <TCard variant="outline">
          <template #header>
            <TStack direction="horizontal" justify="space-between" align="center">
              <TText weight="semibold">{{ t('settings.engineCard') }}</TText>
              <TBadge tone="info" variant="soft">{{ t('settings.engineBadge') }}</TBadge>
            </TStack>
          </template>
          <TStack direction="vertical" gap="0.75rem">
            <TGrid :columns="2" gap="0.75rem">
              <TFormField :label="t('common.port')" :hint="envHint('selfEngine', t('settings.enginePortHint'))">
                <TInput v-model.number="form.sePort" type="number" min="1" max="65535" />
              </TFormField>
              <TFormField :label="t('settings.accountId')" :hint="t('settings.accountIdHint')">
                <TInput v-model="form.seAccount" placeholder="000000000000" />
              </TFormField>
              <TFormField :label="t('settings.memoryBudget')" :hint="t('settings.memoryBudgetHint')">
                <TInput v-model.number="form.seMemoryBudgetMb" type="number" min="1" />
              </TFormField>
              <TFormField :label="t('settings.idleUnload')" :hint="t('settings.idleUnloadHint')">
                <TInput v-model.number="form.seIdleUnloadMs" type="number" min="1" />
              </TFormField>
            </TGrid>
            <TFormField :label="t('settings.fsync')" :hint="t('settings.fsyncHint')">
              <TSwitch v-model="form.seFsync" />
            </TFormField>
            <TFormField :label="t('settings.fallbackEndpoint')" :hint="t('settings.fallbackEndpointHint')">
              <TInput v-model="form.seFallback" placeholder="" />
            </TFormField>
            <TText tone="muted" size="xs" family="mono">
              {{ t('settings.dataDir', { path: snapshot.selfEngine.dataDir }) }}
            </TText>
          </TStack>
        </TCard>

        <TCard variant="outline">
          <template #header>
            <TText weight="semibold">{{ t('settings.lambdaRuntimeCard') }}</TText>
          </template>
          <TStack direction="vertical" gap="0.75rem">
            <TFormField
              :label="t('settings.lambdaRuntimeEnabled')"
              :hint="envHint('lambdaRuntime', t('settings.lambdaRuntimeEnabledHint'))"
            >
              <TSwitch v-model="form.lrEnabled" />
            </TFormField>
            <TFormField :label="t('settings.execution')" :hint="t('settings.executionHint')">
              <TToggleGroup v-model="form.lrExecution" :options="executionOptions" size="md" />
            </TFormField>
            <TFormField :label="t('settings.watch')" :hint="t('settings.watchHint')">
              <TSelect v-model="form.lrWatch" :options="watchOptions" />
            </TFormField>
            <TGrid :columns="2" gap="0.75rem">
              <TFormField :label="t('settings.invokePortOffset')" :hint="t('settings.invokePortOffsetHint')">
                <TInput v-model.number="form.lrInvokePortOffset" type="number" min="1" />
              </TFormField>
              <TFormField :label="t('settings.invokeHost')" :hint="t('settings.invokeHostHint')">
                <TInput v-model="form.lrInvokeHost" placeholder="host.docker.internal" />
              </TFormField>
            </TGrid>
          </TStack>
        </TCard>

        <TCard variant="outline">
          <template #header>
            <TText weight="semibold">{{ t('settings.dynamoProxy') }}</TText>
          </template>
          <TStack direction="vertical" gap="0.75rem">
            <TFormField
              :label="t('settings.dynamoProxy')"
              :hint="envHint('enableDynamoProxy', t('settings.dynamoProxyHint'))"
            >
              <TSwitch v-model="form.proxyEnabled" />
            </TFormField>
            <TFormField :label="t('settings.proxyPort')" :hint="envHint('dynamoProxyPort', t('settings.proxyPortHint'))">
              <TInput v-model.number="form.proxyPort" type="number" min="1" max="65535" :disabled="!form.proxyEnabled" />
            </TFormField>
          </TStack>
        </TCard>

        <TCard variant="outline">
          <template #header>
            <TText weight="semibold">{{ t('settings.packagingCard') }}</TText>
          </template>
          <TStack direction="vertical" gap="0.75rem">
            <TFormField :label="t('settings.autoPackage')" :hint="envHint('autoPackage', t('settings.autoPackageHint'))">
              <TSwitch v-model="form.autoPackage" />
            </TFormField>
            <TFormField
              :label="t('settings.packageCommand')"
              :hint="envHint('packageCommand', t('settings.packageCommandHint'))"
            >
              <TInput v-model="form.packageCommand" placeholder="npx serverless package" />
            </TFormField>
            <TFormField
              :label="t('settings.packageTimeout')"
              :hint="envHint('packageTimeoutMs', t('settings.packageTimeoutHint'))"
            >
              <TInput v-model.number="form.packageTimeoutMs" type="number" min="1" />
            </TFormField>
            <TText v-if="Object.keys(snapshot.servicePackaging).length" tone="muted" size="xs">
              {{ t('settings.packagingOverrides', { services: Object.keys(snapshot.servicePackaging).join(', ') }) }}
            </TText>
          </TStack>
        </TCard>

        <TCard variant="outline">
          <template #header>
            <TText weight="semibold">{{ t('settings.brandingCard') }}</TText>
          </template>
          <TStack direction="vertical" gap="0.75rem">
            <TFormField :label="t('settings.brandingTitle')" :hint="t('settings.brandingTitleHint')">
              <TInput v-model="form.brTitle" placeholder="Local Serverless Stack" />
            </TFormField>
            <TFormField :label="t('settings.brandingSubtitle')" :hint="t('settings.brandingSubtitleHint')">
              <TInput v-model="form.brSubtitle" placeholder="Local development control plane" />
            </TFormField>
            <TFormField :label="t('settings.defaultTheme')" :hint="t('settings.defaultThemeHint')">
              <TToggleGroup v-model="form.brTheme" :options="themeOptions" size="md" />
            </TFormField>
            <TText tone="muted" size="xs">
              {{ t('settings.brandingFileOnly') }}
            </TText>
          </TStack>
        </TCard>
      </TGrid>
    </template>
  </TStack>
</template>
