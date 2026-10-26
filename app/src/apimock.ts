// The browser-only stand-in for the backend: answers every call with demo
// data when the window runs outside the app (the design preview, ?demo, and
// the tests). Nothing here runs inside the real app.

import { noteEvent } from './perf';
import type {
  AnalyseStatus, AppConfig, AppState, BeatStatus, DepthBenchmark, DepthDetail, DepthInfo, DepthMap, DepthModel, DerivedGroup, DerivedKind, DerivedStats, FaceSplit, Growth, GrowthMonth, InpaintBenchmark, InpaintInfo, InpaintModel, InpaintRequest, Item, LibraryBackup, LockReason, Rgba, SessionInfo, SmartEngine, SubjectBenchmark, SubjectInfo, SubjectMask, SubjectModel, UpscaleListener, UpscaleRequest, UpscaleSaved, UpscalerInfo,
} from './api';

export const mockListeners = new Map<string, Set<(p: unknown) => void>>();

/** Browser preview: send an event to the window. */
export function mockEmit(name: string, payload: unknown) {
  noteEvent(name);
  mockListeners.get(name)?.forEach((f) => f(payload));
}

export const WORDS =
  'harbor lunar ticket pepper oval wisdom gentle forest canyon ribbon atom spray velvet frozen orbit maple shadow guitar remind lens unfair candle drift solar'.split(
    ' ',
  );

/** The preview's library backups, oldest first (made over the last few days). */
export const mockBackups: LibraryBackup[] = [5, 3, 2, 1, 0.2].map((days, i) => {
  const at = Date.now() - days * 86_400_000;
  return { name: `meta-${String(at).padStart(15, '0')}.db.enc`, atMs: at, bytes: 380_000 + i * 8000 };
});

