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

const toast = useToast();
const snapshot = ref<LssConfigSnapshot | null>(null);
const loading = ref(true);
const saving = ref(false);
const reloading = ref(false);
const error = ref<string | null>(null);
const restartKeys = ref<string[]>([]);
const envMasked = ref<string[]>([]);

const engineOptions = [
  { value: 'localstack', label: 'LocalStack' },
  { value: 'self', label: 'Self engine' },
];
const modeOptions = [
  { value: 'managed', label: 'Managed' },
  { value: 'external', label: 'External' },
];
const editionOptions = [
  { value: 'community', label: 'Community' },
  { value: 'pro', label: 'Pro' },
];
const executionOptions = [
  { value: 'auto', label: 'Auto' },
  { value: 'artifact', label: 'Artifact' },
  { value: 'source', label: 'Source' },
];
const watchOptions = [
  { value: 'default', label: 'Mode default (source → on, artifact → off)' },
  { value: 'on', label: 'On' },
  { value: 'off', label: 'Off' },
];
const themeOptions = [
  { value: 'dark', label: 'Dark' },
  { value: 'light', label: 'Light' },
];

// Flat form model — every field scalar so dirty tracking is a plain compare.
const form = reactive({
  serverPort: 3100,
  region: 'us-east-1',
  persistence: true,
  debug: false,
  engine: 'localstack',
  mode: 'managed',
  edition: 'community',
  version: '',
  image: '',
  endpoint: '',
  localstackPort: 4566,
  aossEnabled: true,
  aossPort: 14567,
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
  servicesCsv: '',
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
  form.engine = s.engine.kind;
  form.mode = s.localstack.mode;
  form.edition = s.localstack.edition;
  form.version = s.localstack.version;
  form.image = s.localstack.image;
  form.endpoint = s.localstack.endpoint;
  form.localstackPort = s.localstack.port;
  form.aossEnabled = s.aossSidecar.enabled;
  form.aossPort = s.aossSidecar.port;
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
  form.servicesCsv = s.services.join(', ');
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
  return isEnvMasked(configKey)
    ? 'Masked by an environment variable — the saved file value will not take effect until it is unset'
    : normal;
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
      errors.push(`${label} must be an integer port between 1 and 65535`);
    }
    return n;
  };
  const asPositive = (value: unknown, label: string): number => {
    const n = Number(value);
    if (!Number.isInteger(n) || n <= 0) {
      errors.push(`${label} must be a positive integer`);
    }
    return n;
  };
  const orNull = (value: string): string | null => value.trim() || null;

  if (dirty.has('serverPort')) patch.serverPort = asPort(form.serverPort, 'Server port');
  if (dirty.has('region')) patch.region = form.region;
  if (dirty.has('persistence')) patch.persistence = form.persistence;
  if (dirty.has('debug')) patch.debug = form.debug;
  if (dirty.has('engine')) patch.engine = form.engine as 'localstack' | 'self';
  if (dirty.has('mode')) patch.mode = form.mode as 'managed' | 'external';
  if (dirty.has('edition')) patch.localstackEdition = form.edition as 'community' | 'pro';
  if (dirty.has('version')) patch.localstackVersion = orNull(form.version);
  if (dirty.has('image')) patch.localstackImage = orNull(form.image);
  if (dirty.has('endpoint')) patch.localstackEndpoint = orNull(form.endpoint);
  if (dirty.has('localstackPort')) patch.localstackPort = asPort(form.localstackPort, 'LocalStack port');
  if (dirty.has('proxyEnabled')) patch.enableDynamoProxy = form.proxyEnabled;
  if (dirty.has('proxyPort')) patch.dynamoProxyPort = asPort(form.proxyPort, 'Dynamo proxy port');
  if (dirty.has('autoPackage')) patch.autoPackage = form.autoPackage;
  if (dirty.has('packageCommand')) patch.packageCommand = orNull(form.packageCommand);
  if (dirty.has('packageTimeoutMs')) patch.packageTimeoutMs = asPositive(form.packageTimeoutMs, 'Package timeout');
  if (dirty.has('seedsDir')) patch.seedsDir = orNull(form.seedsDir);
  if (dirty.has('servicesCsv')) {
    const list = form.servicesCsv.split(',').map(s => s.trim()).filter(Boolean);
    patch.services = list.length ? list : null;
  }

  if (dirty.has('aossEnabled') || dirty.has('aossPort')) {
    patch.aossSidecar = {
      ...(dirty.has('aossEnabled') ? { enabled: form.aossEnabled } : {}),
      ...(dirty.has('aossPort') ? { port: asPort(form.aossPort, 'aoss sidecar port') } : {}),
    };
  }

  const selfEngine: NonNullable<LssConfigUpdate['selfEngine']> = {};
  if (dirty.has('sePort')) selfEngine.port = asPort(form.sePort, 'Self engine port');
  if (dirty.has('seAccount')) {
    if (!form.seAccount.trim()) errors.push('Self engine account cannot be empty');
    selfEngine.account = form.seAccount.trim();
  }
  if (dirty.has('seMemoryBudgetMb')) selfEngine.memoryBudgetMb = asPositive(form.seMemoryBudgetMb, 'Memory budget');
  if (dirty.has('seIdleUnloadMs')) selfEngine.idleUnloadMs = asPositive(form.seIdleUnloadMs, 'Idle unload');
  if (dirty.has('seFsync')) selfEngine.fsync = form.seFsync;
  if (dirty.has('seFallback')) selfEngine.fallbackEndpoint = orNull(form.seFallback);
  if (Object.keys(selfEngine).length) patch.selfEngine = selfEngine;

  const lambdaRuntime: NonNullable<LssConfigUpdate['lambdaRuntime']> = {};
  if (dirty.has('lrEnabled')) lambdaRuntime.enabled = form.lrEnabled;
  if (dirty.has('lrExecution')) lambdaRuntime.execution = form.lrExecution as 'auto' | 'artifact' | 'source';
  if (dirty.has('lrWatch')) lambdaRuntime.watch = form.lrWatch === 'default' ? null : form.lrWatch === 'on';
  if (dirty.has('lrInvokePortOffset')) lambdaRuntime.invokePortOffset = asPositive(form.lrInvokePortOffset, 'Invoke port offset');
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
    error.value = err instanceof Error ? err.message : 'Failed to load configuration';
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
      title: 'Configuration saved',
      description: `Written to ${res.configPath} — review and commit the diff`,
      variant: 'success',
    });
  } catch (err) {
    error.value = err instanceof Error ? err.message : 'Failed to save configuration';
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
      title: 'Configuration reloaded from disk',
      description: res.configPath || 'No config file found — defaults applied',
      variant: 'success',
    });
  } catch (err) {
    error.value = err instanceof Error ? err.message : 'Failed to reload configuration';
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
              <TText size="xl" weight="semibold">Settings</TText>
              <TText tone="muted" size="sm">
                Saved straight into the config file — review and commit the diff yourself.
              </TText>
            </TStack>
          </TStack>
          <TStack direction="horizontal" gap="0.5rem" align="center" wrap>
            <TBadge v-if="dirtyCount" tone="warning" variant="soft">
              {{ dirtyCount }} unsaved change{{ dirtyCount > 1 ? 's' : '' }}
            </TBadge>
            <TButton size="sm" variant="outline" :loading="reloading" @click="reloadFromDisk">
              <template #icon><TIcon name="refresh-cw" /></template>
              Reload from disk
            </TButton>
            <TButton size="sm" variant="ghost" :disabled="!dirtyCount || saving" @click="discard">
              Discard
            </TButton>
            <TButton size="sm" variant="solid" :loading="saving" :disabled="!dirtyCount" @click="save">
              Save changes
            </TButton>
          </TStack>
        </TStack>
        <TText tone="muted" size="xs" family="mono">
          {{ snapshot?.configPath || `No config file loaded — saving creates lss.config.json in ${snapshot?.projectRoot || 'the project root'}` }}
        </TText>
      </TStack>
    </TCard>

    <TAlert v-if="error" variant="danger" dismissible @dismiss="error = null">
      {{ error }}
    </TAlert>

    <TAlert v-if="restartKeys.length" variant="warning" dismissible @dismiss="restartKeys = []">
      Restart required to apply: {{ restartKeys.join(', ') }} — these values are locked in at boot.
      Run <TText family="mono">lss stop &amp;&amp; lss start</TText> (or the "restart (rebuild local)" VSCode task).
    </TAlert>

    <TAlert v-if="envMasked.length" variant="info" dismissible @dismiss="envMasked = []">
      Saved to the file, but masked by environment variables right now: {{ envMasked.join(', ') }}.
      The env value keeps winning until it is unset.
    </TAlert>

    <TStack v-if="loading" direction="horizontal" justify="center" align="center">
      <TSpinner label="Loading configuration..." />
    </TStack>

    <template v-else-if="snapshot">
      <TGrid :columns="2" gap="1rem">
        <TCard variant="outline">
          <template #header>
            <TText weight="semibold">Server</TText>
          </template>
          <TStack direction="vertical" gap="0.75rem">
            <TFormField label="Server port" :hint="envHint('serverPort', 'Dashboard + REST API (default 3100)')">
              <TInput v-model.number="form.serverPort" type="number" min="1" max="65535" />
            </TFormField>
            <TFormField label="Default region" :hint="envHint('region', 'Used by provisioning, seeds and the explorers')">
              <TSelect v-model="form.region" :options="regionOptions" />
            </TFormField>
            <TFormField label="Persistence" :hint="envHint('persistence', 'Keep engine data between restarts')">
              <TSwitch v-model="form.persistence" />
            </TFormField>
            <TFormField label="Debug" :hint="envHint('debug', 'Verbose engine logging')">
              <TSwitch v-model="form.debug" />
            </TFormField>
            <TFormField label="Seeds directory" :hint="envHint('seedsDir', 'DynamoDB seed files — blank restores ./seeds')">
              <TInput v-model="form.seedsDir" placeholder="./seeds" />
            </TFormField>
          </TStack>
        </TCard>

        <TCard variant="outline">
          <template #header>
            <TStack direction="horizontal" justify="space-between" align="center">
              <TText weight="semibold">Engine</TText>
              <TBadge tone="info" variant="soft">{{ snapshot.engine.kind }}</TBadge>
            </TStack>
          </template>
          <TStack direction="vertical" gap="0.75rem">
            <TFormField label="Engine" :hint="envHint('engine', 'Self engine needs no Docker; LocalStack needs it')">
              <TToggleGroup v-model="form.engine" :options="engineOptions" size="md" />
            </TFormField>
            <template v-if="form.engine === 'self'">
              <TGrid :columns="2" gap="0.75rem">
                <TFormField label="Port" :hint="envHint('selfEngine', 'Default 14566')">
                  <TInput v-model.number="form.sePort" type="number" min="1" max="65535" />
                </TFormField>
                <TFormField label="Account id" hint="Used in every ARN">
                  <TInput v-model="form.seAccount" placeholder="000000000000" />
                </TFormField>
                <TFormField label="Memory budget (MB)" hint="LRU cap for hydrated data">
                  <TInput v-model.number="form.seMemoryBudgetMb" type="number" min="1" />
                </TFormField>
                <TFormField label="Idle unload (ms)" hint="Dehydrate idle stores after">
                  <TInput v-model.number="form.seIdleUnloadMs" type="number" min="1" />
                </TFormField>
              </TGrid>
              <TFormField label="fsync every WAL flush" hint="Paranoid durability — slower writes">
                <TSwitch v-model="form.seFsync" />
              </TFormField>
              <TFormField label="Fallback endpoint" hint="Proxy unimplemented AWS calls here — blank disables">
                <TInput v-model="form.seFallback" placeholder="http://localhost:4566" />
              </TFormField>
              <TText tone="muted" size="xs" family="mono">Data dir: {{ snapshot.selfEngine.dataDir }}</TText>
            </template>
            <template v-else>
              <TFormField label="Mode" :hint="envHint('mode', 'Managed: LSS runs the container; external: you do')">
                <TToggleGroup v-model="form.mode" :options="modeOptions" size="md" />
              </TFormField>
              <TGrid :columns="2" gap="0.75rem">
                <TFormField label="Edition" :hint="envHint('localstackEdition', 'Pro requires an auth token')">
                  <TToggleGroup v-model="form.edition" :options="editionOptions" size="md" />
                </TFormField>
                <TFormField label="Version" :hint="envHint('localstackVersion', 'Image tag — blank restores latest')">
                  <TInput v-model="form.version" placeholder="latest" />
                </TFormField>
                <TFormField label="Edge port" :hint="envHint('localstackPort', 'Default 4566')">
                  <TInput v-model.number="form.localstackPort" type="number" min="1" max="65535" />
                </TFormField>
                <TFormField label="Endpoint override" :hint="envHint('localstackEndpoint', 'Blank derives from the port')">
                  <TInput v-model="form.endpoint" placeholder="http://localhost:4566" />
                </TFormField>
              </TGrid>
              <TFormField label="Image override" :hint="envHint('localstackImage', 'Wins over edition + version — blank derives')">
                <TInput v-model="form.image" placeholder="localstack/localstack:latest" />
              </TFormField>
              <TFormField label="LocalStack services" :hint="envHint('services', 'Comma-separated SERVICES env — blank restores the default list')">
                <TInput v-model="form.servicesCsv" placeholder="dynamodb, sqs, sns, s3, lambda, events" />
              </TFormField>
              <TStack direction="horizontal" gap="0.5rem" align="center">
                <TBadge :tone="snapshot.localstack.hasAuthToken ? 'success' : 'neutral'" variant="soft">
                  Auth token {{ snapshot.localstack.hasAuthToken ? 'set' : 'not set' }}
                </TBadge>
                <TText tone="muted" size="xs">
                  Set via the LOCALSTACK_AUTH_TOKEN env var — never editable here.
                </TText>
              </TStack>
            </template>
          </TStack>
        </TCard>

        <TCard variant="outline">
          <template #header>
            <TText weight="semibold">Lambda runtime</TText>
          </template>
          <TStack direction="vertical" gap="0.75rem">
            <TFormField label="Enabled" :hint="envHint('lambdaRuntime', 'Runtime + gateway/invoke listeners (serverless-offline replacement)')">
              <TSwitch v-model="form.lrEnabled" />
            </TFormField>
            <TFormField label="Execution" hint="How handler code is loaded">
              <TToggleGroup v-model="form.lrExecution" :options="executionOptions" size="md" />
            </TFormField>
            <TFormField label="Watch &amp; hot reload" hint="Restart workers on source changes">
              <TSelect v-model="form.lrWatch" :options="watchOptions" />
            </TFormField>
            <TGrid :columns="2" gap="0.75rem">
              <TFormField label="Invoke port offset" hint="apiPort + offset = invoke port">
                <TInput v-model.number="form.lrInvokePortOffset" type="number" min="1" />
              </TFormField>
              <TFormField label="Invoke host" hint="Blank restores the engine default">
                <TInput v-model="form.lrInvokeHost" placeholder="host.docker.internal" />
              </TFormField>
            </TGrid>
          </TStack>
        </TCard>

        <TCard variant="outline">
          <template #header>
            <TText weight="semibold">Sidecars &amp; proxy</TText>
          </template>
          <TStack direction="vertical" gap="0.75rem">
            <TFormField label="OpenSearch Serverless sidecar" hint="aoss served in-process on LocalStack engines">
              <TSwitch v-model="form.aossEnabled" />
            </TFormField>
            <TFormField label="Sidecar port" hint="Default 14567">
              <TInput v-model.number="form.aossPort" type="number" min="1" max="65535" :disabled="!form.aossEnabled" />
            </TFormField>
            <TFormField label="DynamoDB proxy" :hint="envHint('enableDynamoProxy', 'For tools that expect DynamoDB on a fixed port')">
              <TSwitch v-model="form.proxyEnabled" />
            </TFormField>
            <TFormField label="Proxy port" :hint="envHint('dynamoProxyPort', 'Default 8000')">
              <TInput v-model.number="form.proxyPort" type="number" min="1" max="65535" :disabled="!form.proxyEnabled" />
            </TFormField>
          </TStack>
        </TCard>

        <TCard variant="outline">
          <template #header>
            <TText weight="semibold">Packaging</TText>
          </template>
          <TStack direction="vertical" gap="0.75rem">
            <TFormField label="Auto-package" :hint="envHint('autoPackage', 'Run the package command when a template is missing at /register')">
              <TSwitch v-model="form.autoPackage" />
            </TFormField>
            <TFormField label="Package command" :hint="envHint('packageCommand', 'Blank restores npx serverless package')">
              <TInput v-model="form.packageCommand" placeholder="npx serverless package" />
            </TFormField>
            <TFormField label="Package timeout (ms)" :hint="envHint('packageTimeoutMs', 'Default 300000 (5 min)')">
              <TInput v-model.number="form.packageTimeoutMs" type="number" min="1" />
            </TFormField>
            <TText v-if="Object.keys(snapshot.servicePackaging).length" tone="muted" size="xs">
              Per-service overrides ({{ Object.keys(snapshot.servicePackaging).join(', ') }}) are file-only — edit servicePackaging in the config.
            </TText>
          </TStack>
        </TCard>

        <TCard variant="outline">
          <template #header>
            <TText weight="semibold">Branding</TText>
          </template>
          <TStack direction="vertical" gap="0.75rem">
            <TFormField label="Title" hint="Navbar + browser tab — blank restores the default">
              <TInput v-model="form.brTitle" placeholder="Local Serverless Stack" />
            </TFormField>
            <TFormField label="Subtitle" hint="Line under the title — blank restores the default">
              <TInput v-model="form.brSubtitle" placeholder="Local development control plane" />
            </TFormField>
            <TFormField label="Default theme" hint="Until the user picks one in the UI">
              <TToggleGroup v-model="form.brTheme" :options="themeOptions" size="md" />
            </TFormField>
            <TText tone="muted" size="xs">
              Logo, favicon and color tokens are file-only — edit the branding block in the config.
            </TText>
          </TStack>
        </TCard>
      </TGrid>
    </template>
  </TStack>
</template>
