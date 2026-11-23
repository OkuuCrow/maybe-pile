/**
 * Steam account setup: the user's own Web API key (stored by main with
 * safeStorage; this screen can only learn whether one is set) and the account
 * (SteamID64, profile URL or custom name). Includes the setup/privacy help.
 */
import { useId, useState } from 'react';
import type { LibrarySourceView } from '../../../shared/types';
import { call, errorOf, getApi } from '../../app/api';
import { useToast } from '../../app/toast';
import { Notice } from '../../components/Bits';
import { TextField } from '../../components/Fields';

export function SteamHelp() {
  return (
    <details className="help">
      <summary>How to set up Steam import</summary>
      <ol>
        <li>
          Get your own Steam Web API key at <strong>steamcommunity.com/dev/apikey</strong> (sign in to Steam;
          any domain name such as “localhost” is fine). Keys are personal — Maybe Pile never ships or shares
          one.
        </li>
        <li>
          Find your account: your profile URL (<code>steamcommunity.com/id/yourname</code> or{' '}
          <code>…/profiles/7656119…</code>), the custom name in it, or your 17-digit SteamID64.
        </li>
        <li>
          Make your game details visible: on Steam open{' '}
          <strong>Profile → Edit Profile → Privacy Settings</strong>, set <strong>My profile</strong> and{' '}
          <strong>Game details</strong> to <strong>Public</strong>. Changes can take a few minutes. You can
          set them back to Private after importing.
        </li>
      </ol>
      <p>
        What is stored: the key (encrypted by your operating system, never exported), your account as typed,
        and a snapshot of game names, app ids, playtime and last-played dates. Nothing is sent anywhere except
        Steam.
      </p>
      <p>
        About playtime: Steam can miss offline play, games started outside Steam, free weekends and Family
        Sharing. “Never played” means Steam recorded no time, not that you definitely never played it.
      </p>
    </details>
  );
}

export function SteamSetupForm({
  source,
  onSaved,
}: {
  source: LibrarySourceView | null;
  onSaved: (sources: LibrarySourceView[]) => void;
}) {
  const toast = useToast();
  const uid = useId();
  const [label, setLabel] = useState(source?.label ?? 'My Steam library');
  const [account, setAccount] = useState(source?.accountInput ?? '');
  const [apiKey, setApiKey] = useState('');
  const [errors, setErrors] = useState<Record<string, string>>({});
  const [busy, setBusy] = useState(false);
  const [testMsg, setTestMsg] = useState<{ ok: boolean; text: string; recovery?: string | undefined } | null>(
    null,
  );

  const save = async (): Promise<LibrarySourceView[] | null> => {
    setBusy(true);
    setErrors({});
    try {
      const list = await call(
        getApi().sources.saveSteam({ sourceId: source?.id ?? null, label, account, apiKey }),
      );
      setApiKey('');
      onSaved(list);
      return list;
    } catch (e) {
      const err = errorOf(e);
      setErrors(err.fieldErrors ?? {});
      toast.error(err);
      return null;
    } finally {
      setBusy(false);
    }
  };

  const test = async () => {
    const list = await save();
    if (!list) return;
    const id = source?.id ?? list.filter((s) => s.kind === 'steam').at(-1)?.id;
    if (!id) return;
    setBusy(true);
    setTestMsg(null);
    try {
      const r = await call(getApi().sources.testSteam({ sourceId: id }));
      setTestMsg({ ok: true, text: r.message });
    } catch (e) {
      const err = errorOf(e);
      setErrors(err.fieldErrors ?? {});
      setTestMsg({ ok: false, text: err.message, recovery: err.recovery });
    } finally {
      setBusy(false);
    }
  };

  return (
    <form
      className="steam-setup"
      aria-labelledby={`${uid}-h`}
      onSubmit={(e) => {
        e.preventDefault();
        void save();
      }}
    >
      <h3 id={`${uid}-h`}>{source ? `Steam: ${source.label}` : 'Connect a Steam account'}</h3>
      <SteamHelp />
      <TextField label="Label" value={label} onChange={setLabel} error={errors['label']} />
      <TextField
        label="SteamID64, profile URL or custom profile name"
        required
        value={account}
        onChange={setAccount}
        error={errors['account']}
        hint="Only steamcommunity.com profile URLs are accepted."
      />
      <TextField
        label="Steam Web API key"
        type="password"
        value={apiKey}
        onChange={setApiKey}
        error={errors['apiKey']}
        hint={
          source?.keySet
            ? 'A key is saved (it is never shown). Leave empty to keep it, or paste a new one to replace it.'
            : '32 characters from steamcommunity.com/dev/apikey. Stored encrypted on this computer only.'
        }
      />
      <div className="row wrap">
        <button type="submit" className="button" disabled={busy}>
          Save
        </button>
        <button type="button" className="button button-primary" onClick={() => void test()} disabled={busy}>
          {busy ? 'Working…' : 'Test connection'}
        </button>
        {source?.keySet && (
          <button
            type="button"
            className="button"
            onClick={() =>
              void call(getApi().sources.clearSteamKey())
                .then((l) => (onSaved(l), toast.success('Steam key removed from this computer.')))
                .catch((e: unknown) => toast.error(errorOf(e)))
            }
          >
            Forget key
          </button>
        )}
      </div>
      <div aria-live="polite">
        {testMsg && (
          <Notice kind={testMsg.ok ? 'success' : 'warning'}>
            <strong>{testMsg.ok ? 'Connected. ' : 'Not connected. '}</strong>
            {testMsg.text}
            {testMsg.recovery && <> {testMsg.recovery}</>}
          </Notice>
        )}
      </div>
    </form>
  );
}
