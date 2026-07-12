import { computed, ref, watch } from 'vue';

const STORAGE_KEY = 'lss-region';
const DEFAULT_REGION = 'us-east-1';

function readStored(): string {
  try {
    return localStorage.getItem(STORAGE_KEY) || DEFAULT_REGION;
  } catch {
    return DEFAULT_REGION;
  }
}

// Stored value is only a first-paint cache; the server-configured region
// takes over once /api/config resolves on app mount (applyConfiguredRegion).
export const currentRegion = ref<string>(readStored());

watch(currentRegion, (v) => {
  try { localStorage.setItem(STORAGE_KEY, v); } catch { /* ignore */ }
});

// Region from lss.config.json, kept so it stays selectable in the dropdown
// even when it is not part of AWS_REGIONS and no longer selected.
const configuredRegion = ref<string>('');

// Called from App.vue with the region from lss.config.json — on every full
// load the configured region wins over whatever a previous session stored,
// unless the user already picked a region while /api/config was in flight.
export function applyConfiguredRegion(region: string, userPicked = false): void {
  if (!region) return;
  configuredRegion.value = region;
  if (!userPicked) currentRegion.value = region;
}

export const AWS_REGIONS: { value: string; label: string }[] = [
  { value: 'us-east-1', label: 'us-east-1 — N. Virginia' },
  { value: 'us-east-2', label: 'us-east-2 — Ohio' },
  { value: 'us-west-1', label: 'us-west-1 — N. California' },
  { value: 'us-west-2', label: 'us-west-2 — Oregon' },
  { value: 'eu-west-1', label: 'eu-west-1 — Ireland' },
  { value: 'eu-west-2', label: 'eu-west-2 — London' },
  { value: 'eu-west-3', label: 'eu-west-3 — Paris' },
  { value: 'eu-central-1', label: 'eu-central-1 — Frankfurt' },
  { value: 'eu-north-1', label: 'eu-north-1 — Stockholm' },
  { value: 'ap-southeast-1', label: 'ap-southeast-1 — Singapore' },
  { value: 'ap-southeast-2', label: 'ap-southeast-2 — Sydney' },
  { value: 'ap-northeast-1', label: 'ap-northeast-1 — Tokyo' },
  { value: 'ap-northeast-2', label: 'ap-northeast-2 — Seoul' },
  { value: 'ap-south-1', label: 'ap-south-1 — Mumbai' },
  { value: 'sa-east-1', label: 'sa-east-1 — São Paulo' },
  { value: 'ca-central-1', label: 'ca-central-1 — Canada' },
];

// Options for the region select: regions outside the list above (a custom
// region in lss.config.json, or a stored selection) are appended so they
// render — and stay selectable after the user switches away from them.
export const regionOptions = computed(() => {
  const known = new Set(AWS_REGIONS.map((o) => o.value));
  const extras = [configuredRegion.value, currentRegion.value]
    .filter((r, i, arr) => r && !known.has(r) && arr.indexOf(r) === i)
    .map((r) => ({ value: r, label: r }));
  return extras.length ? [...AWS_REGIONS, ...extras] : AWS_REGIONS;
});
