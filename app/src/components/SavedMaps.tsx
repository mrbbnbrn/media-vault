// Settings → Faces & smart search: the depth maps and outlines saved in the
// vault (pictures only): how many and how big, clearing them, and working
// out the missing ones or all of them again in the background (prepare.ts),
// with progress and Stop.

import { useEffect, useState, useSyncExternalStore } from 'react';
import { api, type DerivedStats, type ViewerSettings } from '../api';
import { onSavedChange } from '../derived';
import { onRebuild, prepareVault, rebuildState, stopRebuild } from '../prepare';
import { Delete3DData } from './Delete3DData';
import { ConfirmDialog } from './Dialogs';

function mb(b: number): string {
  if (!b) return '0 MB';
  return b >= 1e9 ? `${(b / 1e9).toFixed(1)} GB` : b < 1e6 ? `${(b / 1e6).toFixed(1)} MB` : `${Math.round(b / 1e6)} MB`;
}

export function SavedMapsSection(props: { viewer: ViewerSettings; setViewer: (patch: Partial<ViewerSettings>) => void }) {
  const [stats, setStats] = useState<DerivedStats | null>(null);
  const [ask, setAsk] = useState<'clear' | 'again' | null>(null);
  const [del, setDel] = useState(false);
  const [note, setNote] = useState<string | null>(null);
  const job = useSyncExternalStore(onRebuild, rebuildState);
  const load = () => void api.derivedStats().then(setStats).catch(() => setStats(null));
  useEffect(load, []);
  // The count follows as maps are saved (at most twice a second).
  useEffect(() => {
    let t: ReturnType<typeof setTimeout> | null = null;
    const off = onSavedChange(() => {
      if (!t) t = setTimeout(() => { t = null; load(); }, 500);
    });
    return () => {
      off();
      if (t) clearTimeout(t);
    };
  }, []);
  useEffect(() => {
    if (!job.running) load();
  }, [job.running]);
  const pictures = stats ? Math.max(stats.depthCount, stats.outlineCount) : 0;
  const bytes = stats ? stats.depthBytes + stats.outlineBytes + (stats.layerBytes ?? 0) : 0;
  const clear = async () => {
    try {
      const n = await api.derivedClear();
      setNote(n ? `Cleared ${n.toLocaleString()} saved ${n === 1 ? 'map' : 'maps'}.` : 'Nothing to clear.');
    } catch (e) {
      setNote(`Couldn't clear them: ${e instanceof Error ? e.message : String(e)}`);
    }
    load();
  };
  return (
    <div className="saved-maps" style={{ marginTop: 18 }}>
      <h3 style={{ margin: '0 0 4px', fontSize: 14 }}>Saved depth maps and outlines</h3>
      <p className="muted" style={{ margin: '0 0 8px', lineHeight: 1.6 }}>
        Once a picture's depth or subject outline is worked out it's saved in the vault (encrypted), so it never has to
        be worked out again. Pictures only. Preparing works them out for every installed depth and outline model, and also makes the
        layers Lift-off and Layered 3D draw (the subject on its own and the filled-in background, for the models and fill chosen now),
        so those start at once. To prepare one folder or person, right-click it and
        choose Prepare 3D data. It all runs in the background (see the ring at the bottom of the sidebar).
      </p>
      <div className="row" style={{ gap: 10, flexWrap: 'wrap', alignItems: 'center' }}>
        <span>{stats ? `${pictures.toLocaleString()} ${pictures === 1 ? 'picture' : 'pictures'}, ${mb(bytes)}` : '…'}</span>
        <button type="button" className="btn btn-sm" disabled={job.running || !stats || bytes === 0} onClick={() => setAsk('clear')}>Clear them</button>
        <button type="button" className="btn btn-sm" title="Only the pictures that don't have a saved depth map or outline yet"
          onClick={() => { setNote(null); if (prepareVault(false) === 'already') setNote('Already working on that.'); }}>Work out the missing ones</button>
        <button type="button" className="btn btn-sm" title="Only the pictures the face scan found a face in (not only poor faces); pictures not scanned yet are left out"
          onClick={() => { setNote(null); if (prepareVault(false, true) === 'already') setNote('Already working on that.'); }}>Work out the missing ones, pictures with faces only</button>
        <button type="button" className="btn btn-sm" disabled={job.running} onClick={() => setAsk('again')}>Work them all out again</button>
        <button type="button" className="btn btn-sm" disabled={!stats || bytes === 0} title="Choose which models, and which pictures (for example only those without faces, like screenshots)" onClick={() => setDel(true)}>Delete 3D data…</button>
      </div>
      {(job.running || job.note) && (
        <div className="row" style={{ gap: 10, marginTop: 8, alignItems: 'center' }} role="status">
          <span className="faint">
            {job.running && job.total > 0 ? `Working out ${job.done.toLocaleString()} of ${job.total.toLocaleString()} maps in ${job.what}…` : ''}
            {job.note ? `${job.running && job.total > 0 ? ' ' : ''}${job.note}` : ''}
          </span>
          {job.running && job.waiting > 0 && <span className="faint">({job.waiting} more waiting)</span>}
          {job.running && <button type="button" className="btn btn-sm" onClick={stopRebuild}>Stop</button>}
        </div>
      )}
      {note && !job.running && <div className="faint" style={{ marginTop: 6 }}>{note}</div>}
      <label className="check" style={{ marginTop: 10 }}>
        <input type="checkbox" checked={props.viewer.depthIdlePrepare !== false} onChange={(e) => props.setViewer({ depthIdlePrepare: e.target.checked })} />
        Prepare while idle: with a 3D or subject effect on, work out the pictures in the open folder after 20 seconds without using the mouse or keyboard
      </label>
      {del && (
        <Delete3DData what="the whole vault" folders={[]} ids={[]} filters={[{ kinds: ['image'] }]} onClose={() => setDel(false)}
          onDone={(text) => { setNote(text); load(); }} />
      )}
      {ask === 'clear' && (
        <ConfirmDialog title="Clear the saved depth maps and outlines?" confirm="Clear them" danger onClose={() => setAsk(null)}
          onConfirm={() => { setAsk(null); void clear(); }}>
          They're worked out again when needed (pictures take a moment longer to start in 3D). Your pictures don't change.
        </ConfirmDialog>
      )}
      {ask === 'again' && (
        <ConfirmDialog title="Work them all out again?" confirm="Clear and work them out" onClose={() => setAsk(null)}
          onConfirm={() => { setAsk(null); setNote(null); prepareVault(true); }}>
          The saved ones are cleared, then every picture in the vault gets its depth maps and outlines worked out again in
          the background, for every installed model. It can take a while; you can stop it at any time.
        </ConfirmDialog>
      )}
    </div>
  );
}
