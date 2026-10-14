import { useCallback, useEffect, useRef, useState } from 'react';
import { api, onEvent, onLocked, type AppState, type LockReason } from './api';
import { applyAccent } from './theme';
import { setPrefsConfig } from './prefs';
import { applyLook, setZoom, zoomKey } from './look';
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
import { Viewer, type TitleCard } from './screens/Viewer';
import { MiniFrame } from './components/MiniFrame';
import { TitleBar } from './components/TitleBar';
import { useLibraryTabs, useTabKeys } from './tabs/useTabs';
import type { Box } from './flip';
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
  | ViewerRoute
  | { name: 'multi'; back: LibView }
  | { name: 'player' };

export interface ViewerRoute {
  name: 'viewer';
  items: PlayItem[];
  startKey?: string;
  title: string;
  auto: boolean;
  back: LibView;
  order?: Order;
  /** The grid tile it was opened from (tileRect(id) from flip.ts): the picture grows from there. */
  fromRect?: Box | null;
  /** Pictures slowly pan and zoom (Memories). */
  kenBurns?: boolean;
  /** A big title shown for a moment before the first item. */
  titleCard?: TitleCard;
  /** Speed round: pictures and GIFs only, F to favourite, summary at the end. */
  speedRound?: boolean;
  /** The slideshow is about this person (folder id): "Line up faces" uses their face. */
  person?: number | null;
}

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
  /** The viewer shrunk into the mini player (it keeps playing over the library). */
  const [mini, setMini] = useState<ViewerRoute | null>(null);
  /** A new number for each viewer opened, so expanding the mini player keeps the same one. */
  const viewerIds = useRef(new WeakMap<ViewerRoute, number>());
  const nextViewerId = useRef(1);
  // Library tabs, each with its own back / forward through views, like a web browser.
  const tabs = useLibraryTabs(app?.session && !app.session.needsNewPassword ? app.session.path : null);
  const tabsRef = useRef(tabs);
  tabsRef.current = tabs;
  /** The tab the viewer (or multi-screen) was opened from: going back returns there. */
  const viewerTab = useRef<number | null>(null);
  /** An item to scroll to and highlight when the library shows again. */
  const [reveal, setReveal] = useState<{ id: number; n: number } | null>(null);
  const showItem = useCallback((id: number | null | undefined) => {
    if (id != null) setReveal({ id, n: Date.now() });
  }, []);
  const goView = tabs.navigate;
  const goBackRef = useRef<() => boolean>(() => false);
  const goForwardRef = useRef<() => boolean>(() => false);
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
  goBackRef.current = tabs.back;
  goForwardRef.current = tabs.forward;
  useTabKeys(tabs, screen.name === 'library' && tabs.ready);

  const lookConfig = useRef<AppState['config'] | null>(null);
  // Interface size: Ctrl+plus / Ctrl+minus, Ctrl+0 or Ctrl+* resets. Remembered.
  useEffect(() => {
    let t: ReturnType<typeof setTimeout> | null = null;
    const onKey = (e: KeyboardEvent) => {
      const z = zoomKey(e);
      if (z == null) return;
      e.preventDefault();
      setZoom(z);
      if (t) clearTimeout(t);
      t = setTimeout(() => {
        const c = lookConfig.current;
        if (c?.look) api.saveConfig({ ...c, look: { ...c.look, uiScale: z } }).then(() => refreshRef.current?.()).catch(() => {});
      }, 600);
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, []);
  const refreshRef = useRef<(() => Promise<unknown>) | null>(null);
  const refresh = useCallback(async () => {
    const s = await api.getState();
    setApp(s);
    setPrefsConfig(s.config);
    applyAccent(s.config.accent);
    applyLook(s.config.look);
    lookConfig.current = s.config;
    return s;
  }, []);

  refreshRef.current = refresh;
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
      setMini(null);
      tabsRef.current.reset();
      viewerTab.current = null;
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

  const go = (s: Screen) => {
    // Opening something else full screen replaces the mini player; the
    // library and settings keep it.
    if (s.name !== 'library' && s.name !== 'settings') setMini(null);
    if (s.name === 'viewer' || s.name === 'multi') viewerTab.current = tabs.activeId;
    setScreen(s);
  };
  const nav: Nav = { app, go, refresh };
  const viewerRoute: ViewerRoute | null = screen.name === 'viewer' ? screen : mini && app.session && (screen.name === 'library' || screen.name === 'settings') ? mini : null;
  let viewerId = 0;
  if (viewerRoute) {
    viewerId = viewerIds.current.get(viewerRoute) ?? 0;
    if (!viewerId) {
      viewerId = nextViewerId.current++;
      viewerIds.current.set(viewerRoute, viewerId);
    }
  }
  const isMini = !!viewerRoute && screen.name !== 'viewer';
  const expandMini = () => {
    if (!mini) return;
    setMini(null);
    setScreen(mini);
  };
  const withTabs = !!app.session && !app.session.needsNewPassword && tabs.ready
    && ['library', 'settings', 'viewer', 'multi'].includes(screen.name);
  return (
    <>
    <TitleBar tabs={withTabs ? tabs : null} onTab={() => {
      if (screen.name !== 'library') go({ name: 'library' });
    }} />
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
      {screen.name === 'library' && app.session && tabs.ready && (
        <Library nav={nav} view={tabs.view} setView={goView}
          history={{ back: tabs.back, forward: tabs.forward, canBack: tabs.canBack, canForward: tabs.canForward }}
          reveal={reveal} tabs={{ open: (v) => tabs.open(v), onFolders: tabs.onFolders }} />
      )}
      {screen.name === 'settings' && <Settings nav={nav} />}
      {viewerRoute && (
        <MiniFrame key={viewerId} mini={isMini} onExpand={expandMini}>
          <Viewer nav={nav} items={viewerRoute.items} startKey={viewerRoute.startKey} title={viewerRoute.title} auto={viewerRoute.auto} order={viewerRoute.order}
            fromRect={viewerRoute.fromRect} kenBurns={viewerRoute.kenBurns} titleCard={viewerRoute.titleCard} speedRound={viewerRoute.speedRound}
            person={viewerRoute.person}
            mini={isMini}
            onBack={(last) => {
              setMini(null);
              tabs.returnTo(viewerTab.current, viewerRoute.back);
              showItem(last?.itemId);
              setScreen(app.session ? { name: 'library' } : { name: 'start' });
            }}
            onShowFolder={(it) => {
              setMini(null);
              goView({ kind: 'folder', id: it.folderId });
              showItem(it.itemId);
              setScreen({ name: 'library' });
            }}
            onShowPerson={app.session ? (person) => {
              setMini(null);
              goView({ kind: 'search', tags: [], names: [], people: [person] });
              setScreen({ name: 'library' });
            } : undefined}
            onMinimize={app.session && !viewerRoute.speedRound ? () => {
              // Keep this viewer (same object, same component) and show the library under it.
              setMini(viewerRoute);
              tabs.returnTo(viewerTab.current, viewerRoute.back);
              setScreen({ name: 'library' });
            } : undefined}
            onExpand={expandMini}
            onCloseMini={() => setMini(null)} />
        </MiniFrame>
      )}
      {screen.name === 'multi' && app.session && (
        <MultiScreen nav={nav} vault onBack={() => { tabs.returnTo(viewerTab.current, screen.back); setScreen({ name: 'library' }); }} />
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
    </>
  );
}
