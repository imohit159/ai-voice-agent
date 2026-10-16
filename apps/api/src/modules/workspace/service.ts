import type { Settings } from '@orderline/contracts';
import type { WorkspaceState } from '@orderline/contracts/api';
import type { Store } from '../../platform/persistence/store.js';

export class WorkspaceError extends Error {
  constructor(
    public statusCode: number,
    message: string,
  ) {
    super(message);
  }
}

type Dependencies = {
  store: Store;
  connections: Pick<
    WorkspaceState['connections'],
    | 'geminiConfigured'
    | 'sarvamConfigured'
    | 'telephony'
    | 'maxCallSeconds'
    | 'maxConcurrentCalls'
  >;
  voiceReadiness: (provider: Settings['voiceProvider']) => string[];
};

export function createWorkspace({
  store,
  connections,
  voiceReadiness,
}: Dependencies) {
  return {
    state(): WorkspaceState {
      const settings = store.settings();
      return {
        settings,
        orders: store.orders(),
        calls: store.calls(),
        connections: {
          ...connections,
          geminiModel: settings.geminiModel,
          selectedConfigured:
            voiceReadiness(settings.voiceProvider).length === 0,
        },
      };
    },
    saveSettings(settings: Settings) {
      store.saveSettings(settings);
      return { settings };
    },
    resetDemo() {
      if (store.activeCount())
        throw new WorkspaceError(
          409,
          'Finish or reconcile active calls first.',
        );
      store.resetDemo();
      return { order: store.order('DEMO-1001') };
    },
  };
}
