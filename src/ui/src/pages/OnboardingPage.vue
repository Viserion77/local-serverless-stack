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

// ---- step 3: scan + prepare + register ------------------------------------
interface Row extends ScannedService {
  selected: boolean;
  status: 'idle' | 'installing' | 'packaging' | 'registering' | 'done' | 'failed';
  // Editable copies of the effective values; persisted to lss.config.json
  // (serviceRuntime / servicePackaging) before package/register runs.
  editApiPort: string;
  editInvokePort: string;
  editPackageCommand: string;
  resultMessage?: string;
  resultOutput?: string;
  resultWarnings: string[];
}

// The global package command, so a cleared per-service field can tell "back
// to the default" apart from "no change".
const globalPackageCommand = computed(() => config.value?.packageCommand ?? '');

const scanning = ref(false);
// Which bulk action is running — install/package/register share the lock so
// two sequential loops can never interleave.
const working = ref<null | 'install' | 'package' | 'register'>(null);
const projectRoot = ref('');
const rows = ref<Row[]>([]);

// Everything is selectable, registered included: re-registering is how you
// apply an edited port, a re-package or a changed serverless.yml, and it is
// the same call the CLI's `lss register` makes on an already-known service.
const selectedCount = computed(() => rows.value.filter(r => r.selected).length);
const allSelected = computed({
  get: () => rows.value.length > 0 && rows.value.every(r => r.selected),
  set: (value: boolean) => rows.value.forEach(r => { r.selected = value; }),
});
const selectedRows = () => rows.value.filter(r => r.selected);

async function scan(): Promise<void> {
  scanning.value = true;
  error.value = null;
  try {
    const res = await api.scanServices();
    projectRoot.value = res.projectRoot;
    rows.value = res.services.map(svc => ({
      ...svc,
      // Pre-tick what still needs registering; an already-registered service
      // is opt-in, so a Register click never silently re-runs the whole set.
      selected: !svc.registered,
      status: 'idle',
      editApiPort: svc.apiPort ? String(svc.apiPort) : '',
      editInvokePort: svc.invokePort ? String(svc.invokePort) : '',
      editPackageCommand: svc.packageCommand,
      resultWarnings: [],
    }));
  } catch (e) {
    error.value = e instanceof Error ? e.message : 'Scan failed';
  } finally {
    scanning.value = false;
  }
}

// The install/package step-warnings clear as the flags flip; everything else
// (TS config, unreadable file) stays verbatim.
function displayWarnings(row: Row): string[] {
  return row.warnings.filter(w =>
    !(row.installed && w.startsWith('dependencies not installed'))
    && !(row.packaged && w.startsWith('not packaged yet')));
}

// The key a serviceRuntime/servicePackaging entry is written under. relPath is
// project-root relative and the server resolves that spelling (as well as the
// config-relative one and the basename), so it addresses the service wherever
// the config file lives. The root itself ('.') has no relative spelling — its
// basename is the addressable key.
function configKey(row: Row): string {
  return row.relPath === '.' ? (row.root.split('/').pop() ?? row.name) : row.relPath;
}

function parsePort(value: string): number | null | 'invalid' {
  const trimmed = value.trim();
  if (!trimmed) return null; // cleared — delete the override
  const port = Number.parseInt(trimmed, 10);
  return Number.isInteger(port) && String(port) === trimmed && port >= 1024 && port <= 65535 ? port : 'invalid';
}

// Persist edited ports/commands into lss.config.json so registration (now and
// on every future boot) sees them. Called before package/register and on
// Finish; a no-edit run writes nothing. Returns false when an edit is invalid.
async function persistOverrides(): Promise<boolean> {
  const serviceRuntime: Record<string, { apiPort?: number | null; invokePort?: number | null }> = {};
  const servicePackaging: Record<string, { packageCommand?: string | null }> = {};
  for (const row of rows.value) {
    const apiPort = parsePort(row.editApiPort);
    const invokePort = parsePort(row.editInvokePort);
    if (apiPort === 'invalid' || invokePort === 'invalid') {
      error.value = `${row.name}: ports must be integers between 1024 and 65535`;
      return false;
    }
    const entry: { apiPort?: number | null; invokePort?: number | null } = {};
    if (apiPort !== (row.apiPort ?? null)) entry.apiPort = apiPort;
    if (invokePort !== (row.invokePort ?? null)) entry.invokePort = invokePort;
    if (Object.keys(entry).length > 0) serviceRuntime[configKey(row)] = entry;
    const command = row.editPackageCommand.trim();
    if (command && command !== row.packageCommand) {
      servicePackaging[configKey(row)] = { packageCommand: command };
    } else if (!command && row.packageCommand !== globalPackageCommand.value) {
      // Cleared, and what the field showed was a per-service override rather
      // than the global command: null deletes that entry subkey, so the
      // service falls back to the global one as the hint promises.
      servicePackaging[configKey(row)] = { packageCommand: null };
    }
  }
  const patch: Record<string, unknown> = {};
  if (Object.keys(serviceRuntime).length > 0) patch.serviceRuntime = serviceRuntime;
  if (Object.keys(servicePackaging).length > 0) patch.servicePackaging = servicePackaging;
  if (Object.keys(patch).length === 0) return true;
  try {
    await api.updateConfig(patch as never);
    // Re-read rather than guess: clearing an override falls back to the
    // service's own yml hint (or the global command), which only the server
    // can resolve. Guessing here is how a row ends up claiming "no API port"
    // for a service that is in fact listening.
    await refreshEffective();
    return true;
  } catch (e) {
    error.value = e instanceof Error ? e.message : 'Failed to save service settings';
    return false;
  }
}

