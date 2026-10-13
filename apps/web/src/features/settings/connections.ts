import type { WorkspaceState } from '@orderline/contracts/api';

export function phoneConnectionStatus(
  state: WorkspaceState,
): 'ready' | 'calling_disabled' | 'missing' {
  const { exotelReady, missing } = state.connections;
  if (exotelReady) return 'ready';
  return missing.length === 1 && missing[0] === 'ENABLE_PHONE_CALLS'
    ? 'calling_disabled'
    : 'missing';
}
export function phoneConnectionNote(state: WorkspaceState): string {
  switch (phoneConnectionStatus(state)) {
    case 'ready':
      return 'Configured for test calling. Account and AgentStream access are verified when a call is placed.';
    case 'calling_disabled':
      return 'Credentials and public URL are configured. Phone calls are disabled on this server. Confirm Exotel bidirectional streaming access before enabling test calls.';
    case 'missing':
      return 'Finish the calling configuration to enable test calls.';
  }
}
