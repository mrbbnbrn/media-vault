// Duel mode: two pictures side by side; pick the one you like more. Each pick
// updates both ratings (Elo), and the ratings set the weights used by
// "Weighted random", so your favourites come up more often.
//
// Click or ← / → = pick, ↓ = skip, Ctrl+Z = undo, Esc = close with a summary.

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { api, mediaUrl, thumbUrl, type DuelState, type Item } from '../api';
import { pairKey, pickPair } from '../viewerlogic';
import { CloseIcon, UndoIcon } from './Icons';

interface Done {
  winner: number;
  loser: number;
  before: DuelState[];
}

export function Duel({ items, onClose }: { items: Item[]; onClose: () => void }) {
  const pool = useMemo(() => items.filter((i) => i.kind === 'image' || i.kind === 'gif' || i.kind === 'video'), [items]);
  const byId = useMemo(() => new Map(pool.map((i) => [i.id, i])), [pool]);
  const [ratings, setRatings] = useState<Map<number, DuelState> | null>(null);
  const [pair, setPair] = useState<[number, number] | null>(null);
  const [picked, setPicked] = useState<number | null>(null);
  const [history, setHistory] = useState<Done[]>([]);
  const [summary, setSummary] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const lastPair = useRef<string | null>(null);
  const busy = useRef(false);

  const choose = useCallback((r: Map<number, DuelState>) => {
    const list = pool.map((i) => {
      const x = r.get(i.id);
      return { id: i.id, elo: x?.elo ?? 1000, duels: x?.duels ?? 0 };
    });
    const p = pickPair(list, lastPair.current);
    if (!p) return setPair(null);
    lastPair.current = pairKey(p[0].id, p[1].id);
    setPair([p[0].id, p[1].id]);
    setPicked(null);
  }, [pool]);

  useEffect(() => {
    api.duelRatings(pool.map((i) => i.id))
      .then((list) => {
        const m = new Map(list.map((x) => [x.id, x]));
        setRatings(m);
        choose(m);
      })
      .catch((e) => setError(String(e?.message ?? e)));
  }, [pool, choose]);

  const pick = async (side: 0 | 1) => {
    if (!pair || !ratings || busy.current || summary) return;
    busy.current = true;
    const winner = pair[side];
    const loser = pair[1 - side];
    setPicked(winner);
    try {
      const o = await api.duelResult(winner, loser);
      const m = new Map(ratings);
      const w = m.get(winner) ?? { id: winner, elo: 1000, duels: 0, weight: 1 };
      const l = m.get(loser) ?? { id: loser, elo: 1000, duels: 0, weight: 1 };
      m.set(winner, { ...w, elo: o.winnerElo, duels: w.duels + 1, weight: o.winnerWeight });
      m.set(loser, { ...l, elo: o.loserElo, duels: l.duels + 1, weight: o.loserWeight });
      setRatings(m);
      setHistory((h) => [...h, { winner, loser, before: o.before }]);
      // A short moment to see the pick, then the next pair.
      setTimeout(() => {
        busy.current = false;
        choose(m);
      }, 180);
    } catch (e) {
      busy.current = false;
      setPicked(null);
      setError(`Couldn't save that pick: ${e instanceof Error ? e.message : String(e)}`);
    }
  };

  const skip = () => {
    if (ratings && !busy.current && !summary) choose(ratings);
  };

  const undo = async () => {
    const last = history[history.length - 1];
    if (!last || !ratings || busy.current) return;
    busy.current = true;
    try {
      await api.duelRestore(last.before);
      const m = new Map(ratings);
      last.before.forEach((b) => m.set(b.id, b));
      setRatings(m);
      setHistory((h) => h.slice(0, -1));
      lastPair.current = pairKey(last.winner, last.loser);
      setPair([last.winner, last.loser]);
      setPicked(null);
      setSummary(false);
    } catch (e) {
      setError(`Couldn't undo: ${e instanceof Error ? e.message : String(e)}`);
    } finally {
      busy.current = false;
    }
  };

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if ((e.target as HTMLElement).closest('input, textarea, select')) return;
      const k = e.key.toLowerCase();
      if ((e.ctrlKey || e.metaKey) && k === 'z') {
        e.preventDefault();
        e.stopPropagation(); // not the library's undo
        undo();
        return;
      }
      if (k === 'escape') {
        e.preventDefault();
        e.stopPropagation();
        if (summary || history.length === 0) onClose();
        else setSummary(true);
        return;
      }
      if (summary) return;
      if (k === 'arrowleft') pick(0);
      else if (k === 'arrowright') pick(1);
      else if (k === 'arrowdown') skip();
      else return;
      e.preventDefault();
      e.stopPropagation();
    };
    window.addEventListener('keydown', onKey, true);
    return () => window.removeEventListener('keydown', onKey, true);
  });

  const top = useMemo(() => {
    if (!ratings) return [];
    return pool
      .map((i) => ({ item: i, r: ratings.get(i.id) }))
      .filter((x) => x.r && x.r.duels > 0)
      .sort((a, b) => b.r!.elo - a.r!.elo)
      .slice(0, 6);
  }, [ratings, pool]);

  const side = (id: number, which: 0 | 1) => {
    const it = byId.get(id);
    if (!it) return null;
    const r = ratings?.get(id);
    return (
      <button type="button" className={`duel-side${picked === id ? ' won' : picked != null ? ' lost' : ''}`} onClick={() => pick(which)}
        aria-label={`Pick ${it.name} (${which === 0 ? '←' : '→'})`}>
        <span className="duel-media">
          {it.kind === 'video' ? (
            <video key={id} src={mediaUrl(id)} poster={it.thumb === 'ok' ? thumbUrl(id) : undefined} muted loop autoPlay playsInline crossOrigin="anonymous" />
          ) : (
            <img key={id} src={mediaUrl(id)} alt={it.name} draggable={false} />
          )}
        </span>
        <span className="duel-info">
          <span className="ellipsis">{it.name}</span>
          <span className="faint mono">Weight {r?.weight ?? it.weight} · {r?.duels ?? 0} {r?.duels === 1 ? 'duel' : 'duels'}</span>
        </span>
      </button>
    );
  };

  return (
    <div className="duel" role="dialog" aria-modal="true" aria-label="Duel">
      <div className="duel-top">
        <div>
          <b>Which do you like more?</b>
          <span className="faint"> Your picks set the weights for weighted random.</span>
        </div>
        <div className="row">
          <span className="faint mono">{history.length} {history.length === 1 ? 'duel' : 'duels'}</span>
          <button type="button" className="btn btn-sm glass" disabled={!history.length} onClick={undo} title="Undo the last pick (Ctrl+Z)"><UndoIcon size={14} /> Undo</button>
          <button type="button" className="btn btn-icon btn-sm glass" aria-label="Close" title="Close (Esc)" onClick={() => (history.length ? setSummary(true) : onClose())}><CloseIcon /></button>
        </div>
      </div>
      {error && <div className="error duel-error" role="alert">{error}</div>}
      {pool.length < 2 ? (
        <div className="empty"><p className="muted">A duel needs at least two pictures or videos.</p>
          <button type="button" className="btn btn-primary" onClick={onClose}>Close</button></div>
      ) : !pair ? (
        <div className="empty"><p className="muted">Loading…</p></div>
      ) : (
        <>
          <div className="duel-pair">
            {side(pair[0], 0)}
            <span className="duel-vs" aria-hidden="true">or</span>
            {side(pair[1], 1)}
          </div>
          <div className="duel-help faint">
            Click one or press <kbd>←</kbd> / <kbd>→</kbd> · <kbd>↓</kbd> skip · <kbd>Ctrl</kbd>+<kbd>Z</kbd> undo · <kbd>Esc</kbd> done
          </div>
        </>
      )}
      {summary && (
        <div className="modal-back">
          <div className="modal" role="dialog" aria-modal="true" aria-label="Duel summary">
            <h2>Nice — {history.length} {history.length === 1 ? 'duel' : 'duels'}</h2>
            <p className="muted" style={{ margin: 0 }}>The weights below are used whenever a slideshow plays in “Weighted random” order.</p>
            {top.length > 0 && (
              <div className="duel-top-list">
                {top.map(({ item, r }) => (
                  <div key={item.id} className="duel-top-row">
                    {item.thumb === 'ok' ? <img src={thumbUrl(item.id)} alt="" /> : <span className="duel-thumb-none" />}
                    <span className="ellipsis">{item.name}</span>
                    <span className="mono faint">weight {r!.weight}</span>
                  </div>
                ))}
              </div>
            )}
            <div className="row" style={{ justifyContent: 'flex-end' }}>
              <button type="button" className="btn" onClick={() => setSummary(false)}>Keep going</button>
              <button type="button" className="btn btn-primary" autoFocus onClick={onClose}>Close</button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
