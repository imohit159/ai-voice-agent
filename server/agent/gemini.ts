import { GoogleGenAI, Modality, Type, Behavior, type Session, type LiveServerMessage } from '@google/genai';
import { type Call, type Order, type Settings } from '../../shared/domain.js';
import { config } from '../config.js';
import type { Store } from '../store.js';
import type { VoiceAgent, VoiceOutput } from './voice.js';
import { recordOutcome } from './outcome.js';
import { agentPrompt, openingGreeting } from './prompt.js';

export class GeminiAgent implements VoiceAgent {
  private session: Session | null = null;
  private closed = false;
  private customerText = '';
  private outcomeAudioStarted = false;
  private pendingMessages: LiveServerMessage[] = [];
  constructor(private call: Call, private store: Store, private output: VoiceOutput) {}
  async connect(order: Order, settings: Settings) {
    const ai = new GoogleGenAI({ apiKey: config.GEMINI_API_KEY, httpOptions: { apiVersion: 'v1beta' } });
    const controller = new AbortController();
    const timeout = setTimeout(() => { controller.abort(); this.fail('Gemini connection timed out.'); }, 12000);
    try {
      const session = await ai.live.connect({
        model: settings.geminiModel,
        config: {
          abortSignal: controller.signal, responseModalities: [Modality.AUDIO],
          inputAudioTranscription: {}, outputAudioTranscription: {},
          systemInstruction: agentPrompt(order, settings),
          speechConfig: { voiceConfig: { prebuiltVoiceConfig: { voiceName: 'Kore' } } },
          tools: [{ functionDeclarations: [{
            name: 'record_order_outcome', behavior: Behavior.BLOCKING,
            description: 'Record only an explicitly stated customer decision, with a verbatim quote from their speech. No external order-system changes.',
            parameters: { type: Type.OBJECT, properties: {
              outcome: { type: Type.STRING, enum: ['confirmed', 'declined', 'needs_follow_up'] },
              evidence: { type: Type.STRING, description: 'Exact quote from the customer supporting this decision.' },
            }, required: ['outcome', 'evidence'] },
          }] }],
        },
        callbacks: {
          onmessage: message => {
            if (this.closed) return;
            if (!this.session) {
              if (this.pendingMessages.length < 100) this.pendingMessages.push(message);
              return;
            }
            try { this.handle(message); } catch { this.fail('The voice session could not process a response.'); }
          },
          onerror: () => this.fail('Gemini voice connection failed. Verify your API key, model access, and quota.'),
          onclose: event => {
            if (!this.closed) {
              const reason = event.reason.replaceAll(config.GEMINI_API_KEY, '[redacted]').replace(/(?:key|token)=[^\s&]+/gi, 'credential=[redacted]').slice(0, 300);
              this.fail(`Gemini voice connection closed (code ${event.code}): ${reason || 'no reason supplied'}`);
            }
          },
        },
      });
      clearTimeout(timeout);
      if (this.closed) { session.close(); return false; }
      this.session = session;
      for (const message of this.pendingMessages) this.handle(message);
      this.pendingMessages = [];
      session.sendClientContent({ turns: [{ role: 'user', parts: [{ text: `The customer has answered. Say this exact introduction, including the provider name, and wait for their answer: ${JSON.stringify(openingGreeting(settings))}` }] }], turnComplete: true });
      return true;
    } catch {
      clearTimeout(timeout);
      this.fail('Could not connect to Gemini. Verify the server API key, model access, and quota.');
      return false;
    }
  }
  audio(data: string) {
    if (this.closed || !this.session) return;
    try { this.session.sendRealtimeInput({ audio: { data, mimeType: 'audio/pcm;rate=16000' } }); }
    catch { this.fail('Could not send audio to Gemini.'); }
  }
  text(text: string) {
    if (this.closed || !this.session) return;
    this.customerText = (this.customerText + text).slice(-16000);
    this.store.appendTranscript(this.call.id, 'customer', text);
    this.output.transcript('customer', text);
    this.session.sendClientContent({ turns: [{ role: 'user', parts: [{ text }] }], turnComplete: true });
  }
  private handle(message: LiveServerMessage) {
    const content = message.serverContent;
    if (content?.interrupted) this.output.interrupted();
    const inputText = content?.inputTranscription?.text;
    if (inputText) {
      this.customerText = (this.customerText + inputText).slice(-16000);
      this.store.appendTranscript(this.call.id, 'customer', inputText);
      this.output.transcript('customer', inputText);
    }
    const outputText = content?.outputTranscription?.text;
    if (outputText) {
      this.store.appendTranscript(this.call.id, 'agent', outputText);
      this.output.transcript('agent', outputText);
    }
    for (const part of content?.modelTurn?.parts ?? []) {
      if (part.inlineData?.data && part.inlineData.mimeType?.startsWith('audio/pcm')) {
        if (this.store.call(this.call.id)?.outcome) this.outcomeAudioStarted = true;
        this.output.audio(part.inlineData.data);
      }
    }
    for (const fc of message.toolCall?.functionCalls ?? []) {
      let response: Record<string, unknown>;
      response = fc.name === 'record_order_outcome'
        ? recordOutcome(this.call, this.store, this.customerText, fc.args, this.output)
        : { error: 'Invalid outcome. Ask the customer to clarify.' };
      this.session?.sendToolResponse({ functionResponses: [{ id: fc.id, name: fc.name, response }] });
    }
    if (content?.turnComplete) this.output.turnComplete(Boolean(this.store.call(this.call.id)?.outcome) && this.outcomeAudioStarted);
  }
  private fail(message: string) {
    if (this.closed) return;
    this.close();
    this.output.failure(message);
  }
  close() { this.closed = true; this.session?.close(); this.session = null; }
}
