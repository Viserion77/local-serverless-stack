<script setup lang="ts">
// Guided first-run flow: confirm the stack's port layout, brand the dashboard,
// then scan the project for Serverless/osls services and register the ones the
// user picks. Every step writes through the same public API the Settings tab
// uses (PUT /api/config, POST /api/services/register) — onboarding is a guided
// path over existing surfaces, never a second code path.
//
// It replaces the retired serverless-lss plugin's job: instead of each service
// announcing itself from inside `sls package`, LSS finds them.
import { ref, reactive, computed, onMounted } from 'vue';
import { useRouter } from 'vue-router';
import {
  TCard, TStack, TText, TButton, TInput, TFormField, TGrid, TBadge, TAlert,
  TSteps, TCheckbox, TSpinner, TToggleGroup, TDivider, TTag,
} from '@treeui/vue';
import type { TStepItem } from '@treeui/vue';
import { api } from '../services/api';
import type { LssConfigSnapshot, ScannedService } from '../services/api';
import { loadBranding } from '../services/branding';
import { markOnboardingDone } from '../services/onboarding';

const router = useRouter();

const STEPS: TStepItem[] = [
  { value: 'ports', label: 'Ports', description: 'One port for everything' },
  { value: 'brand', label: 'Brand', description: 'Make the dashboard yours' },
  { value: 'services', label: 'Services', description: 'Scan and register' },
];
const step = ref<'ports' | 'brand' | 'services'>('ports');
const stepItems = computed(() =>
  STEPS.map((item, index) => ({
    ...item,
    status: item.value === step.value
      ? 'current' as const
      : index < STEPS.findIndex(s => s.value === step.value) ? 'complete' as const : 'upcoming' as const,
  })),
);

const config = ref<LssConfigSnapshot | null>(null);
const error = ref<string | null>(null);
const restartRequired = ref<string[]>([]);

// ---- step 1: ports --------------------------------------------------------
const ports = reactive({ serverPort: 14566, enginePort: 14566, saving: false });
const singleListener = computed(() => ports.serverPort === ports.enginePort);

async function savePorts(): Promise<void> {
  ports.saving = true;
  error.value = null;
  try {
    const patch: Record<string, unknown> = {};
    if (config.value && ports.serverPort !== config.value.serverPort) patch.serverPort = ports.serverPort;
    if (config.value && ports.enginePort !== config.value.selfEngine.port) {
      patch.selfEngine = { port: ports.enginePort };
    }
    if (Object.keys(patch).length > 0) {
      const res = await api.updateConfig(patch);
      config.value = res.config;
      restartRequired.value = res.restartRequired;
    }
    step.value = 'brand';
  } catch (e) {
    error.value = e instanceof Error ? e.message : 'Failed to save ports';
  } finally {
    ports.saving = false;
  }
}

// ---- step 2: branding -----------------------------------------------------
const brand = reactive({ title: '', subtitle: '', theme: 'dark', primary: '', saving: false });
const themeOptions = [
  { value: 'dark', label: 'Dark' },
  { value: 'light', label: 'Light' },
];

async function saveBrand(): Promise<void> {
  brand.saving = true;
  error.value = null;
  try {
    const branding: Record<string, unknown> = {
      title: brand.title.trim() || null,
      subtitle: brand.subtitle.trim() || null,
      defaultTheme: brand.theme,
    };
    if (brand.primary.trim()) branding.colors = { 'brand-primary': brand.primary.trim() };
    const res = await api.updateConfig({ branding } as never);
    config.value = res.config;
    // Branding is hot: re-pull it so the new identity shows immediately.
    await loadBranding();
    step.value = 'services';
    void scan();
  } catch (e) {
    error.value = e instanceof Error ? e.message : 'Failed to save branding';
  } finally {
    brand.saving = false;
  }
}

// ---- step 3: scan + register ---------------------------------------------
interface Row extends ScannedService {
  selected: boolean;
  status: 'idle' | 'registering' | 'done' | 'failed';
  resultMessage?: string;
  resultWarnings: string[];
}

const scanning = ref(false);
const registering = ref(false);
const projectRoot = ref('');
const rows = ref<Row[]>([]);

const selectable = computed(() => rows.value.filter(r => !r.registered && r.status !== 'done'));
const selectedCount = computed(() => selectable.value.filter(r => r.selected).length);
const allSelected = computed({
  get: () => selectable.value.length > 0 && selectable.value.every(r => r.selected),
  set: (value: boolean) => selectable.value.forEach(r => { r.selected = value; }),
});

async function scan(): Promise<void> {
  scanning.value = true;
  error.value = null;
  try {
    const res = await api.scanServices();
    projectRoot.value = res.projectRoot;
    rows.value = res.services.map(svc => ({
      ...svc,
      selected: !svc.registered,
      status: 'idle',
      resultWarnings: [],
    }));
  } catch (e) {
    error.value = e instanceof Error ? e.message : 'Scan failed';
  } finally {
    scanning.value = false;
  }
}

