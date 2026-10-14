// Convert items with the video tool: videos and GIFs to MP4 / WebM / GIF,
// pictures (and a GIF's first frame) to JPG / PNG / WebP. The results are
// new items next to the originals; the originals can go to the trash.

import { useEffect, useRef, useState } from 'react';
import { api, onEvent, type ConvertDone, type ConvertTarget, type Item, type VideoToolInfo, type VideoToolProgress } from '../api';
import { kickThumbnails } from '../media';
import { plural } from '../undo';
import { Modal } from './Dialogs';

const LABEL: Record<ConvertTarget, string> = {
  mp4: 'MP4 video',
  webm: 'WebM video',
  gif: 'GIF',
  jpg: 'JPG picture',
  png: 'PNG picture',
  webp: 'WebP picture',
};

const HINT: Record<ConvertTarget, string> = {
  mp4: 'plays almost everywhere',
  webm: 'smaller, plays in browsers',
  gif: 'no sound, at most 640 pixels wide, 15 frames a second',
  jpg: 'small, no see-through parts',
  png: 'exact, larger files',
  webp: 'small, good quality',
};

const ORDER: ConvertTarget[] = ['mp4', 'webm', 'gif', 'jpg', 'png', 'webp'];

/** The same rules as the app's converter: what this item can become. */
export function canConvert(item: Item, target: ConvertTarget): boolean {
  const allowed: ConvertTarget[] =
    item.kind === 'video' ? ['mp4', 'webm', 'gif'] : item.kind === 'gif' ? ORDER : item.kind === 'image' ? ['jpg', 'png', 'webp'] : [];
  if (!allowed.includes(target)) return false;
  const ext = item.ext.toLowerCase();
  // Making a new MP4 from an MP4 is allowed: it fixes videos that won't play.
  const same = target === 'jpg' ? ext === 'jpg' || ext === 'jpeg' : target !== 'mp4' && ext === target;
  return !same;
}

const errText = (e: unknown) => (e instanceof Error ? e.message : String(e));