export const mock = {
  lockListeners: [] as ((r: LockReason) => void)[],
  state: {
    config: {
      accent: '#2ec4b6',
      lock: { idleMinutes: 15, onSystemLock: true, onMinimize: false, safetyNetMinutes: 0 },
      fullscreenControlsOnMouse: true,
      preview: 'hover',
      wholeOnHover: false,
      previewQuality: 'auto',
      gridShape: false,
      viewer: { smoothFit: true, smoothZoom: true, sharpen: false, seekSeconds: 5, seekBigSeconds: 30, muted: true, soundVolume: 0, gridColumns: 0, ambient: false, faceBoxes: false },
      builtinEngine: true,
      smartSearch: false,
      makePreviews: true,
      smartIndex: true,
      blockCapture: true,
      look: { sidebarRail: false, hoverInfo: true, faceCrop: false, uiScale: 1, style: 'default', tileGap: 10, tileRadius: 8, topBar: [] },
      stripMetadata: false,
      notifyDone: true,
      vaults: [{ path: 'D:\\Vaults\\Photos' }, { path: 'D:\\Vaults\\Archive' }, { path: 'F:\\Vault backup' }],
      lastVault: 'D:\\Vaults\\Photos',
    },
    vaults: [
      { path: 'D:\\Vaults\\Photos', name: 'Photos', status: 'ready', sizeBytes: 8.2e9, passwordless: false },
      { path: 'D:\\Vaults\\Archive', name: 'Archive', status: 'ready', sizeBytes: 1.01e11, passwordless: true },
      { path: 'F:\\Vault backup', name: 'Vault backup', status: 'missing', sizeBytes: null, passwordless: false },
    ],
    session: null,
    minPasswordChars: 8,
  } as AppState,
  pickFolder: async () => 'D:\\Vaults',
  async call(cmd: string, a: Record<string, unknown>): Promise<unknown> {
    // The batched commands, made of the single ones the previews answer.
    if (cmd === 'library_page') {
      const [folders, tags, items] = await Promise.all([
        this.call('library_folders', {}),
        this.call('all_tags', {}),
        a.filter ? this.call('query_items', { filter: a.filter }) : Promise.resolve(null),
      ]);
      return { folders: folders ?? [], tags: tags ?? [], items };
    }
    if (cmd === 'add_copy_bytes') return { id: 90_000 + Math.floor(Math.random() * 1000), reused: false };
    if (cmd === 'move_folders') {
      for (const [id, parent] of a.moves as [number, number | null][]) await this.call('move_folder', { id, parent });
      return { done: (a.moves as unknown[]).length, error: null };
    }
    if (cmd === 'delete_folders' || cmd === 'restore_folders') {
      let n = 0;
      for (const id of a.ids as number[]) n += Number((await this.call(cmd.slice(0, -1), { id })) ?? 0);
      return n;
    }
    await new Promise((r) => setTimeout(r, cmd.startsWith('unlock') || cmd === 'create_vault' ? 600 : 50));
    // Preview with sample folders, people and tags: open the page with ?demo.
    if (typeof location !== 'undefined' && /[?&]demo\b/.test(location.search)) {
      const { demoCall, NOT_DEMO } = await import('./mockdemo');
      const d = demoCall(cmd, a);
      if (d !== NOT_DEMO) return d;
    }
    const demo = (await import('./mockgrid')).demoAnswer(cmd, a);
    if (demo !== undefined) return demo;
    // Face recognition with made-up people (People page, Settings).
    const faces = (await import('./mockfaces')).facesAnswer(cmd, a);
    if (faces !== undefined) return faces;
    // A person's faces cut out (face wall, Best faces, time-lapse).
    const crops = await (await import('./mockfacecrops')).cropsAnswer(cmd, a, (person) => this.call('query_items', { filter: { people: [person] } }) as Promise<Item[]>);
    if (crops !== undefined) return crops;
    const s = this.state;
    const passwordless = (path: string) => !!s.vaults.find((v) => v.path === path)?.passwordless;
    const session = (path: string, needsNewPassword = false): SessionInfo => ({
      path,
      name: path.split('\\').pop() ?? path,
      items: 0,
      folders: 0,
      needsNewPassword,
      hasPassword: !passwordless(path),
      encrypted: s.vaults.find((v) => v.path === path)?.encrypted !== false,
      converting: null,
      restoredFromBackup: null,
    });
    const setPasswordless = (on: boolean) => {
      const v = s.vaults.find((x) => x.path === s.session?.path);
      if (v) v.passwordless = on;
      s.session = { ...s.session!, hasPassword: !on };
      return s.session;
    };
    switch (cmd) {
      case 'get_state':
        return structuredClone(s);
      case 'vault_sizes':
        return s.vaults.map((v) => ({ path: v.path, sizeBytes: v.sizeBytes }));
      case 'save_config':
        s.config = { ...(a.config as AppConfig), vaults: s.config.vaults, lastVault: s.config.lastVault };
        return s.config;
      case 'unlock':
        if (a.password !== 'password') throw new Error("That password doesn't match this vault. (Preview: use “password”.)");
        return (s.session = session(a.path as string));
      case 'open_vault':
        if (!passwordless(a.path as string)) throw new Error('This vault has a password.');
        return (s.session = session(a.path as string));
      case 'turn_password_off':
        if (a.current !== 'password') throw new Error('Your current password is not correct. (Preview: use “password”.)');
        return setPasswordless(true);
      case 'set_password':
        return setPasswordless(false);
      case 'unlock_with_recovery':
        return (s.session = session(a.path as string, !passwordless(a.path as string)));
      case 'set_new_password':
        s.session = { ...s.session!, needsNewPassword: false };
        return s.session;
      case 'create_vault': {
        const path = `${a.parent}\\${a.name}`;
        const plain = a.encrypt === false;
        s.vaults.push({ path, name: a.name as string, status: 'ready', sizeBytes: 4096, passwordless: plain || a.password == null, encrypted: !plain });
        return { session: (s.session = session(path)), words: plain ? [] : WORDS };
      }
      case 'encryption_off':
      case 'encryption_on': {
        const to = cmd === 'encryption_off' ? 'plain' : 'encrypted';
        if (to === 'plain' && s.session?.hasPassword && a.current !== 'password') throw new Error('Your current password is not correct. (Preview: use “password”.)');
        const v = s.vaults.find((x) => x.path === s.session?.path);
        s.session = { ...s.session!, converting: to };
        // Preview: about three seconds of progress.
        let done = 0;
        const t = setInterval(() => {
          done += 7;
          mockEmit('encryption-progress', { to, done: Math.min(done, 40), total: 40 });
          if (done >= 40) {
            clearInterval(t);
            if (v) {
              v.encrypted = to === 'encrypted';
              v.passwordless = to === 'plain' || a.password == null;
            }
            s.session = { ...s.session!, converting: null, encrypted: to === 'encrypted', hasPassword: to === 'encrypted' && a.password != null };
            mockEmit('encryption-done', { to, ok: true, stopped: false, message: to === 'plain' ? 'The vault isn’t encrypted any more: your files are ordinary files in its Files folder.' : 'The vault is encrypted now.' });
          }
        }, 500);
        return to === 'plain' ? s.session : { session: s.session, words: WORDS };
      }
      case 'encryption_continue':
        return false;
      case 'encryption_stop':
        return;
      case 'encryption_running':
        return false;
      case 'open_files_folder':
        return;
      case 'reset_recovery':
        return WORDS;
      case 'lock_vault':
        s.session = null;
        this.lockListeners.forEach((l) => l('manual'));
        return;
      case 'forget_vault':
        s.vaults = s.vaults.filter((v) => v.path !== a.path);
        return;
      case 'add_vault':
        throw new Error('Preview: adding vaults works in the real app.');
      case 'beats_supported':
        // Preview: add ?beatdemo to the address to see the beat sync controls.
        return typeof location !== 'undefined' && new URLSearchParams(location.search).has('beatdemo');
      case 'beats_status':
        return { state: 'listening', device: 'Speakers (Preview Audio)', format: '48 kHz · stereo · 32-bit float', error: null, receiving: true, volume: 0.62, muted: false, log: ['Listening to Speakers (Preview Audio) (48 kHz · stereo · 32-bit float)', 'Sound is coming in'] } satisfies BeatStatus;
      case 'upscale_info':
        return { available: true, problem: null, folder: 'C:\\MediaVault\\tools\\upscaler', device: 'gpu', deviceKnown: false } satisfies UpscalerInfo;
      case 'upscale_start':
        return mockUpscale(a.request as UpscaleRequest);
      case 'depth_info':
        return mockDepthInfo(String(a.model ?? ''), a.detail === 'high' ? 'high' : 'standard');
      case 'depth_models':
        return mockDepthModels();
      case 'depth_benchmark': {
        // Preview: a pretend speed test (Best is slowest, high detail about twice as slow).
        await new Promise((r) => setTimeout(r, 900));
        const base = a.id === 'da3-mono-large' ? 310 : a.id === 'da3-base' ? 120 : 45;
        const dyn = a.id !== 'v2-small';
        return { ms: base * (dyn && a.detail === 'high' ? 2.1 : 1), device: 'gpu', loadMs: 800, side: dyn && a.detail === 'high' ? 756 : 518 } satisfies DepthBenchmark;
      }
      case 'depth_forget':
        return;
      case 'subject_info':
        return mockSubjectInfo(String(a.model ?? ''));
      case 'subject_models':
        return mockSubjectModels();
      case 'subject_benchmark': {
        // Preview: a pretend speed test (Best is slower).
        await new Promise((r) => setTimeout(r, 900));
        return { ms: a.id === 'birefnet' ? 420 : 140, device: 'gpu', loadMs: 900, side: 1024 } satisfies SubjectBenchmark;
      }
      case 'subject_forget':
        return;
      case 'inpaint_models':
        return mockInpaintModels();
      case 'inpaint_info':
        return mockInpaintInfo(String(a.model ?? ''));
      case 'inpaint_benchmark':
        await new Promise((r) => setTimeout(r, 900));
        return { ms: a.id === 'lama' ? 260 : 60, device: 'gpu', loadMs: 600, side: 512 } satisfies InpaintBenchmark;
      case 'inpaint_forget':
        return;
      case 'derived_put': {
        const b = a.data as Uint8Array;
        mockDerived.set(`${a.item}|${a.kind}|${a.model}`, b.slice());
        return;
      }
      case 'derived_get':
        return mockDerived.get(`${a.item}|${a.kind}|${a.model}`) ?? new Uint8Array(0);
      case 'derived_clear': {
        let n = 0;
        for (const k of [...mockDerived.keys()]) if (!a.kind || k.split('|')[1] === a.kind) {
          mockDerived.delete(k);
          n++;
        }
        return n;
      }
      case 'derived_have': {
        const out: number[] = [];
        for (const k of mockDerived.keys()) {
          const [item, kind, model] = k.split('|');
          if (kind === a.kind && model === a.model) out.push(Number(item));
        }
        return out;
      }
      case 'faces_split': {
        // Demo: every third picture has faces, every third has none, a few only poor ones, the rest unscanned.
        const sp: FaceSplit = { withFaces: [], noFaces: [], onlyPoor: [], unscanned: [] };
        for (const id of (a.items as number[]) ?? []) {
          const r = id % 6;
          (r < 2 ? sp.withFaces : r < 4 ? sp.noFaces : r === 4 ? sp.onlyPoor : sp.unscanned).push(id);
        }
        return sp;
      }
      case 'derived_summary': {
        const want = new Set((a.items as number[]) ?? []);
        const acc = new Map<string, DerivedGroup>();
        for (const [k, v] of mockDerived) {
          const [item, kind, model] = k.split('|');
          if (!want.has(Number(item))) continue;
          const g = acc.get(`${kind}|${model}`) ?? { kind: kind as DerivedKind, model, count: 0, bytes: 0 };
          g.count++;
          g.bytes += v.length;
          acc.set(`${kind}|${model}`, g);
        }
        return [...acc.values()].sort((x, y) => (x.kind === y.kind ? x.model.localeCompare(y.model) : x.kind === 'depth' ? -1 : 1));
      }
      case 'derived_remove': {
        const want = new Set((a.items as number[]) ?? []);
        const which = new Set(((a.which as [string, string][]) ?? []).map(([k, m]) => `${k}|${m}`));
        let n = 0;
        for (const k of [...mockDerived.keys()]) {
          const [item, kind, model] = k.split('|');
          if (want.has(Number(item)) && which.has(`${kind}|${model}`)) {
            mockDerived.delete(k);
            n++;
          }
        }
        return n;
      }
      case 'derived_stats': {
        const st: DerivedStats = { depthCount: 0, depthBytes: 0, outlineCount: 0, outlineBytes: 0 };
        for (const [k, v] of mockDerived) {
          if (k.split('|')[1] === 'depth') {
            st.depthCount++;
            st.depthBytes += v.length;
          } else {
            st.outlineCount++;
            st.outlineBytes += v.length;
          }
        }
        return st;
      }
      case 'upscale_cancel':
        mockJob += 1;
        return;
      case 'upscale_save':
        return { id: 999, name: 'Picture (upscaled).jpg' } satisfies UpscaleSaved;
      case 'rotate_picture':
      case 'rotate_replace':
      case 'rotate_video':
        throw new Error('Preview: saving the rotation works in the real app.');
      case 'rotate_undo':
        return;
      case 'library_folders':
      case 'query_items':
      case 'all_tags':
      case 'list_named':
      case 'thumbs_needed':
        return [];
      case 'storage_info':
        return { files: 14, totalBytes: 3.2e9, packFiles: 4, reclaimableBytes: 0, looseObjects: 0 };
      case 'trash_view':
        return { folders: [], items: [], totalItems: 0, totalBytes: 0 };
      case 'library_stats':
        return { items: 0, bytes: 0, folders: 0, tags: 0, favourites: 0, neverViewed: 0, totalViews: 0, trashItems: 0, trashBytes: 0, byKind: [], byFolder: [], byMonth: [], mostViewed: [] };
      case 'bookmarks':
      case 'folder_samples':
      case 'faces_needed':
      case 'clip_needed':
      case 'similar_needed':
      case 'faces_of':
      case 'river_faces':
      case 'smart_search':
        return [];
      case 'engine_info':
        return { mode: 'system', available: false, version: null };
      case 'faces_status':
        return { queued: 0, scanned: 0, faces: 0, failed: 0 };
      case 'faces_review':
        return { people: [], unknown: [], status: { queued: 0, scanned: 0, faces: 0, failed: 0 } };
      case 'make_tiny_with_tool':
        return false;
      case 'previews_needed':
      case 'thumbs_to_sharpen':
        return [];
      case 'thumbs_to_webp':
        return { tasks: [], next: Number(a.upto ?? 0) };
      case 'newest_item_id':
      case 'count_to_sharpen':
      case 'faces_left':
        return 0;
      case 'ui_get':
        return null;
      case 'data_info':
        return { faces: 0, faceBytes: 0, clipItems: 0, clipBytes: 0, backups: mockBackups.length, backupBytes: mockBackups.reduce((n, b) => n + b.bytes, 0), libraryBytes: 0 };
      case 'library_backups':
        return [...mockBackups].reverse();
      case 'restore_library_backup': {
        // The library now becomes the newest backup; only 5 are kept.
        if (!mockBackups.some((b) => b.name === a.name)) throw new Error("That backup isn't there any more.");
        const at = Date.now();
        mockBackups.push({ name: `meta-${String(at).padStart(15, '0')}.db.enc`, atMs: at, bytes: 412_000 });
        while (mockBackups.length > 5) mockBackups.shift();
        return null;
      }
      case 'cache_info':
        return { thumbs: 0, thumbBytes: 0, previews: 0, previewBytes: 0 };
      case 'clip_status':
        return { total: 0, done: 0, failed: 0 };
      case 'smart_engine':
        return { models: true, native: true, device: 'gpu', deviceKnown: false, problem: null } satisfies SmartEngine;
      case 'analyse_start':
      case 'analyse_status':
        return { running: false, busy: false, done: 0, thumbs: 0, prints: 0, smart: 0, faces: 0, left: 0, facesLeft: 0 } satisfies AnalyseStatus;
      case 'analyse_thumb':
        return false;
      case 'folder_view':
        return { folder: null, subfolders: [], items: [] };
      case 'faces_off_folders':
        return [];
      case 'faces_folder_off':
      case 'faces_stop':
      case 'faces_delete_folder':
      case 'faces_delete_items':
        return 0;
      default:
        return;
    }
  },
};

