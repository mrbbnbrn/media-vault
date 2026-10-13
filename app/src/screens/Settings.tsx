import { useEffect, useState } from 'react';
import { api, DEFAULT_VIEWER, onEvent, type AppConfig, type ViewerSettings, type StorageDone, type StorageInfo, type StorageProgress } from '../api';
import type { Nav } from '../App';
import { Busy, ErrorBox, PasswordPair, TopBar, passwordsOk } from '../components/Chrome';
import { BackIcon, ExportIcon, ShieldIcon } from '../components/Icons';
import { DamageReportView, ExportDialog } from '../components/Safety';
import { faceBackend } from '../ml/facescan';
import { smartAvailable } from '../ml/smart';
import { startCheck, useTasks } from '../tasks';
import type { ClipStatus, EngineInfo, ScanStatus } from '../api';
import { ACCENTS, applyAccent, formatBytes } from '../theme';

type Section = 'appearance' | 'viewer' | 'vault' | 'storage' | 'safety' | 'smart' | 'about';

export function Settings({ nav }: { nav: Nav }) {
  const [section, setSection] = useState<Section>('appearance');
  const [cfg, setCfg] = useState<AppConfig>(nav.app.config);
  const [error, setError] = useState<string | null>(null);

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
                <h2>Auto-lock</h2>
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
          {section === 'storage' && <StorageSection />}
          {section === 'safety' && <SafetySection cfg={cfg} update={update} />}
          {section === 'smart' && <SmartSection />}
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
  const [busy, setBusy] = useState<'pw' | 'rk' | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [done, setDone] = useState(false);
  const [rkCurrent, setRkCurrent] = useState('');
  const [rkError, setRkError] = useState<string | null>(null);

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
        <div>
          <button type="submit" className="btn btn-primary" disabled={!!busy || !current || !passwordsOk(password, confirm, min)}>
            {busy === 'pw' ? <Busy label="Changing…" /> : 'Change password'}
          </button>
        </div>
      </form>

      <div className="divider" />

      <form className="section" onSubmit={newRecovery} style={{ maxWidth: 520 }}>
        <h2>New recovery key</h2>
        <p className="muted" style={{ margin: 0, lineHeight: 1.6 }}>
          Makes 24 new words and turns the old ones off. Use this if your paper copy was lost or someone may have seen it.
        </p>
        <div className="field">
          <label htmlFor="rkcur">Current password</label>
          <input id="rkcur" className="input" type="password" autoComplete="current-password" value={rkCurrent} onChange={(e) => setRkCurrent(e.target.value)} />
        </div>
        <ErrorBox error={rkError} />
        <div>
          <button type="submit" className="btn" disabled={!!busy || !rkCurrent}>
            {busy === 'rk' ? <Busy label="Making new key…" /> : 'Make a new recovery key'}
          </button>
        </div>
      </form>
    </>
  );
}

function StorageSection() {
  const [info, setInfo] = useState<StorageInfo | null>(null);
  const [job, setJob] = useState<StorageProgress | null>(null);
  const [done, setDone] = useState<StorageDone | null>(null);
  const [err, setErr] = useState<string | null>(null);
  useEffect(() => {
    api.storageInfo().then(setInfo).catch((e) => setErr(String(e)));
    const a = onEvent<StorageProgress>('storage-progress', setJob);
    const b = onEvent<StorageDone>('storage-done', (d) => {
      setJob(null);
      setDone(d);
      api.storageInfo().then(setInfo).catch(() => {});
    });
    return () => {
      a.then((u) => u());
      b.then((u) => u());
    };
  }, []);
  const run = async (task: 'convert' | 'reclaim') => {
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
      {job && (
        <div className="info">
          {job.task === 'convert' ? 'Packing' : 'Reclaiming space'}… {job.total ? `${job.done.toLocaleString()} / ${job.total.toLocaleString()}` : ''}
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

function SmartSection() {
  const [faces, setFaces] = useState<ScanStatus | null>(null);
  const [clip, setClip] = useState<ClipStatus | null>(null);
  const [models, setModels] = useState<boolean | null>(null);
  useEffect(() => {
    api.facesStatus().then(setFaces).catch(() => {});
    api.clipStatus().then(setClip).catch(() => {});
    smartAvailable().then(setModels);
  }, []);
  return (
    <>
      <section className="section">
        <h2>Face recognition</h2>
        <p className="muted" style={{ margin: 0, lineHeight: 1.6 }}>
          Mark a folder as a <b>person folder</b> (folder menu) and the app learns that person from the pictures inside, then
          suggests other pictures that show them in <b>People</b>. Scanning only happens for what you choose to scan, and
          nothing is moved until you confirm. Everything stays on this PC, inside the encrypted vault.
        </p>
        {faces && (
          <div className="stats" style={{ flexWrap: 'wrap' }}>
            <div className="stat"><span className="faint" style={{ fontSize: 12 }}>Scanned</span><b>{faces.scanned.toLocaleString()}</b></div>
            <div className="stat"><span className="faint" style={{ fontSize: 12 }}>Faces found</span><b>{faces.faces.toLocaleString()}</b></div>
            <div className="stat"><span className="faint" style={{ fontSize: 12 }}>Waiting</span><b>{faces.queued.toLocaleString()}</b></div>
            {faceBackend() && <div className="stat"><span className="faint" style={{ fontSize: 12 }}>Runs on</span><b>{faceBackend() === 'webgl' ? 'graphics card' : 'processor'}</b></div>}
          </div>
        )}
      </section>

      <div className="divider" />

      <section className="section">
        <h2>Smart search</h2>
        <p className="muted" style={{ margin: 0, lineHeight: 1.6 }}>
          Turn it on with the ✦ button next to the search box, then describe what you're looking for — “dog on the beach”,
          “kırmızı elbise”, “Geburtstagstorte”. Works in 50+ languages, fully offline. Pictures and videos are analysed in the
          background (using their thumbnails); the results stay inside the encrypted vault.
        </p>
        {models === false && <div className="notice">This copy of the app doesn't include the smart-search models. Use the full package (it has a “models” folder next to MediaVault.exe).</div>}
        {models && clip && (
          <div className="stats" style={{ flexWrap: 'wrap' }}>
            <div className="stat"><span className="faint" style={{ fontSize: 12 }}>Analysed</span><b>{clip.done.toLocaleString()} / {clip.total.toLocaleString()}</b></div>
            {clip.failed > 0 && <div className="stat"><span className="faint" style={{ fontSize: 12 }}>Couldn't analyse</span><b>{clip.failed}</b></div>}
          </div>
        )}
      </section>
    </>
  );
}
