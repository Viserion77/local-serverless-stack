import { computed, ref } from 'vue';

// Which AWS engine this orchestrator is serving. The dashboard used to say
// "LocalStack" everywhere — header badge, Overview cards, empty states, delete
// confirmations — regardless of the active engine, so a self-engine user (no
// Docker, no container, no token anywhere in the stack) was told they were
// running LocalStack. Every one of those strings now reads from here.

export type EngineKind = 'localstack' | 'self';

export const engineKind = ref<EngineKind>('localstack');

export function applyEngineKind(kind: EngineKind | undefined): void {
  if (kind) engineKind.value = kind;
}

export const isSelfEngine = computed(() => engineKind.value === 'self');

/** Display name for the active engine — use in any user-facing string. */
export const engineLabel = computed(() => (isSelfEngine.value ? 'Self engine' : 'LocalStack'));
