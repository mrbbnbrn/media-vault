import { api } from '../api';
import type { Nav } from '../App';
import { TopBar } from '../components/Chrome';
import { GearIcon, ImagesIcon, LockIcon } from '../components/Icons';

/** Placeholder until import and browsing arrive (build step 3). */
export function Library({ nav }: { nav: Nav }) {
  const s = nav.app.session;
  if (!s) return null;
  return (
    <>
      <TopBar title={s.name}>
        <button type="button" className="btn btn-sm" onClick={() => nav.go({ name: 'settings' })}>
          <GearIcon /> Settings
        </button>
        <button type="button" className="btn btn-sm" onClick={() => api.lock()}>
          <LockIcon size={16} /> Lock
        </button>
      </TopBar>
      {s.restoredFromBackup && (
        <div className="notice" style={{ margin: '16px 22px 0' }}>
          The library database was damaged, so the most recent backup was used. Recent changes may be missing.
        </div>
      )}
      <div className="empty">
        <div className="badge"><ImagesIcon /></div>
        <h1 style={{ fontSize: 24 }}>“{s.name}” is unlocked</h1>
        <p className="lead" style={{ textAlign: 'center' }}>
          Your vault is ready. Importing (files, folders and 7z archives) and the library view arrive in the next update.
        </p>
        <div className="stats">
          <div className="stat"><span className="faint" style={{ fontSize: 12 }}>Items</span><b>{s.items.toLocaleString()}</b></div>
          <div className="stat"><span className="faint" style={{ fontSize: 12 }}>Folders</span><b>{s.folders.toLocaleString()}</b></div>
        </div>
        <p className="faint mono" style={{ fontSize: 12 }}>{s.path}</p>
      </div>
    </>
  );
}
