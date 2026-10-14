// Browser preview only (no Tauri): made-up people for the People page and
// Settings when the address has `?people`. Thumbnails come from whatever
// serves vault.localhost (the UI check answers `thumb/<id>` with photo
// `id % 24`; the face boxes below match those photos). Never used in the app.

import type { FaceEngineStatus, FaceReview, FolderCard, Item, OwnerProposal, PersonGroup, Suggestion, UnknownGroup } from './api';

const on = () => typeof location !== 'undefined' && /[?&]people\b/.test(location.search);

/** Per photo (id % 24): face boxes [x, y, w, h] and who it is. */
const PHOTOS: [number, number, [number, number, number, number, string][]][] = [
  [970, 2204, [[0.434, 0.072, 0.294, 0.183, 'ayse']]],
  [1200, 1200, [[0.353, 0.092, 0.37, 0.564, 'ayse']]],
  [1920, 1280, [[0.217, 0.279, 0.096, 0.188, 'x1'], [0.433, 0.339, 0.104, 0.174, 'c2'], [0.761, 0.162, 0.123, 0.181, 'c1']]],
  [1920, 1367, [[0.748, 0.121, 0.114, 0.164, 'x2'], [0.47, 0.176, 0.09, 0.156, 'x3'], [0.189, 0.095, 0.087, 0.214, 'x4']]],
  [1920, 1350, [[0.309, 0.24, 0.105, 0.206, 'x5'], [0.771, 0.213, 0.109, 0.215, 'x6'], [0.558, 0.152, 0.116, 0.229, 'c1']]],
  [1920, 1448, [[0.514, 0.122, 0.094, 0.166, 'x7'], [0.341, 0.04, 0.101, 0.172, 'c3'], [0.665, 0.103, 0.082, 0.166, 'x8'], [0.128, 0.13, 0.094, 0.172, 'c2']]],
  [1920, 1398, [[0.406, 0.081, 0.089, 0.156, 'x9'], [0.579, 0.138, 0.092, 0.177, 'x10'], [0.733, 0.289, 0.099, 0.19, 'x11'], [0.311, 0.294, 0.09, 0.19, 'x12'], [0.195, 0.626, 0.101, 0.212, 'x13']]],
  [1920, 1537, [[0.133, 0.309, 0.11, 0.184, 'x14'], [0.348, 0.211, 0.1, 0.201, 'x15'], [0.613, 0.196, 0.102, 0.184, 'c3'], [0.77, 0.163, 0.116, 0.197, 'x16']]],
  [424, 394, [[0.416, 0.247, 0.354, 0.577, 'alex']]],
  [704, 612, [[0.365, 0.173, 0.387, 0.65, 'lin']]],
  [1280, 720, [[0.458, 0.069, 0.123, 0.326, 'baran']]],
  [320, 240, [[0.333, 0.159, 0.336, 0.657, 'baran']]],
  [1126, 661, [[0.7, 0.054, 0.135, 0.329, 'ayse'], [0.209, 0.029, 0.134, 0.311, 'baran']]],
  [1280, 886, [[0.364, 0.303, 0.084, 0.166, 'x17'], [0.582, 0.382, 0.078, 0.158, 'x18'], [0.21, 0.164, 0.081, 0.137, 'x19']]],
  [1200, 599, [[0.573, 0.129, 0.1, 0.266, 'mehmet']]],
  [630, 374, [[0.506, 0.151, 0.255, 0.603, 'mehmet']]],
  [910, 1137, [[0.412, 0.072, 0.256, 0.308, 'baran']]],
  [626, 1200, [[0.326, 0.191, 0.426, 0.341, 'baran']]],
  [1280, 799, [[0.493, 0.086, 0.189, 0.396, 'rose']]],
  [577, 880, [[0.309, 0.126, 0.405, 0.4, 'rose']]],
  [1548, 1024, [[0.418, 0.089, 0.186, 0.458, 'alex']]],
  [768, 1154, [[0.343, 0.116, 0.226, 0.203, 'mehmet']]],
  [1480, 832, [[0.36, 0.154, 0.247, 0.622, 'baran']]],
  [2000, 1428, [[0.571, 0.246, 0.095, 0.182, 'baran'], [0.38, 0.266, 0.091, 0.189, 'ayse']]],
];