/** A believable two-year history for the browser preview. */
export function mockGrowth(): Growth {
  const months: GrowthMonth[] = [];
  const d = new Date();
  let ti = 0;
  let tb = 0;
  for (let k = 25; k >= 0; k--) {
    const at = new Date(d.getFullYear(), d.getMonth() - k, 1);
    const wave = Math.sin(k * 1.7) * 0.5 + 0.5;
    const items = k === 9 ? 0 : Math.round(40 + wave * 260 + (k % 5 === 0 ? 900 : 0));
    const bytes = Math.round(items * (2.1e6 + wave * 6e6));
    ti += items;
    tb += bytes;
    months.push({ month: `${at.getFullYear()}-${String(at.getMonth() + 1).padStart(2, '0')}`, items, bytes, totalItems: ti, totalBytes: tb });
  }
  const last = months[months.length - 1];
  return { months, totalItems: ti, totalBytes: tb, last30Items: last.items, last30Bytes: last.bytes, trashItems: 37, trashBytes: 412e6 };
}

/** Preview: Fast and Best installed (add ?nodepth to see none installed). */
export function mockDepthModels(): DepthModel[] {
  const none = typeof location !== 'undefined' && new URLSearchParams(location.search).has('nodepth');
  const root = 'C:\\MediaVault\\tools\\';
  return [
    { id: 'v2-small', name: 'Fast', model: 'Depth Anything V2 Small', folder: `${root}depth`, installed: !none, problem: none ? 'Not installed: get MediaVault-depth-windows.zip from the Releases page and unzip it next to the app.' : null, sizeBytes: none ? 0 : 99_000_000, dynamic: false, zip: 'MediaVault-depth-windows.zip', standardSide: 518, highSide: 518, licence: 'Apache-2.0' },
    { id: 'v2-small-fp16', name: 'Fast (half precision)', model: 'Depth Anything V2 Small (fp16)', folder: `${root}depth-v2-small-fp16`, installed: !none, problem: none ? 'Not installed: get MediaVault-depth-v2-small-fp16-windows.zip from the Releases page and unzip it next to the app.' : null, sizeBytes: none ? 0 : 50_000_000, dynamic: false, zip: 'MediaVault-depth-v2-small-fp16-windows.zip', standardSide: 518, highSide: 518, licence: 'Apache-2.0' },
    { id: 'da3-mono-large', name: 'Best', model: 'Depth Anything 3 Mono Large', folder: `${root}depth-da3-mono-large`, installed: !none, problem: none ? 'Not installed: get MediaVault-depth-da3-mono-large-windows.zip from the Releases page and unzip it next to the app.' : null, sizeBytes: none ? 0 : 1_350_000_000, dynamic: false, zip: 'MediaVault-depth-da3-mono-large-windows.zip', standardSide: 518, highSide: 518, licence: 'Apache-2.0' },
  ];
}

