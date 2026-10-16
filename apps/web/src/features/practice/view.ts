import type { WorkspaceState } from '@orderline/contracts/api';
import { esc } from '../../ui/format.js';
import { transcriptHtml } from '../../ui/format.js';

export interface PracticeState {
  running: boolean;
  status: 'idle' | 'connecting' | 'live' | 'ended';
  transcript: { role: string; text: string }[];
}

export function agentPanel(
  state: WorkspaceState,
  practice: PracticeState,
  busy: boolean,
) {
  const { running, status: voiceStatus, transcript: liveTranscript } = practice;
  const statusText: Record<PracticeState['status'], string> = {
    idle: 'Ready for a conversation',
    connecting: 'Connecting to your agent…',
    live: 'Live: speak naturally',
    ended: 'Practice complete',
  };
  return `<section class="panel agent-panel"><div class="panel-heading"><h2>Meet your voice agent</h2><span class="live-label"><span class="dot"></span>${running ? 'LIVE' : 'PRACTICE'}</span></div><div class="agent-stage ${running ? 'running' : ''}"><div class="soundmark" aria-hidden="true">${Array.from({ length: 9 }, () => `<i></i>`).join('')}</div><h3 id="voice-status">${statusText[voiceStatus] ?? 'Ready'}</h3><p>${esc(state.settings.storeName)} <span>·</span> ${esc(state.settings.language)}</p></div><div class="practice-copy"><strong>Talk through a test order</strong><p>Use your microphone to experience the same conversation before placing a phone call.</p></div><button id="practice" class="${running ? 'stop-button' : 'secondary'}" ${(busy || !state.connections.selectedConfigured) && !running ? 'disabled' : ''}>${running ? 'End practice' : 'Start voice practice'} <span>${running ? '■' : '→'}</span></button><small class="practice-note">${state.connections.selectedConfigured ? `Uses ${state.settings.voiceProvider === 'sarvam' ? 'Sarvam' : 'Gemini'} through the voice agent · No phone call is placed` : `The voice agent is not running, or lacks ${state.settings.voiceProvider === 'sarvam' ? 'SARVAM_API_KEY' : 'GEMINI_API_KEY'}`}</small><div id="live-transcript" class="live-transcript" aria-live="polite">${transcriptHtml(liveTranscript)}</div></section>`;
}
