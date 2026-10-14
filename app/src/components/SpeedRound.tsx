// Speed round: pictures and GIFs flash by, one every second or so; press F
// (or the heart) for the ones you love. At the end: how many you picked, with
// "Undo all".

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { setPlaying } from '../activity';
import { api } from '../api';
import type { PlayItem } from '../media';
import { clampSpeed, SPEED_MAX, SPEED_MIN } from '../viewerlogic';
import { BackIcon, HeartIcon, NextIcon, PauseIcon, PlayIcon, PrevIcon } from './Icons';

export function SpeedRound(props: { items: PlayItem[]; title: string; onClose: () => void }) {
  const list = useMemo(() => props.items.filter((i) => (i.kind === 'image' || i.kind === 'gif') && i.itemId != null), [props.items]);
  const [index, setIndex] = useState(0);
  const [seconds, setSeconds] = useState(1);
  const [paused, setPaused] = useState(false);
  const [done, setDone] = useState(false);
  const [bursts, setBursts] = useState<number[]>([]);
  // Favourited during this round (only those that weren't favourites before).
  const [added, setAdded] = useState<Set<number>>(new Set());
  const [favs, setFavs] = useState<Set<number>>(() => new Set(list.filter((i) => i.favourite).map((i) => i.itemId!)));
  const seen = useRef(new Set<number>());
  const [undone, setUndone] = useState(false);
  const cur = list[index] ?? null;

  useEffect(() => {
    if (cur?.itemId != null) seen.current.add(cur.itemId);
  }, [cur]);

  // Load the next few ahead so they show at once.
  useEffect(() => {
    const ahead = list.slice(index + 1, index + 4).map((i) => {
      const img = new Image();
      img.decoding = 'async';
      img.src = i.src;
      return img;
    });
    return () => ahead.forEach((img) => (img.src = ''));
  }, [index, list]);

  useEffect(() => {
    if (done || paused || !cur) return;
    const t = setTimeout(() => {
      if (index + 1 >= list.length) setDone(true);
      else setIndex(index + 1);
    }, seconds * 1000);
    return () => clearTimeout(t);
  }, [index, seconds, paused, done, cur, list.length]);

  // Counts as playing for auto-lock while it runs.
  useEffect(() => {
    setPlaying('speed-round', !done && !paused);
    return () => setPlaying('speed-round', false);
  }, [done, paused]);

  const favourite = useCallback(() => {
    if (!cur || cur.itemId == null || done) return;
    const id = cur.itemId;
    setBursts((b) => [...b, Date.now()]);
    if (favs.has(id)) return;
    setFavs((f) => new Set(f).add(id));
    setAdded((a) => new Set(a).add(id));
    cur.favourite = true;
    api.setFavourite([id], true).catch(() => {});
  }, [cur, done, favs]);

  const step = (d: number) => {
    setIndex((i) => Math.max(0, Math.min(list.length - 1, i + d)));
  };

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if ((e.target as HTMLElement).closest('input, textarea, select')) return;
      const k = e.key.toLowerCase();
      if (done) {
        if (k === 'escape') {
          e.preventDefault();
          props.onClose();
        }
        return;
      }
      if (k === 'f') favourite();
      else if (k === ' ') {
        e.preventDefault();
        setPaused((p) => !p);
      } else if (k === 'arrowright') step(1);
      else if (k === 'arrowleft') step(-1);
      else if (k === '[') setSeconds((s) => clampSpeed(s - 0.25));
      else if (k === ']') setSeconds((s) => clampSpeed(s + 0.25));
      else if (k === 'escape' || k === 'backspace') setDone(true);
      else return;
      e.preventDefault();
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  });

  useEffect(() => {
    if (!bursts.length) return;
    const t = setTimeout(() => setBursts((b) => b.filter((x) => Date.now() - x < 650)), 700);
    return () => clearTimeout(t);
  }, [bursts]);

  const undoAll = async () => {
    const ids = [...added];
    if (ids.length) await api.setFavourite(ids, false).catch(() => {});
    list.forEach((i) => {
      if (i.itemId != null && added.has(i.itemId)) i.favourite = false;
    });
    setUndone(true);
  };

  if (!list.length) {
    return (
      <div className="speed-round">
        <div className="speed-summary" role="dialog" aria-label="Speed round">
          <h2>Speed round</h2>
          <p className="muted">There are no pictures or GIFs here. Speed rounds skip videos, text and PDFs.</p>
          <button type="button" className="btn btn-primary" onClick={props.onClose}>Close</button>
        </div>
      </div>
    );
  }

  const isFav = cur?.itemId != null && favs.has(cur.itemId);
  return (
    <div className="speed-round">
      {cur && <img key={cur.key} className="speed-pic" src={cur.src} alt={cur.name} draggable={false} />}
      {bursts.map((b) => (
        <span key={b} className="heart-burst" aria-hidden="true"><HeartIcon filled size={120} /></span>
      ))}
      {!done && (
        <>
          <div className="speed-top">
            <button type="button" className="btn btn-icon btn-sm glass" aria-label="End the speed round" title="End (Esc)" onClick={() => setDone(true)}><BackIcon /></button>
            <span className="p-name">{props.title}</span>
            <span className="faint mono">{index + 1} / {list.length}</span>
            <span className="speed-count"><HeartIcon filled size={14} /> {added.size}</span>
          </div>
          <div className="speed-progress" aria-hidden="true">
            {!paused && <span key={`${index}-${seconds}`} style={{ animationDuration: `${seconds}s` }} />}
          </div>
          <div className="speed-bar">
            <button type="button" className="pbtn lg" aria-label="Previous" title="Previous (←)" onClick={() => step(-1)}><PrevIcon /></button>
            <button type="button" className="pbtn lg" aria-label={paused ? 'Play' : 'Pause'} title={paused ? 'Play (Space)' : 'Pause (Space)'} onClick={() => setPaused((p) => !p)}>
              {paused ? <PlayIcon /> : <PauseIcon />}
            </button>
            <button type="button" className="pbtn lg" aria-label="Next" title="Next (→)" onClick={() => step(1)}><NextIcon /></button>
            <button type="button" className={`speed-heart${isFav ? ' on' : ''}`} aria-label="Favourite this one (F)" title="Favourite this one (F)" onClick={favourite}>
              <HeartIcon filled={isFav} size={26} />
            </button>
            <label className="speed-slider" title="Seconds per picture ([ and ])">
              <input type="range" min={SPEED_MIN} max={SPEED_MAX} step={0.25} value={seconds} aria-label="Seconds per picture"
                onChange={(e) => setSeconds(clampSpeed(Number(e.target.value)))} />
              <span className="mono">{seconds.toFixed(2).replace(/0$/, '')} s</span>
            </label>
          </div>
        </>
      )}
      {done && (
        <div className="speed-summary" role="dialog" aria-label="Speed round finished">
          <h2>Speed round done</h2>
          <p>
            You favourited <b>{added.size}</b> of {seen.current.size}{seen.current.size < list.length ? ` (of ${list.length} in all)` : ''}.
          </p>
          {undone && <p className="muted">Undone — those are no longer favourites.</p>}
          <div className="row" style={{ justifyContent: 'flex-end' }}>
            {added.size > 0 && !undone && <button type="button" className="btn" onClick={undoAll}>Undo all</button>}
            <button type="button" className="btn btn-primary" autoFocus onClick={props.onClose}>Close</button>
          </div>
        </div>
      )}
    </div>
  );
}
