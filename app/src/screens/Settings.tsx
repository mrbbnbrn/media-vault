import { useEffect, useState } from 'react';
import { api, DEFAULT_LOOK, DEFAULT_VIEWER, onEvent, type AppConfig, type LookSettings, type ViewerSettings, type StorageDone, type StorageInfo, type StorageProgress } from '../api';
import type { Nav } from '../App';
import { Busy, ErrorBox, PasswordPair, TopBar, passwordsOk } from '../components/Chrome';
import { BackIcon, ExportIcon, ShieldIcon, WarnIcon } from '../components/Icons';
import { autoLocks, NO_PASSWORD_WARNING } from '../vaultpick';
import { DamageReportView, ExportDialog } from '../components/Safety';
import { UpscalerSection } from '../components/Upscale';
import { DepthSection } from '../components/Depth3D';
import { FaceSection } from '../components/FaceEngine';
import { PoorFaceSettingsView } from '../components/PoorFaceSettings';
import { smartAvailable } from '../ml/smart';
import { startCheck, useTasks } from '../tasks';
import type { DataInfo, CacheInfo, ClipStatus, EngineInfo, SmartEngine, StorageTask } from '../api';
import { ConfirmDialog } from '../components/Dialogs';
import { ACCENTS, applyAccent, formatBytes } from '../theme';
import { STYLES } from '../look';
import { GrowthSpark } from '../components/VaultGrowth';
import { setNotifyWhenDone } from '../jobs';
import { setFaceBoxes, useFaceBoxes } from '../prefs';

type Section = 'appearance' | 'viewer' | 'vault' | 'storage' | 'safety' | 'smart' | 'about';