const FOLDERS: { id: number; name: string; person: boolean; cover: number }[] = [
  { id: 1, name: 'Baran', person: true, cover: 16 },
  { id: 2, name: 'Ayşe', person: true, cover: 1 },
  { id: 3, name: 'Mehmet', person: true, cover: 14 },
  { id: 4, name: 'Ayse (phone)', person: true, cover: 0 },
  { id: 5, name: 'Holiday 2024', person: false, cover: 6 },
];

function item(id: number): Item {
  const [w, h] = PHOTOS[id % 24];
  return {
    id, kind: 'image', name: `IMG_${String(4000 + id)}.jpg`, ext: 'jpg', size: 2_400_000, width: w, height: h, durationMs: null, favourite: false, weight: 1,
    thumb: 'ok', importedAt: 1_760_000_000 - id * 3600, folderId: null, takenAt: 1_760_000_000 - id * 3600, views: 0, deletedAt: null, preview: false,
    copyOf: null, linked: false, note: null, resumeMs: null,
  };
}

/** Every face of `who` in the photo table, repeated `times` over (different ids, same photos). */
function facesOf(who: string, times = 1, sure = (k: number) => k % 3 !== 2, conf = 0): Suggestion[] {
  const out: Suggestion[] = [];
  for (let r = 0; r < times; r++) {
    PHOTOS.forEach(([, , faces], p) => faces.forEach(([x, y, w, h, name], f) => {
      if (name !== who) return;
      const id = p + 24 * r;
      const k = out.length;
      out.push({ faceId: id * 10 + f, item: item(id), frameMs: 0, x, y, w, h, confidence: conf || 92 - ((k * 7) % 45), sure: sure(k) });
    }));
  }
  return out;
}

const state = {
  hidden: new Set<string>(['x13', 'x16']),
  gone: new Set<number>(),
  merged: false,
};

function group(who: string, photos: number, looksLike: UnknownGroup['looksLike'] = null): UnknownGroup {
  const samples = facesOf(who, 3);
  return { key: samples[0]?.faceId ?? 0, faceIds: samples.map((s) => s.faceId), samples, photos, looksLike };
}

function review(): FaceReview {
  const live = (l: Suggestion[]) => l.filter((s) => !state.gone.has(s.faceId));
  const people: PersonGroup[] = [
    {
      person: { folder: 1, name: 'Baran', known: 0, unsure: 0, recognised: 0, photos: 46 },
      suggestions: [], suggestionsTotal: 0, recent: [], recentTotal: 0,
      owner: state.gone.has(160) ? null : { photos: 46, samples: facesOf('baran').slice(0, 3) },
    },
    {
      person: { folder: 2, name: 'Ayşe', known: 24, unsure: 0, recognised: 120, photos: 168 },
      suggestions: live(facesOf('ayse', 3)), suggestionsTotal: 31,
      recent: live(facesOf('ayse', 4, () => true, 90)).slice(0, 12), recentTotal: 120, owner: null,
    },
    {
      person: { folder: 3, name: 'Mehmet', known: 8, unsure: 0, recognised: 3, photos: 23 },
      suggestions: [], suggestionsTotal: 0, recent: live(facesOf('mehmet', 1, () => true, 90)), recentTotal: 3, owner: null,
    },
  ];
  if (!state.merged) people.splice(2, 0, { person: { folder: 4, name: 'Ayse (phone)', known: 3, unsure: 0, recognised: 0, photos: 12 }, suggestions: [], suggestionsTotal: 0, recent: [], recentTotal: 0, owner: null });
  const unknown = [
    group('rose', 312), group('alex', 88), group('c1', 41, { folder: 3, name: 'Mehmet', confidence: 52 }), group('c2', 12), group('c3', 9),
    group('lin', 5), group('x1', 3),
  ].filter((g) => !g.faceIds.some((f) => state.gone.has(f)));
  const hidden = [...state.hidden].map((w) => group(w, 4));
  return {
    people, unknown: unknown.filter((g) => !g.samples.some((s) => state.hidden.has(whoOf(s)))), unknownTotal: 31, hidden,
    merges: state.merged ? [] : [{ a: 2, aName: 'Ayşe', b: 4, bName: 'Ayse (phone)', confidence: 88 }],
    status: { queued: 1240, scanned: 3760, faces: 9210, failed: 2 },
    engine: engine(),
  };
}

