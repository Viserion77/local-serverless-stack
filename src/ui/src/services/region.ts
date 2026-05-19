import { ref, watch } from 'vue';

const STORAGE_KEY = 'lss-region';
const DEFAULT_REGION = 'us-east-1';

function readStored(): string {
  try {
    return localStorage.getItem(STORAGE_KEY) || DEFAULT_REGION;
  } catch {
    return DEFAULT_REGION;
  }
}

export const currentRegion = ref<string>(readStored());

watch(currentRegion, (v) => {
  try { localStorage.setItem(STORAGE_KEY, v); } catch { /* ignore */ }
});

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