export function Settings({ nav }: { nav: Nav }) {
  const [section, setSection] = useState<Section>('appearance');
  const [cfg, setCfg] = useState<AppConfig>(nav.app.config);
  const [error, setError] = useState<string | null>(null);
  const faceBoxesOn = useFaceBoxes();

  async function update(next: AppConfig) {
    setCfg(next);
    applyAccent(next.accent);
    try {
      setCfg(await api.saveConfig(next));
      await nav.refresh();
    } catch (e) {
      setError((e as Error).message);
    }
  }
  const look = { ...DEFAULT_LOOK, ...(cfg.look ?? {}) };
  const setLook = (patch: Partial<LookSettings>) => update({ ...cfg, look: { ...look, ...patch } });
  const setLock = (patch: Partial<AppConfig['lock']>) => update({ ...cfg, lock: { ...cfg.lock, ...patch } });
  const viewer = { ...DEFAULT_VIEWER, ...(cfg.viewer ?? {}) };
  const setViewer = (patch: Partial<ViewerSettings>) => update({ ...cfg, viewer: { ...viewer, ...patch } });

  const sections: [Section, string][] = [
    ['appearance', 'Appearance & locking'],
    ['viewer', 'Viewer & videos'],
    ['vault', 'Vault & password'],
    ['storage', 'Storage & backups'],
    ['safety', 'Safety & export'],
    ['smart', 'Faces & smart search'],
    ['about', 'About'],
  ];
  const custom = !ACCENTS.some((a) => a.hex === cfg.accent);

  return (
    <>
      <TopBar title="Settings">
        <button type="button" className="btn btn-sm" onClick={() => nav.go({ name: 'library' })}>
          <BackIcon /> Back to library
        </button>
      </TopBar>
      <div className="settings">
        <nav aria-label="Settings sections">
          {sections.map(([id, label]) => (
            <button key={id} type="button" className={section === id ? 'active' : ''} onClick={() => setSection(id)}>
              {label}
            </button>
          ))}
        </nav>
        <main>
          <ErrorBox error={error} />
          {section === 'appearance' && (
            <>
              <section className="section">
                <h2>Accent colour</h2>
                <p className="muted" style={{ margin: 0 }}>Used for buttons, selections and highlights. The rest of the app always stays dark.</p>
                <div className="swatches" role="radiogroup" aria-label="Accent colour">
                  {ACCENTS.map((a) => (
                    <button key={a.hex} type="button" role="radio" aria-checked={cfg.accent === a.hex}
                      className={`swatch${cfg.accent === a.hex ? ' checked' : ''}`} onClick={() => update({ ...cfg, accent: a.hex })}>
                      <span className="dot" style={{ background: a.hex }} />
                      {a.name}
                    </button>
                  ))}
                  <label className={`swatch${custom ? ' checked' : ''}`}>
                    <span className="dot" style={{ background: custom ? cfg.accent : 'conic-gradient(#2ec4b6, #5b9cf0, #a78bfa, #f07a8c, #e8a54b, #9ccc54, #2ec4b6)' }} />
                    Custom…
                    <input type="color" value={cfg.accent} aria-label="Custom accent colour"
                      onChange={(e) => update({ ...cfg, accent: e.target.value.toLowerCase() })} />
                  </label>
                </div>
              </section>

              <div className="divider" />

              <section className="section">
                <h2>Look</h2>
                <div className="setting">
                  <div className="text">
                    <label className="title" htmlFor="style">Background</label>
                    <span className="desc">Always dark; choose how dark and which tint.</span>
                  </div>
                  <select id="style" className="input" value={look.style} onChange={(e) => setLook({ style: e.target.value as LookSettings['style'] })}>
                    {STYLES.map((x) => <option key={x.id} value={x.id}>{x.label}</option>)}
                  </select>
                </div>
                <div className="setting">
                  <div className="text">
                    <label className="title" htmlFor="uiscale">Interface size · {Math.round(look.uiScale * 100)}%</label>
                    <span className="desc">Also Ctrl + plus and Ctrl + minus anywhere; Ctrl + 0 or Ctrl + * resets it.</span>
                  </div>
                  <input id="uiscale" type="range" min={0.5} max={2} step={0.05} value={look.uiScale} onChange={(e) => setLook({ uiScale: Number(e.target.value) })} />
                </div>
                <div className="setting">
                  <div className="text">
                    <label className="title" htmlFor="tgap">Space between tiles · {look.tileGap}px</label>
                  </div>
                  <input id="tgap" type="range" min={0} max={30} step={1} value={look.tileGap} onChange={(e) => setLook({ tileGap: Number(e.target.value) })} />
                </div>
                <div className="setting">
                  <div className="text">
                    <label className="title" htmlFor="trad">Tile corners · {look.tileRadius === 0 ? 'square' : `${look.tileRadius}px round`}</label>
                  </div>
                  <input id="trad" type="range" min={0} max={20} step={1} value={look.tileRadius} onChange={(e) => setLook({ tileRadius: Number(e.target.value) })} />
                </div>
                <Toggle title="Show name, size and length on the tile under the mouse" desc="Shown along the bottom of the tile; the badges move out of its way."
                  on={look.hoverInfo} set={(v) => setLook({ hoverInfo: v })} />
                <Toggle title="Crop square tiles around faces" desc="Uses face recognition: tiles keep faces in view instead of the middle of the picture."
                  on={look.faceCrop} set={(v) => setLook({ faceCrop: v })} />
                <Toggle title="Scroll preview beside the scrollbar" desc="In long folders, a wider strip next to the scrollbar: point at it to see small pictures from that spot, click or drag on it to jump there."
                  on={look.minimap !== false} set={(v) => setLook({ minimap: v })} />
                <Toggle title="Fan out folder cards on hover" desc="Folders with several pictures spread their back cards out to the sides while you point at them."
                  on={!!look.fanCards} set={(v) => setLook({ fanCards: v })} />
                <Toggle title="Compact sidebar" desc="Only icons and folder pictures; names show when you point at them. The button at the top of the sidebar switches it too."
                  on={look.sidebarRail} set={(v) => setLook({ sidebarRail: v })} />
                <div className="setting">
                  <div className="text">
                    <span className="title">Top bar buttons</span>
                    <span className="desc">Right-click the top bar in the library and choose “Customise top bar” to hide buttons or change their order.</span>
                  </div>
                  <button type="button" className="btn btn-sm" disabled={!look.topBar.length} onClick={() => setLook({ topBar: [] })}>Reset top bar</button>
                </div>
              </section>

              <div className="divider" />

              <section className="section">
                <h2>Auto-lock</h2>
                {nav.app.session && !autoLocks(nav.app.session) && (
                  <div className="info" role="note">
                    This vault has no password, so it never locks by itself; these settings apply to vaults with a password.
                    You can still lock it by hand with the Lock button or Ctrl + Shift + L.
                  </div>
                )}
                <div className="setting">
                  <div className="text">
                    <label className="title" htmlFor="idle">Lock when I’m idle for</label>
                    <span className="desc">
                      Idle means no mouse or keyboard use <b style={{ color: '#d6d4cf', fontWeight: 500 }}>and</b> nothing playing.
                      A running slideshow, video or multi-screen never counts as idle.
                    </span>
                  </div>
                  <select id="idle" className="input" value={cfg.lock.idleMinutes}
                    onChange={(e) => setLock({ idleMinutes: Number(e.target.value) })}>
                    <option value={0}>Never</option>
                    <option value={5}>5 minutes</option>
                    <option value={15}>15 minutes</option>
                    <option value={30}>30 minutes</option>
                    <option value={60}>1 hour</option>
                  </select>
                </div>
                <Toggle title="Lock when Windows locks or the PC sleeps" desc="Recommended. Happens even during a slideshow."
                  on={cfg.lock.onSystemLock} set={(v) => setLock({ onSystemLock: v })} />
                <Toggle title="Lock when the app is minimised" desc="Off by default, so minimising a playing video is fine."
                  on={cfg.lock.onMinimize} set={(v) => setLock({ onMinimize: v })} />
                <Toggle title="Lock after 1 hour without input, even while playing" desc="A safety net in case you fall asleep watching."
                  on={cfg.lock.safetyNetMinutes > 0} set={(v) => setLock({ safetyNetMinutes: v ? 60 : 0 })} />
                <div className="setting">
                  <div className="text">
                    <span className="title">Panic key</span>
                    <span className="desc">Locks instantly and minimises the window, even mid-video. Works while the app is in the background.</span>
                  </div>
                  <span className="kbd">Ctrl + Shift + L</span>
                </div>
              </section>

              <div className="divider" />

              <section className="section">
                <h2>Clean full screen</h2>
                <Toggle title="Show controls while the mouse moves" desc="They fade away again after a moment. When off, only the keyboard controls playback."
                  on={cfg.fullscreenControlsOnMouse} set={(v) => update({ ...cfg, fullscreenControlsOnMouse: v })} />
              </section>
            </>
          )}
          {section === 'viewer' && (
            <>
              <section className="section">
                <h2>Picture scaling</h2>
                <p className="muted" style={{ margin: 0 }}>The same three choices are in the viewer's “View” menu.</p>
                <Toggle title="Smooth when shrinking to fit" desc="High-quality resampling for pictures bigger than the window. Off shows hard pixels."
                  on={viewer.smoothFit} set={(v) => setViewer({ smoothFit: v })} />
                <Toggle title="Smooth when zoomed in" desc="Off keeps every pixel a crisp square when you zoom in, which suits pixel art. Press P in the viewer to switch."
                  on={viewer.smoothZoom} set={(v) => setViewer({ smoothZoom: v })} />
                <Toggle title="Sharpen after smoothing" desc="A light sharpening pass on smoothed pictures."
                  on={viewer.sharpen} set={(v) => setViewer({ sharpen: v })} />
              </section>

              <div className="divider" />

              <section className="section">
                <h2>Around the picture</h2>
                <Toggle title="Soft colour glow behind pictures" desc="Instead of plain black, a blurred, darkened copy of the picture fills the space around it."
                  on={viewer.ambient} set={(v) => setViewer({ ambient: v })} />
                <Toggle title="Show boxes around faces" desc="Found faces get a box with the person's name. Click a box to see everything of that person, or to say who it is. The face button in the viewer switches this too. Starts off each time the app opens."
                  on={faceBoxesOn} set={setFaceBoxes} />
                <Toggle title="Open and close animation" desc="Pictures grow out of their tile when you open them and shrink back into it when you close the viewer. Off opens and closes instantly."
                  on={viewer.openCloseAnim !== false} set={(v) => setViewer({ openCloseAnim: v })} />
              </section>

              <div className="divider" />

              <section className="section">
                <h2>Arrow keys in videos</h2>
                <div className="setting">
                  <div className="text">
                    <label className="title" htmlFor="seek-small">← and → jump</label>
                    <span className="desc">On pictures the arrow keys still go to the previous and next item.</span>
                  </div>
                  <span className="row"><input id="seek-small" className="input small" type="number" min={1} max={600} value={viewer.seekSeconds}
                    onChange={(e) => setViewer({ seekSeconds: Math.max(1, Math.min(600, Number(e.target.value) || 5)) })} /> seconds</span>
                </div>
                <div className="setting">
                  <div className="text">
                    <label className="title" htmlFor="seek-big">Shift + ← and → jump</label>
                    <span className="desc">Ctrl + ← and → step one frame (and pause). Ctrl + Space and Shift + Space go to the next and previous item.</span>
                  </div>
                  <span className="row"><input id="seek-big" className="input small" type="number" min={1} max={3600} value={viewer.seekBigSeconds}
                    onChange={(e) => setViewer({ seekBigSeconds: Math.max(1, Math.min(3600, Number(e.target.value) || 30)) })} /> seconds</span>
                </div>
              </section>
            </>
          )}
          {section === 'vault' && <VaultSection nav={nav} />}
          {section === 'storage' && <StorageSection cfg={cfg} update={update} />}
          {section === 'safety' && <SafetySection cfg={cfg} update={update} />}
          {section === 'smart' && <SmartSection viewer={viewer} setViewer={setViewer} poor={<PoorFaceSettingsView value={cfg.poorFaces} onChange={(poorFaces) => update({ ...cfg, poorFaces })} />} />}
          {section === 'about' && (
            <section className="section">
              <h2>Media Vault 0.1.0</h2>
              <p className="muted" style={{ margin: 0, lineHeight: 1.6 }}>
                Works fully offline. Vaults use AES-256-GCM encryption with an Argon2id-protected password. Each vault folder
                contains FORMAT.md, a plain description of how it’s stored, and the app folder includes vault-export.exe,
                which can decrypt a vault back into normal files without this app.
              </p>
            </section>
          )}
        </main>
      </div>
    </>
  );
}

