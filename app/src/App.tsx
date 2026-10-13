import { useCallback, useEffect, useState } from 'react';
import { api, onLocked, type AppState, type LockReason } from './api';
import { applyAccent } from './theme';
import { startActivityTracking, stopAllPlaying } from './activity';
import { Start } from './screens/Start';
import { CreateVault } from './screens/CreateVault';
import { RecoveryWords } from './screens/RecoveryWords';
import { Recover } from './screens/Recover';
import { NewPassword } from './screens/NewPassword';
import { Library } from './screens/Library';
import { Settings } from './screens/Settings';

export type Screen =
  | { name: 'start'; select?: string }
  | { name: 'create' }
  | { name: 'recover'; path: string }
  | { name: 'newPassword' }
  | { name: 'words'; words: string[]; context: 'create' | 'reset' }
  | { name: 'library' }
  | { name: 'settings' };

export interface Nav {
  app: AppState;
  go: (s: Screen) => void;
  refresh: () => Promise<AppState>;
}

const LOCK_MESSAGES: Record<LockReason, string> = {
  idle: 'Locked because the app was idle.',
  safetyNet: 'Locked by the safety net (no input for a long time).',
  systemLocked: 'Locked because Windows was locked.',
  sleep: 'Locked because the PC went to sleep.',
  minimized: 'Locked because the window was minimised.',
  panicKey: 'Locked with the panic key.',
  manual: 'Vault locked.',
};

export function App() {
  const [app, setApp] = useState<AppState | null>(null);
  const [screen, setScreen] = useState<Screen>({ name: 'start' });
  const [toast, setToast] = useState<string | null>(null);
  const [fatal, setFatal] = useState<string | null>(null);

  const refresh = useCallback(async () => {
    const s = await api.getState();
    setApp(s);
    applyAccent(s.config.accent);
    return s;
  }, []);

  useEffect(() => {
    refresh()
      .then((s) => {
        if (s.session) setScreen(s.session.needsNewPassword ? { name: 'newPassword' } : { name: 'library' });
      })
      .catch((e) => setFatal(String(e)));
    const stopTracking = startActivityTracking();
    const unlisten = onLocked((reason) => {
      stopAllPlaying();
      if (document.fullscreenElement) document.exitFullscreen().catch(() => {});
      setScreen({ name: 'start' });
      setToast(LOCK_MESSAGES[reason] ?? 'Vault locked.');
      refresh().catch(() => {});
    });
    return () => {
      stopTracking();
      unlisten.then((u) => u());
    };
  }, [refresh]);

  useEffect(() => {
    if (!toast) return;
    const t = setTimeout(() => setToast(null), 6000);
    return () => clearTimeout(t);
  }, [toast]);

  if (fatal) return <div className="empty"><h1>Media Vault couldn't start</h1><p className="muted">{fatal}</p></div>;
  if (!app) return <div className="app" />;

  const nav: Nav = { app, go: setScreen, refresh };
  return (
    <div className="app">
      {screen.name === 'start' && <Start nav={nav} select={screen.select} />}
      {screen.name === 'create' && <CreateVault nav={nav} />}
      {screen.name === 'recover' && <Recover nav={nav} path={screen.path} />}
      {screen.name === 'newPassword' && <NewPassword nav={nav} />}
      {screen.name === 'words' && <RecoveryWords nav={nav} words={screen.words} context={screen.context} />}
      {screen.name === 'library' && <Library nav={nav} />}
      {screen.name === 'settings' && <Settings nav={nav} />}
      {toast && (
        <div className="toast" role="status">
          {toast}
          <button type="button" className="link" onClick={() => setToast(null)}>Dismiss</button>
        </div>
      )}
    </div>
  );
}
