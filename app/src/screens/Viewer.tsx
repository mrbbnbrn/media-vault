// Full viewer / slideshow for a list of items.

import { useEffect, useState } from 'react';
import { api, type Named } from '../api';
import type { Nav } from '../App';
import { Dropdown, PromptDialog } from '../components/Dialogs';
import { BackIcon } from '../components/Icons';
import { Player } from '../components/Player';
import type { PlayItem } from '../media';
import type { Order } from '../playlist';
import { DEFAULT_PLAYBACK, normalize, type PlaybackSettings } from '../presets';
import { setCleanFullscreen } from '../fullscreen';

let lastSettings: PlaybackSettings = DEFAULT_PLAYBACK;

export function Viewer(props: { nav: Nav; items: PlayItem[]; startKey?: string; title: string; auto: boolean; order?: Order; onBack: () => void }) {
  const [settings, setSettings] = useState<PlaybackSettings>(() => {
    // Follow the library's sort order, unless a random order was chosen before.
    const random = ['shuffle', 'random', 'weighted'].includes(lastSettings.order);
    return props.order && !random ? { ...lastSettings, order: props.order } : lastSettings;
  });
  const [presets, setPresets] = useState<Named<PlaybackSettings>[]>([]);
  const [presetName, setPresetName] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);
  const [clean, setClean] = useState(false);
  const vault = !!props.nav.app.session;

  useEffect(() => {
    if (vault) api.listNamed<PlaybackSettings>('preset').then(setPresets).catch(() => {});
  }, [vault]);
  useEffect(() => {
    lastSettings = settings;
  }, [settings]);
  useEffect(() => () => void setCleanFullscreen(false), []);

  const toggleClean = async () => {
    const next = !clean;
    setClean(next);
    await setCleanFullscreen(next);
  };

  const presetItems = [
    ...presets.map((p) => ({
      label: p.name,
      checked: p.name === presetName,
      onSelect: () => {
        setSettings(normalize(p.settings));
        setPresetName(p.name);
      },
    })),
    { label: 'Save current settings as preset…', onSelect: () => setSaving(true) },
    ...(presetName ? [{ label: `Delete “${presetName}”`, danger: true, onSelect: async () => {
      const p = presets.find((x) => x.name === presetName);
      if (p?.id != null) await api.deleteNamed('preset', p.id);
      setPresetName(null);
      setPresets(await api.listNamed<PlaybackSettings>('preset'));
    } }] : []),
  ];

  return (
    <div className={`viewer${clean ? ' clean' : ''}`}>
      <Player
        items={props.items}
        startKey={props.startKey}
        settings={settings}
        onSettings={(s) => { setSettings(s); setPresetName(null); }}
        autoSlideshow={props.auto}
        clean={clean}
        controlsOnMouse={props.nav.app.config.fullscreenControlsOnMouse}
        keys
        activityId="viewer"
        title={
          <button type="button" className="btn btn-icon btn-sm glass" aria-label="Back" onClick={() => (clean ? toggleClean() : props.onBack())}>
            <BackIcon />
          </button>
        }
        topRight={
          <>
            {vault && <Dropdown className="btn btn-sm glass" label={`Preset: ${presetName ?? 'custom'} ▾`} items={presetItems} />}
            <SettingsMenu s={settings} set={(p) => { setSettings({ ...settings, ...p }); setPresetName(null); }} />
          </>
        }
        onFavourite={vault ? (it, on) => it.itemId != null && api.setFavourite([it.itemId], on) : undefined}
        onWeight={vault ? (it, w) => it.itemId != null && api.setWeight([it.itemId], w) : undefined}
        onFullscreen={toggleClean}
        onClose={() => (clean ? toggleClean() : props.onBack())}
      />
      {saving && (
        <PromptDialog title="Save preset" label="Name" confirm="Save" onClose={() => setSaving(false)}
          hint="Saves picture duration, video and GIF timing, order, repeat, speed and sound."
          onSubmit={async (name) => {
            await api.saveNamed('preset', { id: null, name, settings });
            setPresets(await api.listNamed<PlaybackSettings>('preset'));
            setPresetName(name.trim());
          }} />
      )}
    </div>
  );
}

/** Timing and display settings for the slideshow. */
export function SettingsMenu({ s, set, compact }: { s: PlaybackSettings; set: (p: Partial<PlaybackSettings>) => void; compact?: boolean }) {
  const [open, setOpen] = useState(false);
  return (
    <>
      <button type="button" className={compact ? 'pbtn' : 'btn btn-sm glass'} onClick={() => setOpen(true)} aria-label="Slideshow settings" title="Slideshow settings">
        {compact ? '⚙' : 'Timing ▾'}
      </button>
      {open && <PlaybackDialog s={s} set={set} onClose={() => setOpen(false)} />}
    </>
  );
}

function PlaybackDialog({ s, set, onClose }: { s: PlaybackSettings; set: (p: Partial<PlaybackSettings>) => void; onClose: () => void }) {
  const num = (v: string) => (v === '' ? 0 : Number(v));
  return (
    <div className="modal-back" onMouseDown={(e) => e.target === e.currentTarget && onClose()}>
      <div className="modal" role="dialog" aria-modal="true" aria-label="Slideshow settings">
        <h2>Slideshow settings</h2>
        <div className="form-grid">
          <label htmlFor="ps-img">Pictures stay for</label>
          <span className="row"><input id="ps-img" className="input small" type="number" min={1} value={s.imageSeconds}
            onChange={(e) => set({ imageSeconds: Math.max(1, num(e.target.value)) })} /> seconds</span>

          <label htmlFor="ps-vmax">Videos play for at most</label>
          <span className="row"><input id="ps-vmax" className="input small" type="number" min={0} value={s.videoMaxSeconds}
            onChange={(e) => set({ videoMaxSeconds: Math.max(0, num(e.target.value)) })} /> seconds <span className="faint">(0 = to the end)</span></span>

          <span>Videos start</span>
          <span className="row">
            <label className="check"><input type="checkbox" checked={s.videoRandomStart} onChange={(e) => set({ videoRandomStart: e.target.checked })} /> at a random point</label>
          </span>

          <label htmlFor="ps-loops">GIFs play</label>
          <span className="row"><input id="ps-loops" className="input small" type="number" min={0} value={s.gifLoops}
            onChange={(e) => set({ gifLoops: Math.max(0, Math.round(num(e.target.value))) })} /> loops, at most
            <input aria-label="GIF maximum seconds" className="input small" type="number" min={0} value={s.gifMaxSeconds}
              onChange={(e) => set({ gifMaxSeconds: Math.max(0, num(e.target.value)) })} /> seconds</span>

          <span>Picture fit</span>
          <div role="group" className="seg">
            <button type="button" className={s.fit === 'contain' ? 'on' : ''} onClick={() => set({ fit: 'contain' })}>Fit (whole picture)</button>
            <button type="button" className={s.fit === 'cover' ? 'on' : ''} onClick={() => set({ fit: 'cover' })}>Fill (crop edges)</button>
          </div>

          <span>Transition</span>
          <div role="group" className="seg">
            <button type="button" className={s.transition === 'none' ? 'on' : ''} onClick={() => set({ transition: 'none' })}>None</button>
            <button type="button" className={s.transition === 'fade' ? 'on' : ''} onClick={() => set({ transition: 'fade' })}>Fade</button>
          </div>
        </div>
        <div className="row" style={{ justifyContent: 'flex-end' }}>
          <button type="button" className="btn btn-primary" onClick={onClose}>Done</button>
        </div>
      </div>
    </div>
  );
}
