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
  TCard, TStack, TText, TButton, TInput, TFormField, TGrid, TBadge, TAlert, TIcon,
  TSteps, TCheckbox, TSpinner, TToggleGroup, TDivider, TTag,
} from '@treeui/vue';
import type { TStepItem } from '@treeui/vue';
import { api } from '../services/api';
import type { LssConfigSnapshot, LssConfigUpdate, ScannedService } from '../services/api';
import { loadBranding } from '../services/branding';
import { markOnboardingDone } from '../services/onboarding';
import { useI18n } from '../i18n';

const router = useRouter();
const { t } = useI18n();

// Only the keys live at module scope — the copy is resolved inside the computed
// below so switching language re-renders the stepper instead of freezing the
// labels captured at setup time.
const STEPS = [
  { value: 'ports', labelKey: 'onboarding.stepPorts', descriptionKey: 'onboarding.stepPortsDescription' },
  { value: 'brand', labelKey: 'onboarding.stepBrand', descriptionKey: 'onboarding.stepBrandDescription' },
  { value: 'services', labelKey: 'onboarding.stepServices', descriptionKey: 'onboarding.stepServicesDescription' },
] as const;
const step = ref<'ports' | 'brand' | 'services'>('ports');
const stepItems = computed<TStepItem[]>(() =>
  STEPS.map((item, index) => ({
    value: item.value,
    label: t(item.labelKey),
    description: t(item.descriptionKey),
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
    // `Record<string, unknown>` satisfies an all-optional interface with no
    // complaint from TS, so it was not "loose typing" here — it was no typing
    // at all on the way into updateConfig. All three patches in this file are
    // built as LssConfigUpdate now.
    const patch: LssConfigUpdate = {};
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
    error.value = e instanceof Error ? e.message : t('onboarding.portsSaveFailed');
  } finally {
    ports.saving = false;
  }
}

// ---- step 2: branding -----------------------------------------------------
const brand = reactive({ title: '', subtitle: '', theme: 'dark', primary: '', saving: false });
// Computed, not a const: the toggle relabels itself on a language switch.
const themeOptions = computed(() => [
  { value: 'dark', label: t('onboarding.themeDark') },
  { value: 'light', label: t('onboarding.themeLight') },
]);

async function saveBrand(): Promise<void> {
  brand.saving = true;
  error.value = null;
  try {
    const branding: NonNullable<LssConfigUpdate['branding']> = {
      title: brand.title.trim() || null,
      subtitle: brand.subtitle.trim() || null,
      defaultTheme: brand.theme as 'dark' | 'light',
    };
    // `branding.colors` is replaced wholesale by the config merge (it merges
    // one level, and `colors` IS that level), so the existing token map has to
    // be carried along — sending only the one field the wizard edits would
    // silently delete every other token the project had configured.
    if (brand.primary.trim()) {
      branding.colors = { ...(config.value?.branding.colors ?? {}), 'brand-primary': brand.primary.trim() };
    }
    const res = await api.updateConfig({ branding });
    config.value = res.config;
    // Branding is hot: re-pull it so the new identity shows immediately.
    await loadBranding();
    step.value = 'services';
    void scan();
  } catch (e) {
    error.value = e instanceof Error ? e.message : t('onboarding.brandSaveFailed');
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
    error.value = e instanceof Error ? e.message : t('onboarding.scanFailed');
  } finally {
    scanning.value = false;
  }
}

// The install/package step-warnings clear as the flags flip; everything else
// (TS config, unreadable file) stays. Each is rendered from its stable `code`,
// falling back to the server's English `message` for a code this dashboard
// does not know — a new server warning shows up as text rather than vanishing.
function displayWarnings(row: Row): string[] {
  return row.warnings
    .filter(w => !(row.installed && w.code === 'not-installed')
      && !(row.packaged && w.code === 'not-packaged'))
    .map(w => {
      const key = `onboarding.warning.${w.code}`;
      const translated = t(key, w.params);
      return translated === key ? w.message : translated;
    });
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

// A stack with no functions has no listener to give a port to. `undefined`
// means the scan could not tell (TS config, `${file(…)}`) — show the fields,
// because hiding them from a service that does have functions is the mistake
// that costs an afternoon, and an extra field costs nothing.
function showsPorts(row: Row): boolean {
  return row.hasFunctions !== false;
}

// A port edit that looks like a typo rather than a decision: same digits as the
// current value plus one more at the end (3072 → 30729). This exact slip put
// three services on dead ports here, silently — nothing downstream can tell it
// apart from a deliberate change, so the only place to catch it is the moment
// it is typed.
function suspiciousPortEdit(current: number | undefined, next: number | null): string | null {
  if (!current || next === null) return null;
  const from = String(current);
  const to = String(next);
  return to.length === from.length + 1 && to.startsWith(from) ? `${from} → ${to}` : null;
}

// Every suspicious edit currently in the form, as "<service>: 3072 → 30729".
const suspiciousEdits = computed(() => rows.value.flatMap(row => {
  if (!showsPorts(row)) return [];
  return ([
    [row.apiPort, parsePort(row.editApiPort)],
    [row.invokePort, parsePort(row.editInvokePort)],
  ] as Array<[number | undefined, number | null | 'invalid']>)
    .map(([current, next]) => (next === 'invalid' ? null : suspiciousPortEdit(current, next)))
    .filter((change): change is string => change !== null)
    .map(change => `${row.name}: ${change}`);
}));

// Cleared when the set of suspicious edits changes, so acknowledging one typo
// never signs off on the next one.
const confirmedEdits = ref<string>('');
const needsPortConfirmation = computed(() =>
  suspiciousEdits.value.length > 0 && confirmedEdits.value !== suspiciousEdits.value.join('|'));

function confirmPortEdits(): void {
  confirmedEdits.value = suspiciousEdits.value.join('|');
  error.value = null;
}

// Persist edited ports/commands into lss.config.json so registration (now and
// on every future boot) sees them. Called before package/register and on
// Finish; a no-edit run writes nothing. Returns false when an edit is invalid.
async function persistOverrides(): Promise<boolean> {
  if (needsPortConfirmation.value) {
    error.value = t('onboarding.portTypoConfirm', { changes: suspiciousEdits.value.join(', ') });
    return false;
  }
  const serviceRuntime: Record<string, { apiPort?: number | null; invokePort?: number | null }> = {};
  const servicePackaging: Record<string, { packageCommand?: string | null }> = {};
  for (const row of rows.value) {
    // A resources-only stack gets no port written for it at all: an
    // apiPort/invokePort on a service with no listener is a number that looks
    // configured and means nothing.
    const apiPort = showsPorts(row) ? parsePort(row.editApiPort) : null;
    const invokePort = showsPorts(row) ? parsePort(row.editInvokePort) : null;
    if (apiPort === 'invalid' || invokePort === 'invalid') {
      error.value = t('onboarding.portRangeError', { name: row.name });
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
  // Typed, not `Record<string, unknown>` + `as never`: LssConfigUpdate already
  // describes both map blocks with exactly these entry shapes, and the cast was
  // switching off the only check that catches a subkey the server would reject.
  const patch: LssConfigUpdate = {};
  if (Object.keys(serviceRuntime).length > 0) patch.serviceRuntime = serviceRuntime;
  if (Object.keys(servicePackaging).length > 0) patch.servicePackaging = servicePackaging;
  if (Object.keys(patch).length === 0) return true;
  try {
    await api.updateConfig(patch);
    // Re-read rather than guess: clearing an override falls back to the
    // service's own yml hint (or the global command), which only the server
    // can resolve. Guessing here is how a row ends up claiming "no API port"
    // for a service that is in fact listening.
    await refreshEffective();
    return true;
  } catch (e) {
    error.value = e instanceof Error ? e.message : t('onboarding.serviceSettingsSaveFailed');
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

// The generic failure line for each bulk action, resolved at call time so the
// message follows the current language.
const ACTION_FAILED_KEYS: Record<'install' | 'package' | 'register', string> = {
  install: 'onboarding.installFailed',
  package: 'onboarding.packageFailed',
  register: 'onboarding.registerFailed',
};

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
      row.resultMessage = e instanceof Error ? e.message : t(ACTION_FAILED_KEYS[action]);
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
  row.resultMessage = t('onboarding.installedIn', { seconds: (res.durationMs / 1000).toFixed(1) });
});

const packageSelected = () => runSelected('package', 'packaging', async (row) => {
  const res = await api.packageService(row.root);
  row.packaged = true;
  row.status = 'idle';
  row.resultMessage = t('onboarding.packagedIn', { seconds: (res.durationMs / 1000).toFixed(1) });
});

const registerSelected = () => runSelected('register', 'registering', async (row) => {
  const res = await api.registerService(row.root);
  row.status = 'done';
  row.resultMessage = t('onboarding.registerSummary', {
    resources: res.resourcesCount,
    functions: res.functionsCount,
    routes: res.routesCount,
  });
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
  if (selected.length === 0) return t('onboarding.register');
  if (fresh === 0) return t('onboarding.reRegisterCount', { count: selected.length });
  return t('onboarding.registerCount', { count: selected.length });
});

function rowTone(row: Row): 'success' | 'danger' | 'info' | 'neutral' {
  if (row.status === 'done' || row.registered) return 'success';
  if (row.status === 'failed') return 'danger';
  if (row.status === 'installing' || row.status === 'packaging' || row.status === 'registering') return 'info';
  return 'neutral';
}

function rowLabel(row: Row): string {
  if (row.registered || row.status === 'done') return t('onboarding.statusRegistered');
  if (row.status === 'failed') return t('onboarding.statusFailed');
  if (row.status === 'installing') return t('onboarding.statusInstalling');
  if (row.status === 'packaging') return t('onboarding.statusPackaging');
  if (row.status === 'registering') return t('onboarding.statusRegistering');
  if (!row.installed) return t('onboarding.statusNotInstalled');
  return row.packaged ? t('onboarding.statusPackaged') : t('onboarding.statusNotPackaged');
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
    error.value = e instanceof Error ? e.message : t('onboarding.configLoadFailed');
  }
});
</script>

<template>
  <TStack direction="vertical" gap="1.5rem">
    <TCard variant="outline">
      <TStack direction="vertical" gap="1rem">
        <TStack direction="horizontal" gap="0.75rem" align="center" wrap>
          <TText size="xl" weight="semibold">{{ t('onboarding.welcome') }}</TText>
          <TBadge tone="info" variant="soft">{{ t('onboarding.guidedSetup') }}</TBadge>
        </TStack>
        <TText tone="muted">
          {{ t('onboarding.intro') }}
        </TText>
        <TSteps :items="stepItems" :model-value="step" size="sm" />
      </TStack>
    </TCard>

    <TAlert v-if="error" variant="danger">{{ error }}</TAlert>

    <!-- Step 1: ports -->
    <TCard v-if="step === 'ports'" variant="outline">
      <template #header><TText weight="semibold">{{ t('onboarding.stepPorts') }}</TText></template>
      <TStack direction="vertical" gap="0.75rem">
        <TText tone="muted">
          {{ t('onboarding.portsIntroBefore') }}
          <TText family="mono" size="sm">AWS_ENDPOINT</TText>
          {{ t('onboarding.portsIntroAfter') }}
        </TText>
        <TGrid :columns="2" gap="0.75rem">
          <TFormField :label="t('onboarding.serverPortLabel')" :hint="t('onboarding.serverPortHint')">
            <TInput v-model.number="ports.serverPort" type="number" min="1024" max="65535" />
          </TFormField>
          <TFormField :label="t('onboarding.enginePortLabel')" :hint="t('onboarding.enginePortHint')">
            <TInput v-model.number="ports.enginePort" type="number" min="1024" max="65535" />
          </TFormField>
        </TGrid>
        <TStack direction="horizontal" gap="0.5rem" align="center" wrap>
          <TBadge :tone="singleListener ? 'success' : 'info'" variant="soft">
            {{ singleListener ? t('onboarding.singleListener') : t('onboarding.twoListeners') }}
          </TBadge>
          <TTag v-if="restartRequired.length" size="sm" variant="soft">
            {{ t('onboarding.restartRequired') }} lss stop && lss start
          </TTag>
        </TStack>
        <TStack direction="horizontal" gap="0.5rem" justify="flex-end">
          <TButton variant="solid" :loading="ports.saving" @click="savePorts">{{ t('common.continue') }}</TButton>
        </TStack>
      </TStack>
    </TCard>

    <!-- Step 2: branding -->
    <TCard v-if="step === 'brand'" variant="outline">
      <template #header><TText weight="semibold">{{ t('onboarding.stepBrand') }}</TText></template>
      <TStack direction="vertical" gap="0.75rem">
        <TText tone="muted">
          {{ t('onboarding.brandIntro') }}
        </TText>
        <TGrid :columns="2" gap="0.75rem">
          <TFormField :label="t('onboarding.titleLabel')" :hint="t('onboarding.titleHint')">
            <TInput v-model="brand.title" placeholder="Local Serverless Stack" />
          </TFormField>
          <TFormField :label="t('onboarding.subtitleLabel')">
            <TInput v-model="brand.subtitle" :placeholder="t('onboarding.subtitlePlaceholder')" />
          </TFormField>
          <TFormField :label="t('onboarding.themeLabel')">
            <TToggleGroup v-model="brand.theme" :options="themeOptions" size="md" />
          </TFormField>
          <TFormField :label="t('onboarding.brandColorLabel')" :hint="t('onboarding.brandColorHint')">
            <TInput v-model="brand.primary" placeholder="#0d9488" />
          </TFormField>
        </TGrid>
        <TStack direction="horizontal" gap="0.5rem" justify="space-between">
          <TButton variant="ghost" @click="step = 'ports'">{{ t('common.back') }}</TButton>
          <TButton variant="solid" :loading="brand.saving" @click="saveBrand">{{ t('common.continue') }}</TButton>
        </TStack>
      </TStack>
    </TCard>

    <!-- Step 3: scan + register -->
    <TCard v-if="step === 'services'" variant="outline">
      <template #header>
        <TStack direction="horizontal" gap="0.5rem" align="center" justify="space-between" wrap>
          <TText weight="semibold">{{ t('onboarding.stepServices') }}</TText>
          <TButton size="sm" variant="ghost" :loading="scanning" @click="scan">{{ t('onboarding.rescan') }}</TButton>
        </TStack>
      </template>
      <TStack direction="vertical" gap="0.75rem">
        <TText tone="muted">
          {{ t('onboarding.servicesIntro') }}
        </TText>
        <TText tone="muted">
          {{ t('onboarding.scanIntroBefore') }}
          <TText family="mono" size="sm">{{ projectRoot || '…' }}</TText>.
          {{ t('onboarding.scanIntroAfter') }}
          <TText family="mono" size="sm">lss.config.json</TText>
          (<TText family="mono" size="sm">serviceRuntime</TText> / <TText family="mono" size="sm">servicePackaging</TText>).
        </TText>

        <TStack v-if="scanning" direction="horizontal" justify="center">
          <TSpinner :label="t('onboarding.scanning')" />
        </TStack>

        <TAlert v-else-if="rows.length === 0" variant="info">
          {{ t('onboarding.emptyScan') }}
          <TText family="mono" size="sm">npx lss register &lt;dir&gt;</TText>.
        </TAlert>

        <template v-else>
          <TStack direction="horizontal" gap="0.5rem" align="center" wrap>
            <TCheckbox v-model="allSelected">{{ t('onboarding.selectAll') }}</TCheckbox>
            <TText tone="muted" size="sm">{{ t('onboarding.selectedCount', { count: selectedCount }) }}</TText>
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
                <!-- Ports only for a stack that has functions to serve them:
                     a resources-only stack (infra/shared and friends) opens no
                     listener, so offering it an apiPort invites a number that
                     will never be used — and, worse, believed. -->
                <TGrid :columns="showsPorts(row) ? 3 : 1" gap="0.5rem">
                  <template v-if="showsPorts(row)">
                    <TFormField :label="t('onboarding.apiPortLabel')" :hint="t('onboarding.apiPortHint')">
                      <TInput v-model="row.editApiPort" type="number" min="1024" max="65535" placeholder="3000" />
                    </TFormField>
                    <TFormField :label="t('onboarding.invokePortLabel')" :hint="t('onboarding.invokePortHint')">
                      <TInput v-model="row.editInvokePort" type="number" min="1024" max="65535" placeholder="13000" />
                    </TFormField>
                  </template>
                  <TFormField :label="t('onboarding.packageCommandLabel')" :hint="t('onboarding.packageCommandHint')">
                    <TInput v-model="row.editPackageCommand" placeholder="npx serverless package" />
                  </TFormField>
                </TGrid>
                <TText v-if="!showsPorts(row)" size="sm" tone="muted">
                  {{ t('onboarding.resourcesOnly') }}
                </TText>
                <TText v-if="row.resultMessage && row.status !== 'failed'" size="sm" tone="muted">
                  {{ row.resultMessage }}
                </TText>
                <TBadge v-if="row.resultMessage && row.status === 'failed'" tone="danger" variant="soft">
                  {{ row.resultMessage }}
                </TBadge>
                <TText v-if="row.resultOutput" size="sm" tone="muted" family="mono">
                  {{ row.resultOutput }}
                </TText>
                <!-- align="flex-start", not center: a scan warning routinely
                     wraps to two or three lines, and a mark centred on the
                     whole block stops reading as the marker of the first. -->
                <TStack
                  v-for="warning in [...displayWarnings(row), ...row.resultWarnings]"
                  :key="warning"
                  direction="horizontal"
                  gap="0.375rem"
                  align="flex-start"
                >
                  <TIcon name="triangle-alert" />
                  <TText size="sm" tone="muted">{{ warning }}</TText>
                </TStack>
              </TStack>
            </TStack>
          </TStack>
        </template>

        <!-- One digit too many at the end of a port is the classic slip in a
             numeric field, and it is indistinguishable from a deliberate
             choice without asking. Asking is the whole feature. -->
        <TAlert v-if="suspiciousEdits.length > 0" variant="warning">
          <TStack direction="vertical" gap="0.5rem">
            <TText size="sm">{{ t('onboarding.portTypoConfirm', { changes: suspiciousEdits.join(', ') }) }}</TText>
            <TStack direction="horizontal" gap="0.5rem" wrap>
              <TButton
                v-if="needsPortConfirmation"
                size="sm"
                variant="outline"
                @click="confirmPortEdits"
              >
                {{ t('onboarding.portTypoConfirmAction') }}
              </TButton>
              <TBadge v-else tone="success" variant="soft">{{ t('onboarding.portTypoConfirmed') }}</TBadge>
            </TStack>
          </TStack>
        </TAlert>

        <TStack direction="horizontal" gap="0.5rem" justify="space-between" wrap>
          <TButton variant="ghost" :disabled="working !== null" @click="step = 'brand'">{{ t('common.back') }}</TButton>
          <TStack direction="horizontal" gap="0.5rem" wrap>
            <TButton
              variant="outline"
              :disabled="selectedCount === 0 || working !== null"
              :loading="working === 'install'"
              @click="installSelected"
            >
              {{ t('onboarding.installSelected') }}
            </TButton>
            <TButton
              variant="outline"
              :disabled="selectedCount === 0 || working !== null"
              :loading="working === 'package'"
              @click="packageSelected"
            >
              {{ t('onboarding.packageSelected') }}
            </TButton>
            <TButton
              variant="solid"
              :disabled="selectedCount === 0 || working !== null"
              :loading="working === 'register'"
              @click="registerSelected"
            >
              {{ registerLabel }}
            </TButton>
            <TButton variant="outline" :disabled="working !== null" @click="finish">{{ t('common.finish') }}</TButton>
          </TStack>
        </TStack>
      </TStack>
    </TCard>
  </TStack>
</template>