export function mockDepthInfo(model: string, detail: DepthDetail): DepthInfo {
  const ready = mockDepthModels().filter((m) => m.installed && !m.problem);
  const pick = ready.find((m) => m.id === model) ?? ['da3-mono-large', 'v2-small'].map((id) => ready.find((m) => m.id === id)).find(Boolean);
  if (!pick) return { available: false, problem: "The depth pack isn't installed.", folder: 'C:\\MediaVault\\tools\\depth', device: null, deviceKnown: false, sharedRuntime: false, model: null, modelName: null, inputSide: 518, detail: 'standard', dynamic: false };
  const d = pick.dynamic ? detail : 'standard';
  return { available: true, problem: null, folder: pick.folder, device: 'gpu', deviceKnown: false, sharedRuntime: false, model: pick.id, modelName: pick.name, inputSide: d === 'high' ? pick.highSide ?? 518 : pick.standardSide ?? 518, detail: d, dynamic: pick.dynamic };
}

/** Preview: a pretend depth map (nearer towards the bottom and the middle). Tests can supply real ones via `__mvDepthMock`. */
export async function mockDepth(w: number, h: number, rgba: Uint8Array): Promise<DepthMap> {
  const hook = (globalThis as { __mvDepthMock?: (w: number, h: number, rgba: Uint8Array) => Promise<DepthMap | null> }).__mvDepthMock;
  const real = hook ? await hook(w, h, rgba) : null;
  if (real) return real;
  await new Promise((r) => setTimeout(r, 150));
  const data = new Uint8Array(w * h);
  for (let y = 0; y < h; y++)
    for (let x = 0; x < w; x++) {
      const dx = x / w - 0.5;
      const dy = y / h - 0.55;
      const blob = Math.max(0, 1 - Math.hypot(dx * 1.6, dy * 1.2) * 2.2);
      data[y * w + x] = Math.round(255 * Math.min(1, 0.15 + 0.45 * (y / h) + 0.5 * blob));
    }
  return { w, h, data };
}