function Toggle({ title, desc, on, set }: { title: string; desc: string; on: boolean; set: (v: boolean) => void }) {
  return (
    <div className="setting">
      <div className="text">
        <span className="title">{title}</span>
        <span className="desc">{desc}</span>
      </div>
      <button type="button" role="switch" aria-checked={on} aria-label={title} className="toggle" onClick={() => set(!on)} />
    </div>
  );
}

function VaultSection({ nav }: { nav: Nav }) {
  const min = nav.app.minPasswordChars;
  const [current, setCurrent] = useState('');
  const [password, setPassword] = useState('');
  const [confirm, setConfirm] = useState('');
  const [busy, setBusy] = useState<'pw' | 'rk' | 'off' | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [done, setDone] = useState(false);
  const [rkCurrent, setRkCurrent] = useState('');
  const [rkError, setRkError] = useState<string | null>(null);
  const hasPassword = nav.app.session?.hasPassword !== false;
  const [offCurrent, setOffCurrent] = useState('');
  const [offError, setOffError] = useState<string | null>(null);
  const [confirmOff, setConfirmOff] = useState(false);
  const [switched, setSwitched] = useState<'off' | 'on' | null>(null);

  async function turnOff() {
    setOffError(null);
    setBusy('off');
    try {
      await api.turnPasswordOff(offCurrent);
      setOffCurrent('');
      setCurrent('');
      setRkCurrent('');
      await nav.refresh();
      setSwitched('off');
    } finally {
      setBusy(null);
    }
  }

  async function setOne(e: React.FormEvent) {
    e.preventDefault();
    setBusy('pw');
    setError(null);
    try {
      await api.setPassword(password);
      setPassword('');
      setConfirm('');
      await nav.refresh();
      setSwitched('on');
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setBusy(null);
    }
  }

  async function change(e: React.FormEvent) {
    e.preventDefault();
    setBusy('pw');
    setError(null);
    setDone(false);
    try {
      await api.changePassword(current, password);
      setCurrent('');
      setPassword('');
      setConfirm('');
      setDone(true);
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setBusy(null);
    }
  }

  async function newRecovery(e: React.FormEvent) {
    e.preventDefault();
    setBusy('rk');
    setRkError(null);
    try {
      const words = await api.resetRecovery(rkCurrent);
      setRkCurrent('');
      nav.go({ name: 'words', words, context: 'reset' });
    } catch (err) {
      setRkError((err as Error).message);
      setBusy(null);
    }
  }

  const recoveryForm = (
    <form className="section" onSubmit={newRecovery} style={{ maxWidth: 520 }}>
      <h2>New recovery key</h2>
      <p className="muted" style={{ margin: 0, lineHeight: 1.6 }}>
        Makes 24 new words and turns the old ones off. Use this if your paper copy was lost or someone may have seen it.
      </p>
      {hasPassword && (
        <div className="field">
          <label htmlFor="rkcur">Current password</label>
          <input id="rkcur" className="input" type="password" autoComplete="current-password" value={rkCurrent} onChange={(e) => setRkCurrent(e.target.value)} />
        </div>
      )}
      <ErrorBox error={rkError} />
      <div>
        <button type="submit" className="btn" disabled={!!busy || (hasPassword && !rkCurrent)}>
          {busy === 'rk' ? <Busy label="Making new key…" /> : 'Make a new recovery key'}
        </button>
      </div>
    </form>
  );

  if (!hasPassword) {
    return (
      <>
        <form className="section" onSubmit={setOne} style={{ maxWidth: 520 }}>
          <h2>Set a password</h2>
          {switched === 'off' && <div className="info" role="status">The password is off. This vault now opens without asking.</div>}
          <div className="notice" role="note">
            <WarnIcon />
            <span>This vault has no password. {NO_PASSWORD_WARNING}</span>
          </div>
          <p className="muted" style={{ margin: 0, lineHeight: 1.6 }}>
            With a password, the vault asks for it every time it opens and locks by itself again. Instant: your files
            aren’t re-encrypted. Your recovery words keep working.
          </p>
          <PasswordPair password={password} confirm={confirm} onPassword={setPassword} onConfirm={setConfirm} min={min} label="New password" />
          <ErrorBox error={error} />
          <div>
            <button type="submit" className="btn btn-primary" disabled={!!busy || !passwordsOk(password, confirm, min)}>
              {busy === 'pw' ? <Busy label="Setting…" /> : 'Set a password'}
            </button>
          </div>
        </form>

        <div className="divider" />

        {recoveryForm}
      </>
    );
  }

  return (
    <>
      <form className="section" onSubmit={change} style={{ maxWidth: 520 }}>
        <h2>Change password</h2>
        <p className="muted" style={{ margin: 0 }}>Instant: your files aren’t re-encrypted. Your recovery words keep working.</p>
        <div className="field">
          <label htmlFor="cur">Current password</label>
          <input id="cur" className="input" type="password" autoComplete="current-password" value={current} onChange={(e) => setCurrent(e.target.value)} />
        </div>
        <PasswordPair password={password} confirm={confirm} onPassword={setPassword} onConfirm={setConfirm} min={min} label="New password" />
        <ErrorBox error={error} />
        {done && <div className="info" role="status">Password changed.</div>}
        {switched === 'on' && <div className="info" role="status">Password set. This vault now asks for it when it opens.</div>}
        <div>
          <button type="submit" className="btn btn-primary" disabled={!!busy || !current || !passwordsOk(password, confirm, min)}>
            {busy === 'pw' ? <Busy label="Changing…" /> : 'Change password'}
          </button>
        </div>
      </form>

      <div className="divider" />

      {recoveryForm}

      <div className="divider" />

      <form className="section" style={{ maxWidth: 520 }} onSubmit={(e) => { e.preventDefault(); setOffError(null); setConfirmOff(true); }}>
        <h2>Turn the password off</h2>
        <p className="muted" style={{ margin: 0, lineHeight: 1.6 }}>
          The vault then opens without asking and never locks by itself. {NO_PASSWORD_WARNING} Your files aren’t
          re-encrypted, and your recovery words keep working. You can set a password again any time.
        </p>
        <div className="field">
          <label htmlFor="offcur">Current password</label>
          <input id="offcur" className="input" type="password" autoComplete="current-password" value={offCurrent} onChange={(e) => setOffCurrent(e.target.value)} />
        </div>
        <ErrorBox error={offError} />
        <div>
          <button type="submit" className="btn" disabled={!!busy || !offCurrent}>
            {busy === 'off' ? <Busy label="Turning off…" /> : 'Turn the password off…'}
          </button>
        </div>
      </form>
      {confirmOff && (
        <ConfirmDialog title="Turn the password off?" confirm="Turn it off" danger
          onConfirm={async () => {
            try {
              await turnOff();
            } catch (err) {
              setOffError((err as Error).message);
            }
          }}
          onClose={() => setConfirmOff(false)}>
          {NO_PASSWORD_WARNING} Copies and backups of the folder too. The vault won’t ask for anything when it opens.
        </ConfirmDialog>
      )}
    </>
  );
}