// Pull fresh effective values (ports, package command, installed/packaged
// flags) over the existing rows, preserving selection and in-flight results —
// a full scan() would reset both mid-flow.
async function refreshEffective(): Promise<void> {
  const res = await api.scanServices();
  const byRoot = new Map(res.services.map(svc => [svc.root, svc]));
  for (const row of rows.value) {
    const fresh = byRoot.get(row.root);
    if (!fresh) continue;
    Object.assign(row, {
      installed: fresh.installed,
      packaged: fresh.packaged,
      registered: fresh.registered,
      region: fresh.region,
      apiPort: fresh.apiPort,
      invokePort: fresh.invokePort,
      packageCommand: fresh.packageCommand,
      warnings: fresh.warnings,
      // The fields now show what is actually effective, including any
      // fallback that replaced a cleared override.
      editApiPort: fresh.apiPort ? String(fresh.apiPort) : '',
      editInvokePort: fresh.invokePort ? String(fresh.invokePort) : '',
      editPackageCommand: fresh.packageCommand,
    });
  }
}

// One sequential runner for the three bulk actions: parallel runs would
// interleave npm/serverless output and port claims.
async function runSelected(
  action: 'install' | 'package' | 'register',
  busyStatus: Row['status'],
  run: (row: Row) => Promise<void>,
): Promise<void> {
  working.value = action;
  error.value = null;
  if (action !== 'install' && !(await persistOverrides())) {
    working.value = null;
    return;
  }
  for (const row of selectedRows()) {
    row.status = busyStatus;
    row.resultMessage = undefined;
    row.resultOutput = undefined;
    try {
      await run(row);
    } catch (e) {
      row.status = 'failed';
      row.resultMessage = e instanceof Error ? e.message : `${action} failed`;
      row.resultOutput = extractOutput(e);
    }
  }
  working.value = null;
}

// The prepare endpoints answer 422 with { error, output } — surface the tail,
// it is where npm/serverless says what actually went wrong.
function extractOutput(e: unknown): string | undefined {
  const output = (e as { body?: { output?: string } })?.body?.output;
  return typeof output === 'string' && output ? output.slice(-600) : undefined;
}

const installSelected = () => runSelected('install', 'installing', async (row) => {
  const res = await api.installService(row.root);
  row.installed = true;
  row.status = 'idle';
  row.resultMessage = `dependencies installed in ${(res.durationMs / 1000).toFixed(1)}s`;
});

const packageSelected = () => runSelected('package', 'packaging', async (row) => {
  const res = await api.packageService(row.root);
  row.packaged = true;
  row.status = 'idle';
  row.resultMessage = `packaged in ${(res.durationMs / 1000).toFixed(1)}s`;
});

const registerSelected = () => runSelected('register', 'registering', async (row) => {
  const res = await api.registerService(row.root);
  row.status = 'done';
  row.resultMessage = `${res.resourcesCount} resource(s), ${res.functionsCount} function(s), ${res.routesCount} route(s)`;
  row.resultWarnings = res.warnings;
});

async function finish(): Promise<void> {
  // Edits made without running package/register still land in the config —
  // and a failure keeps the user here with the error visible rather than
  // navigating away from work that was not saved.
  if (!await persistOverrides()) return;
  markOnboardingDone();
  void router.push('/');
}