/** Preview: Fast and Best installed (add ?nosubject to see none installed). */
export function mockSubjectModels(): SubjectModel[] {
  const none = typeof location !== 'undefined' && new URLSearchParams(location.search).has('nosubject');
  const root = 'C:\\MediaVault\\tools\\';
  return [
    { id: 'birefnet-lite', name: 'Fast', model: 'BiRefNet Lite', folder: `${root}subject-birefnet-lite`, installed: !none, problem: none ? 'Not installed: get MediaVault-subject-birefnet-lite-windows.zip from the Releases page and unzip it next to the app.' : null, sizeBytes: none ? 0 : 180_000_000, zip: 'MediaVault-subject-birefnet-lite-windows.zip', inputSide: 1024, licence: 'MIT' },
    { id: 'birefnet', name: 'Best', model: 'BiRefNet', folder: `${root}subject-birefnet`, installed: !none, problem: none ? 'Not installed: get MediaVault-subject-birefnet-windows.zip from the Releases page and unzip it next to the app.' : null, sizeBytes: none ? 0 : 900_000_000, zip: 'MediaVault-subject-birefnet-windows.zip', inputSide: 1024, licence: 'MIT' },
  ];
}

export function mockSubjectInfo(model: string): SubjectInfo {
  const ready = mockSubjectModels().filter((m) => m.installed && !m.problem);
  const pick = ready.find((m) => m.id === model) ?? ['birefnet', 'birefnet-lite'].map((id) => ready.find((m) => m.id === id)).find(Boolean);
  if (!pick) return { available: false, problem: "The subject pack isn't installed.", folder: 'C:\\MediaVault\\tools\\subject-birefnet', device: null, deviceKnown: false, model: null, modelName: null, inputSide: 1024 };
  return { available: true, problem: null, folder: pick.folder, device: 'gpu', deviceKnown: false, model: pick.id, modelName: pick.name, inputSide: pick.inputSide ?? 1024 };
}

