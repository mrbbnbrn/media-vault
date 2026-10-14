import { useCallback, useEffect, useRef, useState } from 'react';
import { api, onEvent, onLocked, type AppState, type LockReason } from './api';
import { applyAccent } from './theme';
import { setPrefsConfig } from './prefs';
import { clearUndo } from './undo';
import { clearViewMemory } from './viewmemory';
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
import { startFaceScanner } from './ml/facescan';
import { startClipIndexer } from './ml/smart';
import { startPreviewMaker } from './previews';
import { startFingerprinter } from './fingerprint';
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
  // Back / forward through library views, like a web browser.
  const viewRef = useRef<LibView>(libView);
  viewRef.current = libView;
  const hist = useRef<{ back: LibView[]; fwd: LibView[] }>({ back: [], fwd: [] });
  const [, setHistTick] = useState(0);
  /** An item to scroll to and highlight when the library shows again. */
  const [reveal, setReveal] = useState<{ id: number; n: number } | null>(null);
  const showItem = useCallback((id: number | null | undefined) => {
    if (id != null) setReveal({ id, n: Date.now() });
  }, []);
  const goView = useCallback((v: LibView) => {
    if (JSON.stringify(v) === JSON.stringify(viewRef.current)) return;
    const h = hist.current;
    h.back.push(viewRef.current);
    if (h.back.length > 100) h.back.shift();
    h.fwd = [];
    setLibView(v);
    setHistTick((t) => t + 1);
  }, []);
  const goBackRef = useRef<() => boolean>(() => false);
  const goForwardRef = useRef<() => boolean>(() => false);
  const goBack = useCallback(() => {
    const h = hist.current;
    const v = h.back.pop();
    if (!v) return false;
    h.fwd.push(viewRef.current);
    setLibView(v);
    setHistTick((t) => t + 1);
    return true;
  }, []);
  // The mouse's back / forward side buttons.
  const screenRef = useRef(screen);
  screenRef.current = screen;
  useEffect(() => {
    const down = (e: MouseEvent) => {
      if (e.button === 3 || e.button === 4) e.preventDefault();
    };
    const up = (e: MouseEvent) => {
      if (e.button !== 3 && e.button !== 4) return;
      e.preventDefault();
      if (screenRef.current.name !== 'library' || document.querySelector('[aria-modal="true"]')) return;
      if (e.button === 3) goBackRef.current();
      else goForwardRef.current();
    };
    window.addEventListener('mousedown', down);
    window.addEventListener('mouseup', up);
    return () => {
      window.removeEventListener('mousedown', down);
      window.removeEventListener('mouseup', up);
    };
  }, []);
  const goForward = useCallback(() => {
    const h = hist.current;
    const v = h.fwd.pop();
    if (!v) return false;
    h.back.push(viewRef.current);
    setLibView(v);
    setHistTick((t) => t + 1);
    return true;
  }, []);
  goBackRef.current = goBack;
  goForwardRef.current = goForward;

  const refresh = useCallback(async () => {
    const s = await api.getState();
    setApp(s);
    setPrefsConfig(s.config);
    applyAccent(s.config.accent);
    return s;
  }, []);

  useEffect(() => {
    runSelfTestIfRequested().catch(() => {});
    // The window is up: the built-in web engine (if used) works.
    api.engineStarted().catch(() => {});
    refresh()
      .then((s) => {
        if (s.session) setScreen(s.session.needsNewPassword ? { name: 'newPassword' } : { name: 'library' });
      })
      .catch((e) => setFatal(String(e)));
    const stopTracking = startActivityTracking();
    // Ctrl+S: save everything now (changes are also saved by themselves right away).
    const onSaveKey = (e: KeyboardEvent) => {
      if ((e.ctrlKey || e.metaKey) && !e.shiftKey && !e.altKey && e.key.toLowerCase() === 's') {
        e.preventDefault();
        api.saveNow().then(() => setToast('Everything is saved.'), (err) => setToast(String(err?.message ?? err)));
      }
    };
    window.addEventListener('keydown', onSaveKey);
    // If the library can't be saved, say so (changes are kept and retried).
    const offSave = onEvent<string>('save-failed', (m) => setToast(`${m} Your changes are kept and saving is retried; don't close the app yet.`));
    startExternalDrops();
    const unlisten = onLocked((reason) => {
      stopAllPlaying();
      clearUndo();
      if (document.fullscreenElement) document.exitFullscreen().catch(() => {});
      setScreen((cur) => (cur.name === 'player' ? cur : { name: 'start' }));
      setLibView({ kind: 'folders' });
      hist.current = { back: [], fwd: [] };
      clearViewMemory();
      setToast(LOCK_MESSAGES[reason] ?? 'Vault locked.');
      refresh().catch(() => {});
    });
    return () => {
      stopTracking();
      offSave.then((u) => u());
      window.removeEventListener('keydown', onSaveKey);
      unlisten.then((u) => u());
    };
  }, [refresh]);

  // Thumbnails are made in the background while a vault is open.
  const open = !!app?.session && !app.session.needsNewPassword && !app.session.name.startsWith('SelfTest');
  useEffect(() => (open ? startThumbnailer() : undefined), [open]);
  // Faces are found only in what the user asked to scan; pictures are analysed
  // for smart search whenever its models are there (full package).
  useEffect(() => (open ? startFaceScanner() : undefined), [open]);
  const smartIndex = open && app?.config.smartIndex !== false;
  useEffect(() => (smartIndex ? startClipIndexer() : undefined), [smartIndex]);
  // Small preview clips for smooth grids (can be turned off in Settings → Storage).
  const makePreviews = open && app?.config.makePreviews !== false;
  useEffect(() => (makePreviews ? startPreviewMaker() : undefined), [makePreviews]);
  // Picture fingerprints for finding look-alikes (tiny, made from the thumbnails).
  useEffect(() => (open ? startFingerprinter() : undefined), [open]);

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
      {screen.name === 'library' && app.session && (
        <Library nav={nav} view={libView} setView={goView}
          history={{ back: goBack, forward: goForward, canBack: hist.current.back.length > 0, canForward: hist.current.fwd.length > 0 }}
          reveal={reveal} />
      )}
      {screen.name === 'settings' && <Settings nav={nav} />}
      {screen.name === 'viewer' && (
        <Viewer nav={nav} items={screen.items} startKey={screen.startKey} title={screen.title} auto={screen.auto} order={screen.order}
          onBack={(last) => {
            setLibView(screen.back);
            showItem(last?.itemId);
            setScreen(app.session ? { name: 'library' } : { name: 'start' });
          }}
          onShowFolder={(it) => {
            goView({ kind: 'folder', id: it.folderId });
            showItem(it.itemId);
            setScreen({ name: 'library' });
          }} />
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