export function ConvertDialog(props: {
  items: Item[];
  onClose: () => void;
  onDone?: () => void;
  /** Pick this format to start with (e.g. 'mp4' for a video that won't play). */
  target?: ConvertTarget;
}) {
  const { items } = props;
  const targets = ORDER.filter((t) => items.some((i) => canConvert(i, t)));
  const first: ConvertTarget | undefined =
    props.target && targets.includes(props.target) ? props.target
      : items.some((i) => i.kind === 'video' || i.kind === 'gif') && targets.includes('mp4') ? 'mp4'
        : targets[0];
  const [target, setTarget] = useState<ConvertTarget | undefined>(first);
  const [replace, setReplace] = useState(false);
  const [tool, setTool] = useState<VideoToolInfo | null | 'loading'>('loading');
  const [progress, setProgress] = useState<VideoToolProgress | null>(null);
  const [running, setRunning] = useState(false);
  const [done, setDone] = useState<ConvertDone | null>(null);
  const [err, setErr] = useState<string | null>(null);
  const unlisten = useRef<(() => void)[]>([]);

  useEffect(() => {
    api.videoToolInfo().then((i) => setTool(i ?? null)).catch(() => setTool(null));
    return () => unlisten.current.forEach((u) => u());
  }, []);

  const fits = target ? items.filter((i) => canConvert(i, target)) : [];
  const skipped = items.length - fits.length;

  const start = async () => {
    if (!target || !fits.length) return;
    setErr(null);
    setDone(null);
    setProgress(null);
    setRunning(true);
    unlisten.current.forEach((u) => u());
    unlisten.current = await Promise.all([
      onEvent<VideoToolProgress>('convert-progress', setProgress),
      onEvent<ConvertDone>('convert-done', (d) => {
        setRunning(false);
        setDone(d);
        if (d.created.length) {
          kickThumbnails();
          props.onDone?.();
        }
      }),
    ]);
    try {
      await api.convertStart({ ids: fits.map((i) => i.id), target, replace });
    } catch (e) {
      setRunning(false);
      setErr(errText(e));
    }
  };
  const stop = () => api.cancelVideoTask('convert').catch(() => {});
  const close = () => (running ? undefined : props.onClose());

  if (tool === null || (tool !== 'loading' && !tool.available)) {
    return (
      <Modal title="Convert" onClose={props.onClose}>
        <div className="notice">
          <span>
            Converting needs the video tool, which isn't installed. It comes with the full Media Vault package:
            unzip the full download so that the <b>tools</b> folder (with ffmpeg.exe inside) sits next to MediaVault.exe,
            then try again.
          </span>
        </div>
        <div className="row" style={{ justifyContent: 'flex-end' }}>
          <button type="button" className="btn btn-primary" onClick={props.onClose}>OK</button>
        </div>
      </Modal>
    );
  }

  if (done) {
    const failed = done.failed;
    return (
      <Modal title={done.error ? 'Converting didn’t work' : done.cancelled ? 'Converting stopped' : 'Converting finished'} onClose={props.onClose}>
        <div className="stack" style={{ gap: 10 }}>
          {done.error && <div className="error">{done.error}</div>}
          <span>
            {done.converted ? `${plural(done.converted, 'new item')} saved next to the original${done.converted === 1 ? '' : 's'}.` : 'Nothing was converted.'}
            {done.replaced > 0 && ` ${plural(done.replaced, 'original')} moved to the trash (you can restore ${done.replaced === 1 ? 'it' : 'them'} from there).`}
          </span>
          {failed.length > 0 && (
            <div className="stack" style={{ gap: 4 }}>
              <span className="muted" style={{ fontSize: 13 }}>{plural(failed.length, 'item')} couldn’t be converted:</span>
              <ul style={{ margin: 0, paddingLeft: 18, fontSize: 13, maxHeight: 180, overflow: 'auto' }}>
                {failed.map(([name, why], i) => <li key={i}><b>{name}</b>: {why}</li>)}
              </ul>
            </div>
          )}
        </div>
        <div className="row" style={{ justifyContent: 'flex-end' }}>
          <button type="button" className="btn btn-primary" onClick={props.onClose}>Done</button>
        </div>
      </Modal>
    );
  }

  return (
    <Modal title={`Convert ${items.length === 1 ? `“${items[0].name}”` : plural(items.length, 'item')}`} onClose={close}>
      {!targets.length ? (
        <p className="muted" style={{ margin: 0 }}>Only pictures, GIFs and videos can be converted.</p>
      ) : (
        <div className="stack">
          <div className="field">
            <label>Make it into</label>
            <div className="stack" style={{ gap: 0 }} role="radiogroup" aria-label="Format">
              {targets.map((t) => (
                <label key={t} className="check">
                  <input type="radio" name="convert-target" checked={target === t} disabled={running} onChange={() => setTarget(t)} />
                  <span>{LABEL[t]} <span className="faint" style={{ fontSize: 12 }}>· {HINT[t]}</span></span>
                </label>
              ))}
            </div>
          </div>
          {target && skipped > 0 && (
            <span className="faint" style={{ fontSize: 13 }}>
              {plural(skipped, 'item')} can’t become a {LABEL[target]} (or already {skipped === 1 ? 'is one' : 'are'}) and will be left as {skipped === 1 ? 'it is' : 'they are'}.
            </span>
          )}
          <div className="field">
            <label>The original</label>
            <div className="stack" style={{ gap: 0 }} role="radiogroup" aria-label="The original">
              <label className="check">
                <input type="radio" name="convert-replace" checked={!replace} disabled={running} onChange={() => setReplace(false)} />
                <span>Keep the original</span>
              </label>
              <label className="check">
                <input type="radio" name="convert-replace" checked={replace} disabled={running} onChange={() => setReplace(true)} />
                <span>Replace the original <span className="faint" style={{ fontSize: 12 }}>· it goes to the trash</span></span>
              </label>
            </div>
          </div>
          <span className="faint" style={{ fontSize: 12 }}>
            New items are saved in the same folder, with the same name and the new file type. Big videos can take a while.
          </span>
        </div>
      )}
      {running && (
        <div className="stack" style={{ gap: 6 }}>
          <div className="bar"><div style={{ width: `${Math.round((progress?.fraction ?? 0) * 100)}%` }} /></div>
          <span className="faint mono ellipsis" style={{ fontSize: 12 }}>
            {progress ? `${Math.min(progress.done + 1, progress.total)} / ${progress.total} · ${progress.name}` : 'starting…'}
          </span>
        </div>
      )}
      {err && <div className="error">{err}</div>}
      <div className="row" style={{ justifyContent: 'flex-end' }}>
        {running
          ? <button type="button" className="btn" onClick={stop}>Stop</button>
          : <button type="button" className="btn" onClick={props.onClose}>Cancel</button>}
        <button type="button" className="btn btn-primary" disabled={running || !fits.length || tool === 'loading'} onClick={start}>
          {running ? 'Converting…' : fits.length > 1 ? `Convert ${fits.length}` : 'Convert'}
        </button>
      </div>
    </Modal>
  );
}