/** Preview: a pretend subject outline (a soft-edged rounded shape in the middle). Tests can supply real ones via `__mvSubjectMock`. */
export async function mockSubject(w: number, h: number, rgba: Uint8Array): Promise<SubjectMask> {
  const hook = (globalThis as { __mvSubjectMock?: (w: number, h: number, rgba: Uint8Array) => Promise<SubjectMask | null> }).__mvSubjectMock;
  const real = hook ? await hook(w, h, rgba) : null;
  if (real) return real;
  await new Promise((r) => setTimeout(r, 150));
  const data = new Uint8Array(w * h);
  for (let y = 0; y < h; y++)
    for (let x = 0; x < w; x++) {
      // A head-and-shoulders shape: a body ellipse with a smaller head on top.
      const u = x / w - 0.5;
      const v = y / h;
      const body = Math.hypot(u / 0.26, (v - 0.82) / 0.32);
      const head = Math.hypot(u / 0.13, (v - 0.38) / 0.16);
      const d = Math.min(body, head);
      data[y * w + x] = Math.round(255 * Math.min(1, Math.max(0, (1 - d) * 25)));
    }
  return { w, h, data };
}

export const mockUpscaleListeners = new Set<UpscaleListener>();

export let mockJob = 0;

export function mockUpscale(r: UpscaleRequest): number {
  const job = ++mockJob;
  let f = 0;
  const t = setInterval(() => {
    if (job !== mockJob) {
      clearInterval(t);
      mockUpscaleListeners.forEach((l) => l.done({ job, token: null, width: 0, height: 0, factor: 4, faces: 0, device: null, cancelled: true, error: null }));
      return;
    }
    f = Math.min(1, f + 0.08);
    mockUpscaleListeners.forEach((l) => l.progress({ job, fraction: f, stage: f < 0.75 || r.model === 'realesrgan' ? 'picture' : 'faces' }));
    if (f >= 1) {
      clearInterval(t);
      mockUpscaleListeners.forEach((l) => l.done({ job, token: 0, width: r.width * 4, height: r.height * 4, factor: 4, faces: r.faces.length, device: 'gpu', cancelled: false, error: null }));
    }
  }, 150);
  return job;
}