async function registerSelected(): Promise<void> {
  registering.value = true;
  error.value = null;
  // Sequential on purpose: registration provisions resources and may package;
  // parallel runs would interleave packaging output and port claims.
  for (const row of rows.value) {
    if (!row.selected || row.registered || row.status === 'done') continue;
    row.status = 'registering';
    try {
      const res = await api.registerService(row.root);
      row.status = 'done';
      row.resultMessage = `${res.resourcesCount} resource(s), ${res.functionsCount} function(s), ${res.routesCount} route(s)`;
      row.resultWarnings = res.warnings;
    } catch (e) {
      row.status = 'failed';
      row.resultMessage = e instanceof Error ? e.message : 'registration failed';
    }
  }
  registering.value = false;
}

function finish(): void {
  markOnboardingDone();
  void router.push('/');
}

function rowTone(row: Row): 'success' | 'danger' | 'info' | 'neutral' {
  if (row.status === 'done' || row.registered) return 'success';
  if (row.status === 'failed') return 'danger';
  if (row.status === 'registering') return 'info';
  return 'neutral';
}

function rowLabel(row: Row): string {
  if (row.registered) return 'registered';
  if (row.status === 'done') return 'registered';
  if (row.status === 'failed') return 'failed';
  if (row.status === 'registering') return 'registering…';
  return row.packaged ? 'packaged' : 'not packaged';
}

onMounted(async () => {
  try {
    const cfg = await api.getConfig();
    config.value = cfg;
    ports.serverPort = cfg.serverPort;
    ports.enginePort = cfg.selfEngine.port;
    brand.title = cfg.branding.title;
    brand.subtitle = cfg.branding.subtitle;
    brand.theme = cfg.branding.defaultTheme;
    brand.primary = cfg.branding.colors['brand-primary'] ?? '';
  } catch (e) {
    error.value = e instanceof Error ? e.message : 'Could not load the configuration';
  }
});
</script>

