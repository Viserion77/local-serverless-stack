// One mapping from a web function's environment state to a badge tone and its
// label, shared by the Lambdas list section and the detail screen so the two
// cannot drift apart.
import type { TBadgeTone } from '@treeui/vue';

export function webStateTone(state: string): TBadgeTone {
  switch (state) {
    case 'ready': return 'success';
    case 'starting': return 'info';
    case 'cold': return 'neutral';
    default: return 'danger';
  }
}

export function webStateLabel(state: string, t: (key: string) => string): string {
  switch (state) {
    case 'ready': return t('webFunctions.stateReady');
    case 'starting': return t('webFunctions.stateStarting');
    case 'cold': return t('webFunctions.stateCold');
    case 'error': return t('webFunctions.stateError');
    default: return state;
  }
}

export function httpStatusTone(status: number): TBadgeTone {
  if (status >= 500) return 'danger';
  if (status >= 400) return 'warning';
  return 'success';
}
