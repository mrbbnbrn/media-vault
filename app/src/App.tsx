import { useCallback, useEffect, useState } from 'react';
import { api, onLocked, type AppState, type LockReason } from './api';
import { applyAccent } from './theme';
import { setPrefsConfig } from './prefs';
import { clearUndo } from './undo';
import { startActivityTracking, stopAllPlaying } from './activity';
import { Start } from './screens/Start';
import { CreateVault } from './screens/CreateVault';
import { RecoveryWords } from './screens/RecoveryWords';
import { Recover } from './screens/Recover';
import { NewPassword } from './screens/NewPassword';
import { Library, type LibView } from './screens/Library';
import { Settings } from './screens/Settings';
import { Viewer } from './screens/Viewer';
import { MultiScreen } from './screens/MultiScreen';
import { startExternalDrops } from './drop';
import { startThumbnailer } from './media';
import { runSelfTestIfRequested } from './selftest';
import type { PlayItem } from './media';
import type { Order } from './playlist';

export type Screen =
  | { name: 'start'; select?: string }
  | { name: 'create' }
  | { name: 'recover'; path: string }
  | { name: 'newPassword' }
  | { name: 'words'; words: string[]; context: 'create' | 'reset' }
  | { name: 'library' }
  | { name: 'settings' }
  | { name: 'viewer'; items: PlayItem[]; startKey?: string; title: string; auto: boolean; back: LibView; order?: Order }
  | { name: 'multi'; back: LibView }
  | { name: 'player' };

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
  const [libView, setLibView] = useState<LibView>({ kind: 'folders' });

  const refresh = useCallback(async () => {
    const s = await api.getState();
    setApp(s);
    setPrefsConfig(s.config);
    applyAccent(s.config.accent);
    return s;
  }, []);

  useEffect(() => {
    runSelfTestIfRequested().catch(() => {});
    refresh()
      .then((s) => {
        if (s.session) setScreen(s.session.needsNewPassword ? { name: 'newPassword' } : { name: 'library' });
      })
      .catch((e) => setFatal(String(e)));
    const stopTracking = startActivityTracking();
    startExternalDrops();
    const unlisten = onLocked((reason) => {
      stopAllPlaying();
      clearUndo();
      if (document.fullscreenElement) document.exitFullscreen().catch(() => {});
      setScreen((cur) => (cur.name === 'player' ? cur : { name: 'start' }));
      setLibView({ kind: 'folders' });
      setToast(LOCK_MESSAGES[reason] ?? 'Vault locked.');
      refresh().catch(() => {});
    });
    return () => {
      stopTracking();
      unlisten.then((u) => u());
    };
  }, [refresh]);

  // Thumbnails are made in the background while a vault is open.
  const open = !!app?.session && !app.session.needsNewPassword && !app.session.name.startsWith('SelfTest');
  useEffect(() => (open ? startThumbnailer() : undefined), [open]);

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
      {/* Light sharpening used after smoothing pictures (Settings → Viewer). */}
      <svg width="0" height="0" style={{ position: 'absolute' }} aria-hidden="true">
        <filter id="mv-sharpen" colorInterpolationFilters="sRGB">
          <feConvolveMatrix order="3" preserveAlpha="true" kernelMatrix="0 -0.35 0 -0.35 2.4 -0.35 0 -0.35 0" />
        </filter>
      </svg>
      {screen.name === 'start' && <Start nav={nav} select={screen.select} />}
      {screen.name === 'create' && <CreateVault nav={nav} />}
      {screen.name === 'recover' && <Recover nav={nav} path={screen.path} />}
      {screen.name === 'newPassword' && <NewPassword nav={nav} />}
      {screen.name === 'words' && <RecoveryWords nav={nav} words={screen.words} context={screen.context} />}
      {screen.name === 'library' && app.session && <Library nav={nav} view={libView} setView={setLibView} />}
      {screen.name === 'settings' && <Settings nav={nav} />}
      {screen.name === 'viewer' && (
        <Viewer nav={nav} items={screen.items} startKey={screen.startKey} title={screen.title} auto={screen.auto} order={screen.order}
          onBack={() => { setLibView(screen.back); setScreen(app.session ? { name: 'library' } : { name: 'start' }); }} />
      )}
      {screen.name === 'multi' && app.session && (
        <MultiScreen nav={nav} vault onBack={() => { setLibView(screen.back); setScreen({ name: 'library' }); }} />
      )}
      {screen.name === 'player' && (
        <MultiScreen nav={nav} vault={false} onBack={() => setScreen(app.session ? { name: 'library' } : { name: 'start' })} />
      )}
      {toast && (
        <div className="toast" role="status">
          {toast}
          <button type="button" className="link" onClick={() => setToast(null)}>Dismiss</button>
        </div>
      )}
    </div>
  );
}
