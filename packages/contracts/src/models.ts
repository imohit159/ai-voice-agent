// Model choices must match what the Pipecat voice agent accepts; Pipecat
// validates Sarvam models strictly and refuses to start a session otherwise.
export const VOICE_PROVIDERS = ['gemini', 'sarvam'] as const;
export const DEFAULT_GEMINI_MODEL = 'gemini-3.8-live';
export const SARVAM_MODELS = [
  'sarvam-105b-conversations',
  'sarvam-105b',
] as const;
export const SARVAM_STT_MODELS = ['saaras:v4', 'saaras:v3'] as const;
export const SARVAM_TTS_MODELS = ['bulbul:v3'] as const;
export const AGENT_LANGUAGES = [
  'Hindi',
  'English',
  'Hindi and English',
] as const;