function StorageSection({ cfg, update }: { cfg: AppConfig; update: (c: AppConfig) => Promise<void> }) {
  const [info, setInfo] = useState<StorageInfo | null>(null);
  const [cache, setCache] = useState<CacheInfo | null>(null);
  const [confirm, setConfirm] = useState<'deleteThumbs' | 'deletePreviews' | null>(null);
  const [data, setData] = useState<DataInfo | null>(null);
  const [dataConfirm, setDataConfirm] = useState<'faces' | 'clip' | 'backups' | null>(null);
  const [dataMsg, setDataMsg] = useState<string | null>(null);
  const loadData = () => api.dataInfo().then(setData).catch(() => {});
  const [job, setJob] = useState<StorageProgress | null>(null);
  const [done, setDone] = useState<StorageDone | null>(null);
  const [err, setErr] = useState<string | null>(null);
  useEffect(() => {
    api.storageInfo().then(setInfo).catch((e) => setErr(String(e)));
    api.cacheInfo().then(setCache).catch(() => {});
    loadData();
    const a = onEvent<StorageProgress>('storage-progress', setJob);
    const b = onEvent<StorageDone>('storage-done', (d) => {
      setJob(null);
      setDone(d);
      api.storageInfo().then(setInfo).catch(() => {});
      api.cacheInfo().then(setCache).catch(() => {});
    });
    return () => {
      a.then((u) => u());
      b.then((u) => u());
    };
  }, []);
  const run = async (task: StorageTask) => {
    setDone(null);
    setErr(null);
    setJob({ task, done: 0, total: 0 });
    try {
      await api.storageTask(task);
    } catch (e) {
      setJob(null);
      setErr(String(e));
    }
  };
  return (
    <section className="section">
      <h2>Storage</h2>
      <p className="muted" style={{ margin: 0, lineHeight: 1.6 }}>
        Items and thumbnails are packed into a few large files (about 1 GB each), so backups and cloud services with
        file-count limits have little to handle. To back up, copy the whole vault folder; it stays encrypted.
      </p>
      <ErrorBox error={err} />
      {info && (
        <div className="stats" style={{ flexWrap: 'wrap' }}>
          <div className="stat"><span className="faint" style={{ fontSize: 12 }}>Files in the vault folder</span><b>{info.files.toLocaleString()}</b></div>
          <div className="stat"><span className="faint" style={{ fontSize: 12 }}>Size</span><b>{formatBytes(info.totalBytes)}</b></div>
          <div className="stat"><span className="faint" style={{ fontSize: 12 }}>Pack files</span><b>{info.packFiles}</b></div>
          <div className="stat"><span className="faint" style={{ fontSize: 12 }}>Space from deleted items</span><b>{info.reclaimableBytes ? formatBytes(info.reclaimableBytes) : 'none'}</b></div>
        </div>
      )}
      <GrowthSpark />
      {info && info.looseObjects > 0 && (
        <div className="setting">
          <div className="text">
            <span className="title">Pack {info.looseObjects.toLocaleString()} separate files</span>
            <span className="desc">This vault was made by the first version, which kept every item in its own file. Packing copies them into pack files, checks every copy, and only then removes the separate files. Safe to interrupt.</span>
          </div>
          <button type="button" className="btn btn-primary" disabled={!!job} onClick={() => run('convert')}>Pack now</button>
        </div>
      )}
      <div className="setting">
        <div className="text">
          <span className="title">Reclaim space</span>
          <span className="desc">Deleted items leave unused space inside packs. This copies what's still used into fresh packs and removes the old ones. Nothing is removed until the new copies are saved.</span>
        </div>
        <button type="button" className="btn" disabled={!!job || !info?.reclaimableBytes} onClick={() => run('reclaim')}>Reclaim</button>
      </div>
      <h2 style={{ marginTop: 18 }}>Thumbnails and preview clips</h2>
      <p className="muted" style={{ margin: 0, lineHeight: 1.6 }}>
        Made by the app from your files and kept encrypted in the vault. Deleting them never touches your files.
      </p>
      {cache && (
        <div className="stats" style={{ flexWrap: 'wrap' }}>
          <div className="stat"><span className="faint" style={{ fontSize: 12 }}>Thumbnails</span><b>{cache.thumbs.toLocaleString()} · {formatBytes(cache.thumbBytes)}</b>
            {!!cache.pages && <span className="faint" style={{ fontSize: 11 }} title="Each folder's thumbnails packed into a few pages, so grids open faster. Made again by themselves.">+ {cache.pages.toLocaleString()} pages · {formatBytes(cache.pageBytes ?? 0)}</span>}</div>
          <div className="stat"><span className="faint" style={{ fontSize: 12 }}>Preview clips</span><b>{cache.previews.toLocaleString()} · {formatBytes(cache.previewBytes)}</b></div>
        </div>
      )}
      <Toggle title="Make preview clips" on={cfg.makePreviews !== false} set={(v) => update({ ...cfg, makePreviews: v })}
        desc="A few seconds of small, silent video and a strip of little frames for each video, made once in the background. Grid tiles play them straight away and switch to the real video when your PC keeps up." />
      <div className="setting">
        <div className="text">
          <span className="title">Delete preview clips</span>
          <span className="desc">{cfg.makePreviews !== false ? 'They are made again in the background. Turn off “Make preview clips” first to keep the space free.' : 'Frees the space they use.'}</span>
        </div>
        <button type="button" className="btn" disabled={!!job || !cache?.previews} onClick={() => setConfirm('deletePreviews')}>Delete</button>
      </div>
      <div className="setting">
        <div className="text">
          <span className="title">Delete thumbnails</span>
          <span className="desc">The library needs them to show your items, so they are made again in the background while the vault is open.</span>
        </div>
        <button type="button" className="btn" disabled={!!job || !cache?.thumbs} onClick={() => setConfirm('deleteThumbs')}>Delete</button>
      </div>
      <h2 style={{ marginTop: 18 }}>Other data the app made</h2>
      <p className="muted" style={{ margin: 0, lineHeight: 1.6 }}>
        Kept encrypted inside the vault. Deleting any of it never touches your files, folders or person folders.
      </p>
      {data && (
        <div className="stats" style={{ flexWrap: 'wrap' }}>
          <div className="stat"><span className="faint" style={{ fontSize: 12 }}>Face recognition</span><b>{data.faces.toLocaleString()} faces · {formatBytes(data.faceBytes)}</b></div>
          <div className="stat"><span className="faint" style={{ fontSize: 12 }}>Smart search</span><b>{data.clipItems.toLocaleString()} items · {formatBytes(data.clipBytes)}</b></div>
          <div className="stat"><span className="faint" style={{ fontSize: 12 }}>Library backups</span><b>{data.backups} of 5 · {formatBytes(data.backupBytes)}</b></div>
          <div className="stat"><span className="faint" style={{ fontSize: 12 }}>Library</span><b>{formatBytes(data.libraryBytes)}</b></div>
        </div>
      )}
      <div className="setting">
        <div className="text">
          <span className="title">Delete face recognition data</span>
          <span className="desc">Removes every face found and every “yes, that's them / not them” answer. Person folders and the pictures in them stay. Scan again to find faces.</span>
        </div>
        <button type="button" className="btn" disabled={!data?.faces} onClick={() => setDataConfirm('faces')}>Delete</button>
      </div>
      <Toggle title="Analyse pictures for smart search" on={cfg.smartIndex !== false} set={(v) => update({ ...cfg, smartIndex: v })}
        desc="Done in the background when the smart-search models are installed. Turn off first if you delete the data and want it to stay deleted." />
      <div className="setting">
        <div className="text">
          <span className="title">Delete smart-search data</span>
          <span className="desc">{cfg.smartIndex !== false ? 'It is made again in the background while analysing is on.' : 'Smart search finds nothing until pictures are analysed again.'}</span>
        </div>
        <button type="button" className="btn" disabled={!data?.clipItems} onClick={() => setDataConfirm('clip')}>Delete</button>
      </div>
      <div className="setting">
        <div className="text">
          <span className="title">Delete library backups</span>
          <span className="desc">The vault keeps up to 5 earlier copies of the library (your folders, tags, people… not your files), at most one every 10 minutes, in case the main copy gets damaged. A new one is made with the next change.</span>
        </div>
        <button type="button" className="btn" disabled={!data?.backups} onClick={() => setDataConfirm('backups')}>Delete</button>
      </div>
      {dataMsg && <div className="info">{dataMsg}</div>}
      {dataConfirm && (
        <ConfirmDialog danger confirm="Delete" onClose={() => setDataConfirm(null)}
          title={dataConfirm === 'faces' ? 'Delete face recognition data?' : dataConfirm === 'clip' ? 'Delete smart-search data?' : 'Delete the library backups?'}
          onConfirm={async () => {
            setDataMsg(await api.deleteData(dataConfirm));
            await loadData();
          }}>
          {dataConfirm === 'faces' && `${data?.faces.toLocaleString()} faces (${formatBytes(data?.faceBytes ?? 0)}) and your answers about them are deleted. This can't be undone, but scanning again finds the faces again.`}
          {dataConfirm === 'clip' && `The analysis of ${data?.clipItems.toLocaleString()} items (${formatBytes(data?.clipBytes ?? 0)}) is deleted.`}
          {dataConfirm === 'backups' && `${data?.backups} earlier copies of the library (${formatBytes(data?.backupBytes ?? 0)}) are deleted. Your current library is not affected.`}
        </ConfirmDialog>
      )}
      {confirm && (
        <ConfirmDialog title={confirm === 'deleteThumbs' ? 'Delete all thumbnails?' : 'Delete all preview clips?'} confirm="Delete" danger
          onClose={() => setConfirm(null)} onConfirm={() => run(confirm)}>
          {confirm === 'deleteThumbs'
            ? `${cache?.thumbs.toLocaleString()} thumbnails (${formatBytes(cache?.thumbBytes ?? 0)}) are deleted and the space is given back. Your files are not touched.`
            : `${cache?.previews.toLocaleString()} preview clips (${formatBytes(cache?.previewBytes ?? 0)}) are deleted and the space is given back. Your files are not touched.`}
        </ConfirmDialog>
      )}
      {job && (
        <div className="info">
          {job.task === 'convert' ? 'Packing' : job.task === 'reclaim' ? 'Reclaiming space' : 'Deleting and freeing space'}… {job.total ? `${job.done.toLocaleString()} / ${job.total.toLocaleString()}` : ''}
        </div>
      )}
      {done && <div className={done.ok ? 'info' : 'error'}>{done.message}</div>}
    </section>
  );
}

