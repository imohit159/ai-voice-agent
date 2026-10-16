import type { Settings } from '@orderline/contracts';
import type { WorkspaceState } from '@orderline/contracts/api';
import type { Store } from '../../platform/persistence/store.js';

type Dependencies = {
  store: Store;
  connections: Pick<
    WorkspaceState['connections'],
    'telephony' | 'maxCallSeconds' | 'maxConcurrentCalls'
  >;
  /** AI providers the voice agent holds credentials for; null when it is unreachable. */
  voiceAgentStatus: () => Promise<{
    providers: Record<Settings['voiceProvider'], boolean>;
  } | null>;
};

export function createWorkspace({
  store,
  connections,
  voiceAgentStatus,
}: Dependencies) {
  return {
    async state(): Promise<WorkspaceState> {
      const settings = store.settings();
      const providers = (await voiceAgentStatus())?.providers;
      return {
        settings,
        orders: store.orders(),
        connections: {
          ...connections,
          geminiConfigured: providers?.gemini ?? false,
          sarvamConfigured: providers?.sarvam ?? false,
          geminiModel: settings.geminiModel,
          selectedConfigured: providers?.[settings.voiceProvider] ?? false,
        },
      };
    },
    saveSettings(settings: Settings) {
      store.saveSettings(settings);
      return { settings };
    },
    resetDemo() {
      store.resetDemo();
      return { order: store.order('DEMO-1001') };
    },
  };
}