// Registering a service that is already registered re-runs provisioning with
// the current template and settings, so the button says so.
const registerLabel = computed(() => {
  const selected = rows.value.filter(r => r.selected);
  const fresh = selected.filter(r => !r.registered).length;
  if (selected.length === 0) return 'Register';
  if (fresh === 0) return `Re-register ${selected.length} service(s)`;
  return `Register ${selected.length} service(s)`;
});

function rowTone(row: Row): 'success' | 'danger' | 'info' | 'neutral' {
  if (row.status === 'done' || row.registered) return 'success';
  if (row.status === 'failed') return 'danger';
  if (row.status === 'installing' || row.status === 'packaging' || row.status === 'registering') return 'info';
  return 'neutral';
}

function rowLabel(row: Row): string {
  if (row.registered || row.status === 'done') return 'registered';
  if (row.status === 'failed') return 'failed';
  if (row.status === 'installing') return 'installing…';
  if (row.status === 'packaging') return 'packaging…';
  if (row.status === 'registering') return 'registering…';
  if (!row.installed) return 'not installed';
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
          Already-registered services stay editable: change a port or the package command and
          register again to apply it.
        </TText>
        <TText tone="muted">
          Every Serverless/osls service found under
          <TText family="mono" size="sm">{{ projectRoot || '…' }}</TText>. Pick the ones to bring
          into LSS — install dependencies and package right here if needed, then register:
          registration provisions the declared AWS resources and wires the event sources.
          Edited ports and package commands are saved to
          <TText family="mono" size="sm">lss.config.json</TText>
          (<TText family="mono" size="sm">serviceRuntime</TText> / <TText family="mono" size="sm">servicePackaging</TText>).
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
              <TCheckbox v-model="row.selected" :disabled="working !== null" />
              <TStack direction="vertical" gap="0.375rem">
                <TStack direction="horizontal" gap="0.5rem" align="center" wrap>
                  <TText weight="semibold">{{ row.name }}</TText>
                  <TBadge :tone="rowTone(row)" variant="soft">{{ rowLabel(row) }}</TBadge>
                  <TTag v-if="row.region" size="sm" variant="soft">{{ row.region }}</TTag>
                </TStack>
                <TText tone="muted" size="sm" family="mono">{{ row.relPath }}/{{ row.configFile }}</TText>
                <TGrid :columns="3" gap="0.5rem">
                  <TFormField label="API port" hint="blank = the service's own custom.lss port">
                    <TInput v-model="row.editApiPort" type="number" min="1024" max="65535" placeholder="3000" />
                  </TFormField>
                  <TFormField label="Invoke port" hint="blank = api port + 10000">
                    <TInput v-model="row.editInvokePort" type="number" min="1024" max="65535" placeholder="13000" />
                  </TFormField>
                  <TFormField label="Package command" hint="blank restores the global one">
                    <TInput v-model="row.editPackageCommand" placeholder="npx serverless package" />
                  </TFormField>
                </TGrid>
                <TText v-if="row.resultMessage && row.status !== 'failed'" size="sm" tone="muted">
                  {{ row.resultMessage }}
                </TText>
                <TBadge v-if="row.resultMessage && row.status === 'failed'" tone="danger" variant="soft">
                  {{ row.resultMessage }}
                </TBadge>
                <TText v-if="row.resultOutput" size="sm" tone="muted" family="mono">
                  {{ row.resultOutput }}
                </TText>
                <TText v-for="warning in [...displayWarnings(row), ...row.resultWarnings]" :key="warning" size="sm" tone="muted">
                  ⚠ {{ warning }}
                </TText>
              </TStack>
            </TStack>
          </TStack>
        </template>

        <TStack direction="horizontal" gap="0.5rem" justify="space-between" wrap>
          <TButton variant="ghost" :disabled="working !== null" @click="step = 'brand'">Back</TButton>
          <TStack direction="horizontal" gap="0.5rem" wrap>
            <TButton
              variant="outline"
              :disabled="selectedCount === 0 || working !== null"
              :loading="working === 'install'"
              @click="installSelected"
            >
              Install selected
            </TButton>
            <TButton
              variant="outline"
              :disabled="selectedCount === 0 || working !== null"
              :loading="working === 'package'"
              @click="packageSelected"
            >
              Package selected
            </TButton>
            <TButton
              variant="solid"
              :disabled="selectedCount === 0 || working !== null"
              :loading="working === 'register'"
              @click="registerSelected"
            >
              {{ registerLabel }}
            </TButton>
            <TButton variant="outline" :disabled="working !== null" @click="finish">Finish</TButton>
          </TStack>
        </TStack>
      </TStack>
    </TCard>
  </TStack>
</template>