function SafetySection({ cfg, update }: { cfg: AppConfig; update: (c: AppConfig) => Promise<void> }) {
  const t = useTasks();
  const [exporting, setExporting] = useState(false);
  const [engine, setEngine] = useState<EngineInfo | null>(null);
  const [retried, setRetried] = useState(false);
  useEffect(() => {
    api.engineInfo().then(setEngine).catch(() => {});
  }, []);
  return (
    <>
      <section className="section">
        <h2>Privacy</h2>
        <Toggle title="Hide this window from screenshots and screen sharing"
          desc="Screenshots, screen recordings and screen sharing (Discord, Zoom…) show a black window instead. Turn off when you want to share your screen."
          on={cfg.blockCapture !== false} set={(v) => update({ ...cfg, blockCapture: v })} />
        <Toggle title="Remove camera info, location and dates from files I export or share"
          desc="For exports, encrypted .7z files and dragging or copying to Explorer. Cleans JPEG, PNG, WebP and GIF pictures and MP4/MOV videos (turned pictures stay the right way up); other files go out as they are. Your files in the vault are never changed."
          on={!!cfg.stripMetadata} set={(v) => update({ ...cfg, stripMetadata: v })} />
        <Toggle title="Notify me when long jobs finish"
          desc="A Windows notification when an import, export or scan that took a while finishes while you're in another app. It only gives counts, never names."
          on={cfg.notifyDone !== false} set={(v) => { setNotifyWhenDone(v); update({ ...cfg, notifyDone: v }); }} />
      </section>

      <div className="divider" />

      <section className="section">
        <h2>Check for damage</h2>
        <p className="muted" style={{ margin: 0, lineHeight: 1.6 }}>
          Reads every item, thumbnail and library backup in full and checks it against its encryption seal, so even a single
          changed byte on the disk is found. Takes a while for big vaults; you can keep using the app.
        </p>
        <div>
          <button type="button" className="btn btn-primary" disabled={!!t.check} onClick={() => startCheck()}>
            <ShieldIcon /> {t.check ? `Checking… ${t.check.total ? `${t.check.done.toLocaleString()} / ${t.check.total.toLocaleString()}` : ''}` : 'Check now'}
          </button>
          {t.check && <button type="button" className="btn" style={{ marginLeft: 8 }} onClick={() => api.cancelTask('check')}>Stop</button>}
        </div>
        {t.checkResult && 'report' in t.checkResult && <DamageReportView report={t.checkResult.report} />}
        {t.checkResult && 'error' in t.checkResult && <div className="error">{t.checkResult.error}</div>}
      </section>

      <div className="divider" />

      <section className="section">
        <h2>Export decrypted</h2>
        <p className="muted" style={{ margin: 0, lineHeight: 1.6 }}>
          Write everything back out as ordinary files, with the original names and folders. You can also export a single
          folder or a selection from its menu in the library.
        </p>
        <div>
          <button type="button" className="btn" disabled={!!t.exporting || t.exportStarting} onClick={() => setExporting(true)}>
            <ExportIcon /> Export everything…
          </button>
        </div>
        {exporting && <ExportDialog request={{ all: true }} what="everything" onClose={() => setExporting(false)} />}
        {t.exporting && <div className="info">Exporting… {t.exporting.done.toLocaleString()} / {t.exporting.total.toLocaleString()}</div>}
        {t.exportDone && (
          <div className={t.exportDone.error ? 'error' : 'info'}>
            {t.exportDone.error ?? `${t.exportDone.exported.toLocaleString()} files written to ${t.exportDone.folder}${t.exportDone.cancelled ? ' (stopped early)' : ''}.`}
          </div>
        )}
      </section>

      <div className="divider" />

      <section className="section">
        <h2>Web engine</h2>
        <p className="muted" style={{ margin: 0, lineHeight: 1.6 }}>
          The app draws its window and plays videos with Microsoft's WebView2 engine. The full package brings its own copy,
          so Windows updates can't change how things play.
        </p>
        {engine && (
          <div className="info">
            {engine.mode === 'builtin' && <>Using the built-in engine{engine.version ? ` (version ${engine.version})` : ''}.</>}
            {engine.mode === 'system' && (engine.available ? 'Using the engine that comes with Windows (the built-in one is turned off).' : "Using the engine that comes with Windows. This copy of the app doesn't include its own.")}
            {engine.mode === 'fallback' && <>The built-in engine didn't start last time, so the one that comes with Windows is used.</>}
          </div>
        )}
        {engine?.available && (
          <Toggle title="Use the built-in engine" desc="Takes effect the next time the app starts." on={cfg.builtinEngine !== false}
            set={(v) => update({ ...cfg, builtinEngine: v })} />
        )}
        {engine?.mode === 'fallback' && (
          <div>
            <button type="button" className="btn btn-sm" disabled={retried} onClick={() => { api.engineRetry(); setRetried(true); }}>
              {retried ? 'It will be tried at the next start' : 'Try the built-in engine again next time'}
            </button>
          </div>
        )}
      </section>
    </>
  );
}

function SmartSection(props: { poor?: React.ReactNode; viewer: ViewerSettings; setViewer: (patch: Partial<ViewerSettings>) => void }) {
  const [clip, setClip] = useState<ClipStatus | null>(null);
  const [models, setModels] = useState<boolean | null>(null);
  const [engine, setEngine] = useState<SmartEngine | null>(null);
  useEffect(() => {
    api.clipStatus().then(setClip).catch(() => {});
    smartAvailable().then(setModels);
    api.smartEngine().then(setEngine).catch(() => {});
  }, []);
  // Pictures are analysed by the app itself (graphics card or processor), else slowly in the window.
  const runsOn = !engine ? null : engine.native ? (engine.device === 'gpu' ? 'graphics card' : 'processor') : 'browser engine (slow)';
  return (
    <>
      <FaceSection />

      {props.poor && <><div className="divider" />{props.poor}</>}

      <div className="divider" />

      <section className="section">
        <h2>Smart search</h2>
        <p className="muted" style={{ margin: 0, lineHeight: 1.6 }}>
          Turn it on with the ✦ button next to the search box, then describe what you're looking for — “dog on the beach”,
          “kırmızı elbise”, “Geburtstagstorte”. Works in 50+ languages, fully offline. Pictures and videos are analysed in the
          background (using their thumbnails); the results stay inside the encrypted vault.
        </p>
        {models === false && <div className="notice">This copy of the app doesn't include the smart-search models. Use the full package (it has a “models” folder next to MediaVault.exe).</div>}
        {models && engine && !engine.native && (
          <div className="info">Analysing runs in the browser engine, which is slow. The newer models download (“models-v2” on the Releases page) adds the engine that uses your graphics card: unzip it over your MediaVault folder.</div>
        )}
        {models && clip && (
          <div className="stats" style={{ flexDirection: 'row', flexWrap: 'wrap', gap: 10, paddingBottom: 0 }}>
            <div className="stat"><span className="faint" style={{ fontSize: 12 }}>Analysed</span><b>{clip.done.toLocaleString()} / {clip.total.toLocaleString()}</b></div>
            {runsOn && <div className="stat" title={engine?.problem ?? undefined}><span className="faint" style={{ fontSize: 12 }}>Runs on</span><b>{runsOn}</b></div>}
            {clip.failed > 0 && <div className="stat"><span className="faint" style={{ fontSize: 12 }}>Couldn't analyse</span><b>{clip.failed}</b></div>}
          </div>
        )}
      </section>

      <div className="divider" />

      <UpscalerSection />

      <div className="divider" />

      <DepthSection viewer={props.viewer} setViewer={props.setViewer} />
    </>
  );
}