function whoOf(s: Suggestion) {
  const p = PHOTOS[s.item.id % 24][2];
  return p[s.faceId % 10]?.[4] ?? '';
}

function engine(): FaceEngineStatus {
  return {
    native: { available: true, problem: null, folder: 'C:\\MediaVault\\tools\\faces', device: 'gpu', deviceKnown: true, sharedRuntime: false },
    active: 'buffalo_l', upgradeLeft: 1240, upgraded: 3760,
  };
}

function card(f: (typeof FOLDERS)[number]): FolderCard {
  const face = PHOTOS[f.cover % 24][2][0];
  return {
    id: f.id, name: f.name, parentId: null, path: [], depth: 0, items: 40, directItems: 40, subfolders: 0, cover: f.cover, coverKind: 'image', tags: [],
    pinned: false, color: null, emoji: null, person: f.person, samples: [f.cover], note: null, createdAt: 1_700_000_000, bytes: 9e7,
    coverFace: f.person ? [face[0], face[1], face[2], face[3]] : null,
  } as FolderCard;
}

/** An answer for the preview, or undefined to let the normal mock answer. */
export function facesAnswer(cmd: string, a: Record<string, unknown>): unknown {
  if (!on()) return undefined;
  switch (cmd) {
    case 'library_folders':
      return FOLDERS.map(card);
    case 'faces_review':
      return review();
    case 'faces_engine':
      return engine();
    case 'faces_status':
      return review().status;
    case 'faces_find_owner': {
      const faces = facesOf('baran', 6, () => true, 0).map((s, k) => ({ ...s, confidence: 95 - ((k * 3) % 30) }));
      return { person: a.person as number, name: 'Baran', faces } satisfies OwnerProposal;
    }
    case 'faces_accept':
    case 'faces_reject':
      (a.faceIds as number[]).forEach((f) => state.gone.add(f));
      if ((a.faceIds as number[]).some((f) => Math.floor(f / 10) % 24 === 16)) state.gone.add(160);
      return { named: (a.faceIds as number[]).length, moved: 0, tagged: 0 };
    case 'faces_hide': {
      const ids = a.faceIds as number[];
      const s = review().unknown.concat(review().hidden ?? []).find((g) => g.faceIds.includes(ids[0]));
      const who = s?.samples[0] ? whoOf(s.samples[0]) : '';
      if (a.hidden) state.hidden.add(who);
      else state.hidden.delete(who);
      return ids.length;
    }
    case 'faces_merge_people':
    case 'faces_not_same':
      state.merged = true;
      return 0;
    case 'faces_new_person':
      (a.faceIds as number[]).forEach((f) => state.gone.add(f));
      return { folder: 99, accepted: { named: (a.faceIds as number[]).length, moved: 0, tagged: 0 } };
    case 'faces_auto':
    case 'faces_upgrade':
      return 0;
    case 'query_items':
      return Array.from({ length: 60 }, (_, i) => item(i));
    default:
      return undefined;
  }
}
