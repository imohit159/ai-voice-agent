import { useState, type FormEvent } from 'react';
import { useMutation, useQueryClient } from '@tanstack/react-query';
import type { Settings } from '@orderline/contracts';
import {
  AGENT_LANGUAGES,
  SARVAM_MODELS,
  SARVAM_STT_MODELS,
  SARVAM_TTS_MODELS,
} from '@orderline/contracts/models';
import type { WorkspaceState } from '@orderline/contracts/api';
import { Badge } from '../../../shared/ui/Badge.js';
import { useToast } from '../../../shared/ui/Toast.js';
import { authService } from '../../auth/services/auth.js';
import { settingsService } from '../services/settings.js';

export function SettingsPage({
  state,
  isAdmin,
}: {
  state: WorkspaceState;
  isAdmin: boolean;
}) {
  const toast = useToast();
  const queryClient = useQueryClient();
  const [draft, setDraft] = useState<Settings>(state.settings);
  const save = useMutation({
    mutationFn: settingsService.save,
    onSuccess: () => {
      toast(
        'Saved. New calls use these settings; calls in progress keep theirs.',
      );
      void queryClient.invalidateQueries({ queryKey: ['workspace'] });
    },
    onError: (error) => toast(error.message),
  });
  const set = <K extends keyof Settings>(key: K, value: Settings[K]) =>
    setDraft((current) => ({ ...current, [key]: value }));
  const c = state.connections;

  return (
    <>
      <div className="page-heading">
        <div>
          <span className="eyebrow">AGENT CONFIGURATION</span>
          <h1>Agent & connections</h1>
          <p>
            Choose how the agent speaks.{' '}
            {isAdmin ? '' : 'Only administrators can change these.'}
          </p>
        </div>
      </div>
      <div className="settings-grid">
        <section className="panel">
          <div className="panel-heading">
            <h2>Conversation</h2>
          </div>
          <form
            className="settings-form"
            onSubmit={(event) => {
              event.preventDefault();
              save.mutate(draft);
            }}
          >
            <fieldset disabled={!isAdmin || save.isPending}>
              <label htmlFor="store-name">Store name</label>
              <input
                id="store-name"
                value={draft.storeName}
                maxLength={80}
                required
                onChange={(e) => set('storeName', e.target.value)}
              />
              <label htmlFor="language">Conversation language</label>
              <select
                id="language"
                value={draft.language}
                onChange={(e) =>
                  set('language', e.target.value as Settings['language'])
                }
              >
                {AGENT_LANGUAGES.map((language) => (
                  <option key={language}>{language}</option>
                ))}
              </select>
              <label htmlFor="provider">AI approach</label>
              <select
                id="provider"
                value={draft.voiceProvider}
                onChange={(e) =>
                  set(
                    'voiceProvider',
                    e.target.value as Settings['voiceProvider'],
                  )
                }
              >
                <option value="gemini">Gemini Live (speech-to-speech)</option>
                <option value="sarvam">Sarvam (speech → model → speech)</option>
              </select>
              {draft.voiceProvider === 'gemini' ? (
                <>
                  <label htmlFor="gemini-model">Gemini Live model</label>
                  <input
                    id="gemini-model"
                    value={draft.geminiModel}
                    maxLength={120}
                    required
                    onChange={(e) => set('geminiModel', e.target.value)}
                  />
                </>
              ) : (
                <>
                  <ModelSelect
                    id="sarvam-model"
                    label="Conversation model"
                    value={draft.sarvamModel}
                    options={SARVAM_MODELS}
                    onChange={(v) =>
                      set('sarvamModel', v as Settings['sarvamModel'])
                    }
                  />
                  <ModelSelect
                    id="sarvam-stt"
                    label="Speech recognition"
                    value={draft.sarvamSttModel}
                    options={SARVAM_STT_MODELS}
                    onChange={(v) =>
                      set('sarvamSttModel', v as Settings['sarvamSttModel'])
                    }
                  />
                  <ModelSelect
                    id="sarvam-tts"
                    label="Voice synthesis"
                    value={draft.sarvamTtsModel}
                    options={SARVAM_TTS_MODELS}
                    onChange={(v) =>
                      set('sarvamTtsModel', v as Settings['sarvamTtsModel'])
                    }
                  />
                </>
              )}
              {isAdmin && (
                <button className="primary" type="submit">
                  {save.isPending ? 'Saving…' : 'Save settings'} <span>→</span>
                </button>
              )}
            </fieldset>
          </form>
          <div className="settings-foot">
            <span>
              Maximum call <strong>{c.maxCallSeconds}s</strong>
            </span>
            <span>
              Simultaneous conversations <strong>{c.maxConcurrentCalls}</strong>
            </span>
          </div>
        </section>
        <div>
          <section className="panel connection">
            <div className="panel-heading">
              <h2>Connections</h2>
            </div>
            <Connection
              name="Gemini Live"
              detail={c.geminiModel}
              ready={c.geminiConfigured}
            />
            <Connection
              name="Sarvam"
              detail={state.settings.sarvamModel}
              ready={c.sarvamConfigured}
            />
            <div className="connection-row">
              <span className="connection-initial">T</span>
              <div>
                <strong>Telephony</strong>
                <small>
                  {c.telephony.callerId
                    ? `Caller ID ${c.telephony.callerId}`
                    : 'No caller ID'}
                </small>
              </div>
              <Badge
                value={c.telephony.provider === 'plivo' ? 'ready' : 'simulated'}
              />
            </div>
            <p className="connection-note">
              AI keys live with the voice agent. "Setup needed" means it is not
              running or lacks that key.
            </p>
          </section>
          <PasswordForm />
        </div>
      </div>
    </>
  );
}

function ModelSelect(props: {
  id: string;
  label: string;
  value: string;
  options: readonly string[];
  onChange: (value: string) => void;
}) {
  return (
    <>
      <label htmlFor={props.id}>{props.label}</label>
      <select
        id={props.id}
        value={props.value}
        onChange={(e) => props.onChange(e.target.value)}
      >
        {props.options.map((option) => (
          <option key={option}>{option}</option>
        ))}
      </select>
    </>
  );
}

function Connection({
  name,
  detail,
  ready,
}: {
  name: string;
  detail: string;
  ready: boolean;
}) {
  return (
    <div className="connection-row">
      <span className="connection-initial">{name.charAt(0)}</span>
      <div>
        <strong>{name}</strong>
        <small>{detail}</small>
      </div>
      <Badge value={ready ? 'configured' : 'missing'} />
    </div>
  );
}

function PasswordForm() {
  const toast = useToast();
  const [busy, setBusy] = useState(false);
  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const form = event.currentTarget;
    const data = new FormData(form);
    setBusy(true);
    try {
      await authService.changePassword(
        String(data.get('current')),
        String(data.get('next')),
      );
      form.reset();
      toast('Password changed. Your other sessions were signed out.');
    } catch (error) {
      toast(
        error instanceof Error
          ? error.message
          : 'Could not change the password.',
      );
    } finally {
      setBusy(false);
    }
  }
  return (
    <section className="panel">
      <div className="panel-heading">
        <h2>Your password</h2>
      </div>
      <form className="settings-form" onSubmit={submit}>
        <label htmlFor="current">Current password</label>
        <input
          id="current"
          name="current"
          type="password"
          autoComplete="current-password"
          required
        />
        <label htmlFor="next">New password (12+ characters)</label>
        <input
          id="next"
          name="next"
          type="password"
          autoComplete="new-password"
          minLength={12}
          required
        />
        <button className="secondary" type="submit" disabled={busy}>
          Change password
        </button>
      </form>
    </section>
  );
}
