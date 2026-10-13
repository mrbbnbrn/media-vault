import { useState } from 'react';
import { api } from '../api';
import type { Nav } from '../App';
import { Busy, ErrorBox, PasswordPair, TopBar, passwordsOk } from '../components/Chrome';

/** Required right after unlocking with the recovery key. */
export function NewPassword({ nav }: { nav: Nav }) {
  const min = nav.app.minPasswordChars;
  const [password, setPassword] = useState('');
  const [confirm, setConfirm] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    setBusy(true);
    setError(null);
    try {
      await api.setNewPassword(password);
      setPassword('');
      setConfirm('');
      await nav.refresh();
      nav.go({ name: 'library' });
    } catch (err) {
      setError((err as Error).message);
      setBusy(false);
    }
  }

  return (
    <>
      <TopBar title={nav.app.session?.name}>
        <button type="button" className="btn btn-sm" onClick={() => api.lock()}>Lock</button>
      </TopBar>
      <div className="page">
        <form className="page-inner" style={{ maxWidth: 520 }} onSubmit={submit}>
          <div className="field" style={{ gap: 10 }}>
            <h1>Set a new password</h1>
            <p className="lead">Your recovery key worked. Choose a new password for everyday unlocking. Your recovery words stay the same.</p>
          </div>
          <PasswordPair password={password} confirm={confirm} onPassword={setPassword} onConfirm={setConfirm} min={min} autoFocus label="New password" />
          <ErrorBox error={error} />
          <div className="row" style={{ justifyContent: 'flex-end' }}>
            <button type="submit" className="btn btn-primary" disabled={busy || !passwordsOk(password, confirm, min)}>
              {busy ? <Busy label="Saving…" /> : 'Save password'}
            </button>
          </div>
        </form>
      </div>
    </>
  );
}