/** Preview: MI-GAN installed, LaMa not (add ?noinpaint to see neither). */
export function mockInpaintModels(): InpaintModel[] {
  const none = typeof location !== 'undefined' && new URLSearchParams(location.search).has('noinpaint');
  const root = 'C:\\MediaVault\\tools\\';
  return [
    { id: 'migan', name: 'MI-GAN', model: 'MI-GAN (Places2)', folder: `${root}inpaint-migan`, installed: !none, problem: none ? 'Not installed: get MediaVault-inpaint-migan-windows.zip from the Releases page and unzip it next to the app.' : null, sizeBytes: none ? 0 : 30_000_000, zip: 'MediaVault-inpaint-migan-windows.zip', inputSide: 512, licence: 'MIT' },
    { id: 'lama', name: 'LaMa', model: 'Big LaMa', folder: `${root}inpaint-lama`, installed: false, problem: 'Not installed: get MediaVault-inpaint-lama-windows.zip from the Releases page and unzip it next to the app.', sizeBytes: 0, zip: 'MediaVault-inpaint-lama-windows.zip', inputSide: 512, licence: 'Apache-2.0' },
  ];
}

export function mockInpaintInfo(model: string): InpaintInfo {
  const ready = mockInpaintModels().filter((m) => m.installed && !m.problem);
  const pick = ready.find((m) => m.id === model) ?? (model ? undefined : ready[0]);
  if (!pick) return { available: false, problem: "The background fill pack isn't installed.", folder: null, device: null, deviceKnown: false, model: null, modelName: null, inputSide: 512 };
  return { available: true, problem: null, folder: pick.folder, device: 'gpu', deviceKnown: false, model: pick.id, modelName: pick.name, inputSide: pick.inputSide ?? 512 };
}

/** Preview: a pretend fill (the surrounding colours pulled in, like Simple). Tests can supply their own via `__mvInpaintMock`. */
export async function mockInpaint(r: InpaintRequest, rgba: Uint8Array, mask: Uint8Array): Promise<Rgba> {
  const hook = (globalThis as { __mvInpaintMock?: (w: number, h: number, rgba: Uint8Array, mask: Uint8Array) => Promise<Rgba | null> }).__mvInpaintMock;
  const real = hook ? await hook(r.width, r.height, rgba, mask) : null;
  if (real) return real;
  await new Promise((ok) => setTimeout(ok, 250));
  const { fillRgba } = await import('./layers');
  const hole = new Float32Array(mask.length);
  for (let i = 0; i < mask.length; i++) hole[i] = mask[i] / 255;
  return { w: r.width, h: r.height, data: fillRgba(rgba, r.width, r.height, hole) };
}

/** Preview: saved maps live in memory for the session. */
// Shared on the window so tests that load this module again see the same saved maps (browser demo only).
export const mockDerived: Map<string, Uint8Array> = ((globalThis as { __mvDerived?: Map<string, Uint8Array> }).__mvDerived ??= new Map());