<template>
  <TStack direction="vertical" gap="1.5rem">
    <TCard variant="outline">
      <TStack direction="vertical" gap="1rem">
        <TStack direction="horizontal" gap="0.75rem" align="center" wrap>
          <TText size="xl" weight="semibold">Welcome to LSS</TText>
          <TBadge tone="info" variant="soft">guided setup</TBadge>
        </TStack>
        <TText tone="muted">
          Three steps: confirm the port layout, brand the dashboard, then scan this project for
          Serverless/osls services and register the ones you want. Everything here is editable
          later in Settings.
        </TText>
        <TSteps :items="stepItems" :model-value="step" size="sm" />
      </TStack>
    </TCard>

    <TAlert v-if="error" variant="danger">{{ error }}</TAlert>

    <!-- Step 1: ports -->
    <TCard v-if="step === 'ports'" variant="outline">
      <template #header><TText weight="semibold">Ports</TText></template>
      <TStack direction="vertical" gap="0.75rem">
        <TText tone="muted">
          By default the dashboard, the REST API and the AWS wire share one port — your services
          point <TText family="mono" size="sm">AWS_ENDPOINT</TText> at the same URL you are looking
          at now. Give the two values below different ports to split them.
        </TText>
        <TGrid :columns="2" gap="0.75rem">
          <TFormField label="Stack port (serverPort)" hint="Dashboard + REST API">
            <TInput v-model.number="ports.serverPort" type="number" min="1024" max="65535" />
          </TFormField>
          <TFormField label="Engine port (selfEngine.port)" hint="AWS wire — equal means one listener">
            <TInput v-model.number="ports.enginePort" type="number" min="1024" max="65535" />
          </TFormField>
        </TGrid>
        <TStack direction="horizontal" gap="0.5rem" align="center" wrap>
          <TBadge :tone="singleListener ? 'success' : 'info'" variant="soft">
            {{ singleListener ? 'single listener — one port for everything' : 'two listeners' }}
          </TBadge>
          <TTag v-if="restartRequired.length" size="sm" variant="soft">
            restart required: lss stop && lss start
          </TTag>
        </TStack>
        <TStack direction="horizontal" gap="0.5rem" justify="flex-end">
          <TButton variant="solid" :loading="ports.saving" @click="savePorts">Continue</TButton>
        </TStack>
      </TStack>
    </TCard>

    <!-- Step 2: branding -->
    <TCard v-if="step === 'brand'" variant="outline">
      <template #header><TText weight="semibold">Brand</TText></template>
      <TStack direction="vertical" gap="0.75rem">
        <TText tone="muted">
          Title, subtitle and colors show on every screen — teams usually put the product or squad
          name here. Applied live, no restart.
        </TText>
        <TGrid :columns="2" gap="0.75rem">
          <TFormField label="Title" hint="Blank keeps the default">
            <TInput v-model="brand.title" placeholder="Local Serverless Stack" />
          </TFormField>
          <TFormField label="Subtitle">
            <TInput v-model="brand.subtitle" placeholder="Local development control plane" />
          </TFormField>
          <TFormField label="Default theme">
            <TToggleGroup v-model="brand.theme" :options="themeOptions" size="md" />
          </TFormField>
          <TFormField label="Brand color" hint="Any CSS color — blank keeps the default">
            <TInput v-model="brand.primary" placeholder="#0d9488" />
          </TFormField>
        </TGrid>
        <TStack direction="horizontal" gap="0.5rem" justify="space-between">
          <TButton variant="ghost" @click="step = 'ports'">Back</TButton>
          <TButton variant="solid" :loading="brand.saving" @click="saveBrand">Continue</TButton>
        </TStack>
      </TStack>
    </TCard>

    <!-- Step 3: scan + register -->
    <TCard v-if="step === 'services'" variant="outline">
      <template #header>
        <TStack direction="horizontal" gap="0.5rem" align="center" justify="space-between" wrap>
          <TText weight="semibold">Services</TText>
          <TButton size="sm" variant="ghost" :loading="scanning" @click="scan">Rescan</TButton>
        </TStack>
      </template>
      <TStack direction="vertical" gap="0.75rem">
        <TText tone="muted">
          Every Serverless/osls service found under
          <TText family="mono" size="sm">{{ projectRoot || '…' }}</TText>. Pick the ones to bring
          into LSS — registration packages on demand, provisions the declared AWS resources and
          wires the event sources.
        </TText>

        <TStack v-if="scanning" direction="horizontal" justify="center">
          <TSpinner label="Scanning project…" />
        </TStack>

        <TAlert v-else-if="rows.length === 0" variant="info">
          No Serverless/osls services found. Create one with a serverless.yml and hit Rescan — or
          register a path directly with <TText family="mono" size="sm">npx lss register &lt;dir&gt;</TText>.
        </TAlert>

        <template v-else>
          <TStack direction="horizontal" gap="0.5rem" align="center" wrap>
            <TCheckbox v-model="allSelected">select all</TCheckbox>
            <TText tone="muted" size="sm">{{ selectedCount }} selected</TText>
          </TStack>
          <TDivider />
          <TStack direction="vertical" gap="0.75rem">
            <TStack
              v-for="row in rows"
              :key="row.root"
              direction="horizontal"
              gap="0.75rem"
              align="center"
              wrap
            >
              <TCheckbox
                v-model="row.selected"
                :disabled="row.registered || row.status === 'done' || row.status === 'registering'"
              />
              <TStack direction="vertical" gap="0.125rem">
                <TStack direction="horizontal" gap="0.5rem" align="center" wrap>
                  <TText weight="semibold">{{ row.name }}</TText>
                  <TBadge :tone="rowTone(row)" variant="soft">{{ rowLabel(row) }}</TBadge>
                  <TTag v-if="row.apiPort" size="sm" variant="soft">api {{ row.apiPort }}</TTag>
                  <TTag v-if="row.invokePort" size="sm" variant="soft">invoke {{ row.invokePort }}</TTag>
                  <TTag v-if="row.region" size="sm" variant="soft">{{ row.region }}</TTag>
                </TStack>
                <TText tone="muted" size="sm" family="mono">{{ row.relPath }}/{{ row.configFile }}</TText>
                <TText v-if="row.resultMessage && row.status !== 'failed'" size="sm" tone="muted">
                  {{ row.resultMessage }}
                </TText>
                <TBadge v-if="row.resultMessage && row.status === 'failed'" tone="danger" variant="soft">
                  {{ row.resultMessage }}
                </TBadge>
                <TText v-for="warning in [...row.warnings, ...row.resultWarnings]" :key="warning" size="sm" tone="muted">
                  ⚠ {{ warning }}
                </TText>
              </TStack>
            </TStack>
          </TStack>
        </template>

        <TStack direction="horizontal" gap="0.5rem" justify="space-between" wrap>
          <TButton variant="ghost" @click="step = 'brand'">Back</TButton>
          <TStack direction="horizontal" gap="0.5rem">
            <TButton
              variant="solid"
              :disabled="selectedCount === 0 || registering"
              :loading="registering"
              @click="registerSelected"
            >
              Register {{ selectedCount }} service(s)
            </TButton>
            <TButton variant="outline" @click="finish">Finish</TButton>
          </TStack>
        </TStack>
      </TStack>
    </TCard>
  </TStack>
</template>
