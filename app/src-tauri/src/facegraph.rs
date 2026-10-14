//! Who looks like whom: the maths behind the People page, on face
//! fingerprints only (no library, no pictures), so it can be tested alone.
//!
//! All faces of one model are kept in memory with their closest look-alikes
//! (a neighbour graph, updated as faces come and go, so thousands of faces
//! stay quick). From it, and from what you confirmed:
//!  - faces very much like a known person are named automatically,
//!  - less certain ones are suggested,
//!  - the rest are grouped into unknown people (Chinese whispers),
//!  - a person folder's owner is found among the photos in it,
//!  - two people who look the same are offered for merging.

use std::collections::{HashMap, HashSet};

use crate::faceid_math::dot;

/// How alike is alike enough, per face model. Higher similarity = more alike.
#[derive(Debug, Clone, Copy, PartialEq)]
pub struct Metric {
    pub model: i64,
    /// Named automatically at or above this (and clearly better than anyone
    /// else); None = never automatically.
    pub auto: Option<f32>,
    pub auto_margin: f32,
    /// Suggested ticked.
    pub sure: f32,
    /// Suggested at all.
    pub maybe: f32,
    /// Grouped together as one unknown person.
    pub cluster: f32,
    /// Look-alikes closer than this are remembered (the graph's floor).
    pub link: f32,
    /// Two people (their average faces) this alike: "merge?"
    pub merge: f32,
    /// An unknown group this like a person: "Is this X?"
    pub hint: f32,
}

/// InsightFace buffalo_l (cosine similarity of unit fingerprints). Chosen
/// from real photos: the same person scores 0.5–0.99, different people
/// stayed below 0.32.
pub const ARCFACE: Metric = Metric { model: 1, auto: Some(0.55), auto_margin: 0.12, sure: 0.45, maybe: 0.34, cluster: 0.42, link: 0.28, merge: 0.5, hint: 0.4 };

/// The built-in face-api (128 numbers; 1 − distance, so the old limits
/// stay: sure < 0.45, maybe < 0.55, group < 0.5). Never names on its own.
pub const FACEAPI: Metric = Metric { model: 0, auto: None, auto_margin: 0.0, sure: 0.55, maybe: 0.45, cluster: 0.5, link: 0.4, merge: 0.62, hint: 0.52 };

pub fn metric(model: i64) -> Metric {
    if model == ARCFACE.model { ARCFACE } else { FACEAPI }
}

/// Fingerprint length per model.
pub fn dim(model: i64) -> usize {
    if model == ARCFACE.model { crate::faceid_math::DIM } else { crate::faces::DIM }
}

pub fn similarity(model: i64, a: &[f32], b: &[f32]) -> f32 {
    if model == ARCFACE.model {
        dot(a, b)
    } else {
        let mut acc = [0.0f32; 8];
        let ca = a.chunks_exact(8);
        let cb = b.chunks_exact(8);
        let (ra, rb) = (ca.remainder(), cb.remainder());
        for (x, y) in ca.zip(cb) {
            for k in 0..8 {
                let d = x[k] - y[k];
                acc[k] += d * d;
            }
        }
        let mut s: f32 = acc.iter().sum();
        for (x, y) in ra.iter().zip(rb) {
            s += (x - y) * (x - y);
        }
        1.0 - s.sqrt()
    }
}

/// The average face (unit length for ArcFace).
pub fn centroid(model: i64, vs: &[&[f32]]) -> Option<Vec<f32>> {
    let first = vs.first()?;
    let n = first.len();
    let mut m = vec![0.0f32; n];
    for v in vs.iter().filter(|v| v.len() == n) {
        for (a, b) in m.iter_mut().zip(v.iter()) {
            *a += b;
        }
    }
    let n = vs.len() as f32;
    m.iter_mut().for_each(|x| *x /= n);
    if model == ARCFACE.model {
        crate::faceid_math::normalize(&mut m);
    }
    Some(m)
}

// ---- the neighbour graph ------------------------------------------------------------------

/// Look-alikes kept per face.
const KEEP: usize = 64;

/// Look-alikes found for one new face: (its index, [(other index, similarity)]).
type Found = (usize, Vec<(u32, f32)>);

pub struct Graph {
    pub model: i64,
    ids: Vec<i64>,
    index: HashMap<i64, usize>,
    alive: Vec<bool>,
    emb: Vec<Vec<f32>>,
    nbrs: Vec<Vec<(u32, f32)>>,
    dead: usize,
}

impl Graph {
    pub fn new(model: i64) -> Self {
        Graph { model, ids: Vec::new(), index: HashMap::new(), alive: Vec::new(), emb: Vec::new(), nbrs: Vec::new(), dead: 0 }
    }

    #[cfg(test)]
    pub fn len(&self) -> usize {
        self.ids.len() - self.dead
    }

    /// Forget faces that are gone; returns those of `present` still to be
    /// added. After many removals everything is rebuilt (then all of
    /// `present` is returned).
    pub fn sync(&mut self, present: &HashSet<i64>) -> Vec<i64> {
        for (i, id) in self.ids.iter().enumerate() {
            if self.alive[i] && !present.contains(id) {
                self.alive[i] = false;
                self.emb[i] = Vec::new();
                self.dead += 1;
            }
        }
        if self.dead > 500 && self.dead * 4 > self.ids.len() {
            *self = Graph::new(self.model);
        }
        let mut missing: Vec<i64> = present.iter().filter(|id| !self.index.contains_key(id)).copied().collect();
        missing.sort_unstable();
        missing
    }

    /// Add faces (id, fingerprint) and link them with their look-alikes.
    pub fn add(&mut self, new: Vec<(i64, Vec<f32>)>) {
        let want = dim(self.model);
        let start = self.ids.len();
        for (id, e) in new {
            if e.len() != want || self.index.contains_key(&id) || !e.iter().all(|v| v.is_finite()) {
                continue;
            }
            self.index.insert(id, self.ids.len());
            self.ids.push(id);
            self.alive.push(true);
            self.emb.push(e);
            self.nbrs.push(Vec::new());
        }
        let end = self.ids.len();
        if end == start {
            return;
        }
        let (model, link) = (self.model, metric(self.model).link);
        let threads = std::thread::available_parallelism().map(|n| n.get()).unwrap_or(2).clamp(1, 16);
        let (emb, alive) = (&self.emb, &self.alive);
        // Each new face against everything before it (old and new): every pair once.
        let found: Vec<Vec<Found>> = std::thread::scope(|sc| {
            let hs: Vec<_> = (0..threads)
                .map(|t| {
                    sc.spawn(move || {
                        let mut out = Vec::new();
                        let mut j = start + t;
                        while j < end {
                            let mut v = Vec::new();
                            let ej = &emb[j];
                            for i in 0..j {
                                if alive[i] {
                                    let s = similarity(model, &emb[i], ej);
                                    if s >= link {
                                        v.push((i as u32, s));
                                    }
                                }
                            }
                            out.push((j, v));
                            j += threads;
                        }
                        out
                    })
                })
                .collect();
            hs.into_iter().map(|h| h.join().unwrap_or_default()).collect()
        });
        let mut touched: HashSet<usize> = HashSet::new();
        for (j, v) in found.into_iter().flatten() {
            for (i, s) in v {
                self.nbrs[i as usize].push((j as u32, s));
                self.nbrs[j].push((i, s));
                touched.insert(i as usize);
            }
            touched.insert(j);
        }
        for i in touched {
            let l = &mut self.nbrs[i];
            if l.len() > KEEP {
                l.sort_by(|a, b| b.1.total_cmp(&a.1));
                l.truncate(KEEP);
            }
        }
    }

    pub fn idx(&self, id: i64) -> Option<usize> {
        self.index.get(&id).copied().filter(|&i| self.alive[i])
    }

    pub fn id(&self, i: usize) -> i64 {
        self.ids[i]
    }

    pub fn emb(&self, i: usize) -> &[f32] {
        &self.emb[i]
    }

    /// Living look-alikes of face `i` (index, similarity).
    pub fn neighbours(&self, i: usize) -> impl Iterator<Item = (usize, f32)> + '_ {
        self.nbrs[i].iter().map(|&(j, s)| (j as usize, s)).filter(|&(j, _)| self.alive[j])
    }
}

// ---- grouping --------------------------------------------------------------------------------

/// Chinese whispers: each face takes the label most of its (weighted)
/// look-alikes have, until nothing changes. `nodes` are graph indices;
/// edges only between nodes, at or above `min`. Returns a label per node
/// (labels are positions in `nodes`).
pub fn whispers(g: &Graph, nodes: &[usize], min: f32) -> Vec<usize> {
    let pos: HashMap<usize, usize> = nodes.iter().enumerate().map(|(k, &i)| (i, k)).collect();
    let adj: Vec<Vec<(usize, f32)>> = nodes
        .iter()
        .map(|&i| g.neighbours(i).filter(|&(_, s)| s >= min).filter_map(|(j, s)| pos.get(&j).map(|&k| (k, s))).collect())
        .collect();
    let mut label: Vec<usize> = (0..nodes.len()).collect();
    for _ in 0..30 {
        let mut changed = false;
        for k in 0..nodes.len() {
            if adj[k].is_empty() {
                continue;
            }
            let mut w: HashMap<usize, f32> = HashMap::new();
            for &(o, s) in &adj[k] {
                *w.entry(label[o]).or_default() += s;
            }
            let best = w.into_iter().max_by(|a, b| a.1.total_cmp(&b.1).then(b.0.cmp(&a.0))).map(|x| x.0).unwrap_or(label[k]);
            if best != label[k] {
                label[k] = best;
                changed = true;
            }
        }
        if !changed {
            break;
        }
    }
    label
}

// ---- the analysis -------------------------------------------------------------------------------

#[derive(Debug, Clone)]
pub struct FaceMeta {
    pub id: i64,
    pub media: i64,
    pub folder: Option<i64>,
    pub person: Option<i64>,
    /// Named automatically (not by you).
    pub auto: bool,
    /// "Not important".
    pub hidden: bool,
    pub video: bool,
}

#[derive(Debug, Clone)]
pub struct PersonMeta {
    pub id: i64,
    /// The person folder and everything below it.
    pub inside: HashSet<i64>,
}

pub struct Input<'a> {
    pub faces: &'a [FaceMeta],
    pub people: &'a [PersonMeta],
    /// (face, person): "not this person".
    pub rejects: &'a HashSet<(i64, i64)>,
    /// (smaller person, bigger person): "not the same person".
    pub not_same: &'a HashSet<(i64, i64)>,
}

#[derive(Debug, Clone, Default)]
pub struct Owner {
    /// One face per photo, most alike first (similarity to the group).
    pub faces: Vec<(i64, f32)>,
    pub photos: usize,
}

#[derive(Debug, Clone)]
pub struct Group {
    /// Most typical first (similarity to the group's average).
    pub faces: Vec<(i64, f32)>,
    pub photos: usize,
    pub hidden: bool,
    /// Looks like this person (and how much).
    pub looks_like: Option<(i64, f32)>,
}

#[derive(Debug, Clone, Default)]
pub struct Analysis {
    /// Faces to name automatically: (face, person, similarity).
    pub auto_set: Vec<(i64, i64, f32)>,
    /// Automatically named faces that no longer qualify.
    pub auto_clear: Vec<i64>,
    /// Faces that join a hidden group ("not important" stays hidden).
    pub hide: Vec<i64>,
    /// Per person: suggested faces, most alike first (one per photo).
    pub suggestions: HashMap<i64, Vec<(i64, f32)>>,
    /// Per person with few confirmed faces: who recurs in their folder.
    pub owners: HashMap<i64, Owner>,
    /// Unknown people, most photos first, then hidden ones.
    pub groups: Vec<Group>,
    /// Two people who look the same: (person, person, similarity).
    pub merges: Vec<(i64, i64, f32)>,
    /// Confirmed faces per person.
    pub confirmed: HashMap<i64, usize>,
}

/// Fewest photos for an unknown group to be shown.
pub const MIN_PHOTOS: usize = 3;
/// A person with fewer confirmed faces is also learned from their folder's owner.
pub const FEW: usize = 3;
/// Provisional references taken from a folder's owner.
const OWNER_REFS: usize = 50;

struct Ctx<'a> {
    g: &'a Graph,
    m: Metric,
    faces: &'a [FaceMeta],
    /// Graph index → position in `faces`.
    at: HashMap<usize, usize>,
    people: HashMap<i64, &'a PersonMeta>,
}

impl Ctx<'_> {
    fn meta(&self, i: usize) -> Option<&FaceMeta> {
        self.at.get(&i).map(|&k| &self.faces[k])
    }
    /// Named by you as one of the current people.
    fn confirmed(&self, f: &FaceMeta) -> Option<i64> {
        f.person.filter(|p| !f.auto && self.people.contains_key(p))
    }
    /// Named by you as someone who is no longer a person folder.
    fn named_elsewhere(&self, f: &FaceMeta) -> bool {
        f.person.is_some_and(|p| !self.people.contains_key(&p)) && !f.auto
    }
}

fn distinct_media<'a>(it: impl Iterator<Item = &'a FaceMeta>) -> usize {
    it.map(|f| f.media).collect::<HashSet<_>>().len()
}

/// The person who recurs across a person folder's photos (its owner), or
/// the group most like the person when they already have confirmed faces.
pub fn find_owner(g: &Graph, input: &Input, person: i64) -> Option<Owner> {
    let ctx = context(g, input);
    owner_of(&ctx, input, person, &confirmed_refs(&ctx))
}

fn context<'a>(g: &'a Graph, input: &Input<'a>) -> Ctx<'a> {
    let at = input.faces.iter().enumerate().filter_map(|(k, f)| g.idx(f.id).map(|i| (i, k))).collect();
    Ctx { g, m: metric(g.model), faces: input.faces, at, people: input.people.iter().map(|p| (p.id, p)).collect() }
}

fn confirmed_refs(ctx: &Ctx) -> HashMap<i64, Vec<usize>> {
    let mut refs: HashMap<i64, Vec<usize>> = HashMap::new();
    for (&i, &k) in &ctx.at {
        if let Some(p) = ctx.confirmed(&ctx.faces[k]) {
            refs.entry(p).or_default().push(i);
        }
    }
    for v in refs.values_mut() {
        v.sort_unstable();
    }
    refs
}

fn owner_of(ctx: &Ctx, input: &Input, person: i64, refs: &HashMap<i64, Vec<usize>>) -> Option<Owner> {
    let pm = ctx.people.get(&person)?;
    let mut cand: Vec<usize> = ctx
        .at
        .iter()
        .filter(|(_, k)| {
            let f = &ctx.faces[**k];
            f.folder.is_some_and(|x| pm.inside.contains(&x))
                && !f.hidden
                && !input.rejects.contains(&(f.id, person))
                && (ctx.confirmed(f).is_none_or(|p| p == person))
                && !ctx.named_elsewhere(f)
        })
        .map(|(i, _)| *i)
        .collect();
    cand.sort_unstable();
    if cand.is_empty() {
        return None;
    }
    let labels = whispers(ctx.g, &cand, ctx.m.cluster);
    let mut clusters: HashMap<usize, Vec<usize>> = HashMap::new();
    for (k, l) in labels.iter().enumerate() {
        clusters.entry(*l).or_default().push(cand[k]);
    }
    let mine = refs.get(&person).filter(|r| !r.is_empty());
    let centre_of = |members: &[usize]| centroid(ctx.g.model, &members.iter().map(|&i| ctx.g.emb(i)).collect::<Vec<_>>());
    let media_of = |members: &[usize]| distinct_media(members.iter().filter_map(|&i| ctx.meta(i)));
    let folder_media = distinct_media(cand.iter().filter_map(|&i| ctx.meta(i)));
    let best = if let Some(r) = mine {
        let pc = centre_of(r)?;
        clusters
            .values()
            .filter_map(|c| {
                let cc = centre_of(c)?;
                let s = similarity(ctx.g.model, &cc, &pc);
                (s >= ctx.m.maybe).then_some((c, s))
            })
            .max_by(|a, b| a.1.total_cmp(&b.1))
            .map(|x| x.0)
    } else {
        clusters
            .values()
            .map(|c| (c, media_of(c), c.len()))
            .filter(|(_, n, _)| *n >= MIN_PHOTOS && *n * 5 >= folder_media)
            .max_by(|a, b| a.1.cmp(&b.1).then(a.2.cmp(&b.2)).then(b.0.iter().min().cmp(&a.0.iter().min())))
            .map(|x| x.0)
    }?;
    let cc = centre_of(best)?;
    let have: HashSet<i64> = best.iter().filter_map(|&i| ctx.meta(i)).filter(|f| ctx.confirmed(f) == Some(person) && !f.video).map(|f| f.media).collect();
    let mut by_media: HashMap<i64, (i64, f32)> = HashMap::new();
    for &i in best {
        let Some(f) = ctx.meta(i) else { continue };
        if ctx.confirmed(f) == Some(person) || (have.contains(&f.media)) {
            continue;
        }
        let s = similarity(ctx.g.model, ctx.g.emb(i), &cc);
        let e = by_media.entry(f.media).or_insert((f.id, s));
        if s > e.1 {
            *e = (f.id, s);
        }
    }
    let mut faces: Vec<(i64, f32)> = by_media.into_values().collect();
    faces.sort_by(|a, b| b.1.total_cmp(&a.1).then(a.0.cmp(&b.0)));
    if faces.is_empty() {
        return None;
    }
    Some(Owner { photos: faces.len(), faces })
}

pub fn analyse(g: &Graph, input: &Input) -> Analysis {
    let ctx = context(g, input);
    let m = ctx.m;
    let mut out = Analysis::default();
    let refs = confirmed_refs(&ctx);
    for (p, r) in &refs {
        out.confirmed.insert(*p, r.len());
    }

    // 1. Folder owners: for people with few confirmed faces, the face that
    //    recurs in their folder stands in until you confirm it.
    let mut provisional: HashMap<i64, Vec<usize>> = HashMap::new();
    let mut people_ids: Vec<i64> = input.people.iter().map(|p| p.id).collect();
    people_ids.sort_unstable();
    for &p in &people_ids {
        if refs.get(&p).map_or(0, |r| r.len()) >= FEW {
            continue;
        }
        if let Some(o) = owner_of(&ctx, input, p, &refs) {
            provisional.insert(p, o.faces.iter().take(OWNER_REFS).filter_map(|(id, _)| g.idx(*id)).collect());
            out.owners.insert(p, o);
        }
    }

    // 2. Every face that isn't named by you: who is it most like?
    let mut is_ref: HashMap<usize, Vec<(i64, bool)>> = HashMap::new();
    for (p, r) in &refs {
        for &i in r {
            is_ref.entry(i).or_default().push((*p, true));
        }
    }
    for (p, r) in &provisional {
        for &i in r {
            is_ref.entry(i).or_default().push((*p, false));
        }
    }
    let emb_of = |r: &[usize]| r.iter().map(|&i| g.emb(i)).collect::<Vec<_>>();
    let conf_centre: HashMap<i64, Vec<f32>> = refs.iter().filter_map(|(p, r)| Some((*p, centroid(g.model, &emb_of(r))?))).collect();
    let prov_centre: HashMap<i64, Vec<f32>> = provisional.iter().filter_map(|(p, r)| Some((*p, centroid(g.model, &emb_of(r))?))).collect();
    // Photos where a person is already confirmed (they appear once in a picture).
    let mut confirmed_in: HashSet<(i64, i64)> = HashSet::new();
    for f in input.faces {
        if let Some(p) = ctx.confirmed(f).filter(|_| !f.video) {
            confirmed_in.insert((f.media, p));
        }
    }

    struct Decision {
        face: i64,
        media: i64,
        person: i64,
        score: f32,
        conf: f32,
        second: f32,
    }
    let mut decided: Vec<Decision> = Vec::new();
    let mut leftover: Vec<usize> = Vec::new();
    let mut order: Vec<(&usize, &usize)> = ctx.at.iter().collect();
    order.sort_unstable();
    for (&i, &k) in order {
        let f = &input.faces[k];
        if ctx.confirmed(f).is_some() || ctx.named_elsewhere(f) {
            continue;
        }
        if f.hidden {
            leftover.push(i);
            continue;
        }
        let mut all: HashMap<i64, f32> = HashMap::new();
        let mut conf: HashMap<i64, f32> = HashMap::new();
        for (j, s) in g.neighbours(i) {
            if let Some(list) = is_ref.get(&j) {
                for &(p, c) in list {
                    let e = all.entry(p).or_insert(f32::MIN);
                    *e = e.max(s);
                    if c {
                        let e = conf.entry(p).or_insert(f32::MIN);
                        *e = e.max(s);
                    }
                }
            }
        }
        for (p, c) in &conf_centre {
            let s = similarity(g.model, g.emb(i), c);
            let e = all.entry(*p).or_insert(f32::MIN);
            *e = e.max(s);
            let e = conf.entry(*p).or_insert(f32::MIN);
            *e = e.max(s);
        }
        for (p, c) in &prov_centre {
            let s = similarity(g.model, g.emb(i), c);
            let e = all.entry(*p).or_insert(f32::MIN);
            *e = e.max(s);
        }
        let mut ranked: Vec<(i64, f32)> = all
            .into_iter()
            .filter(|(p, _)| !input.rejects.contains(&(f.id, *p)) && (f.video || !confirmed_in.contains(&(f.media, *p))))
            .collect();
        ranked.sort_by(|a, b| b.1.total_cmp(&a.1).then(a.0.cmp(&b.0)));
        match ranked.first() {
            Some(&(p, s)) if s >= m.maybe => decided.push(Decision {
                face: f.id,
                media: f.media,
                person: p,
                score: s,
                conf: conf.get(&p).copied().unwrap_or(f32::MIN),
                second: ranked.get(1).map_or(f32::MIN, |x| x.1),
            }),
            _ => leftover.push(i),
        }
    }
    // One face per person per photo: the most alike; the others are someone else.
    decided.sort_by(|a, b| b.score.total_cmp(&a.score).then(a.face.cmp(&b.face)));
    let video: HashSet<i64> = input.faces.iter().filter(|f| f.video).map(|f| f.id).collect();
    let mut taken: HashSet<(i64, i64)> = HashSet::new();
    let mut autos: HashMap<i64, i64> = HashMap::new();
    for d in decided {
        if !video.contains(&d.face) && !taken.insert((d.media, d.person)) {
            if let Some(i) = g.idx(d.face) {
                leftover.push(i);
            }
            continue;
        }
        let auto = m.auto.is_some_and(|a| d.conf >= a && d.score - d.second.max(0.0) >= m.auto_margin)
            && refs.get(&d.person).is_some_and(|r| r.len() >= 2);
        if auto {
            autos.insert(d.face, d.person);
            out.auto_set.push((d.face, d.person, d.conf));
        } else {
            out.suggestions.entry(d.person).or_default().push((d.face, d.score));
        }
    }
    for f in input.faces {
        if f.auto && f.person.is_some() && autos.get(&f.id) != f.person.as_ref() {
            out.auto_clear.push(f.id);
        }
    }
    let by_id: HashMap<i64, &FaceMeta> = input.faces.iter().map(|f| (f.id, f)).collect();
    out.auto_set.retain(|(face, p, _)| by_id.get(face).is_none_or(|f| !(f.auto && f.person == Some(*p))));
    for v in out.suggestions.values_mut() {
        v.sort_by(|a, b| b.1.total_cmp(&a.1).then(a.0.cmp(&b.0)));
    }

    // 3. Everyone else: group faces that are alike.
    leftover.sort_unstable();
    leftover.dedup();
    let labels = whispers(g, &leftover, m.cluster);
    let mut clusters: HashMap<usize, Vec<usize>> = HashMap::new();
    for (k, l) in labels.iter().enumerate() {
        clusters.entry(*l).or_default().push(leftover[k]);
    }
    let mut cl: Vec<Vec<usize>> = clusters.into_values().filter(|c| c.len() >= 2 || c.iter().any(|&i| ctx.meta(i).is_some_and(|f| f.hidden))).collect();
    cl.sort_by_key(|c| c.iter().min().copied());
    // Join groups that are the same person split in two.
    let mut centres: Vec<Option<Vec<f32>>> = cl.iter().map(|c| centroid(g.model, &emb_of(c))).collect();
    loop {
        let mut best: Option<(usize, usize, f32)> = None;
        for a in 0..cl.len() {
            for b in a + 1..cl.len() {
                if let (Some(x), Some(y)) = (&centres[a], &centres[b]) {
                    let s = similarity(g.model, x, y);
                    if s >= m.merge && best.is_none_or(|q| s > q.2) {
                        best = Some((a, b, s));
                    }
                }
            }
        }
        let Some((a, b, _)) = best else { break };
        let moved = std::mem::take(&mut cl[b]);
        cl[a].extend(moved);
        centres[a] = centroid(g.model, &emb_of(&cl[a]));
        centres[b] = None;
    }
    for (c, centre) in cl.into_iter().zip(centres) {
        let Some(centre) = centre else { continue };
        if c.is_empty() {
            continue;
        }
        let metas: Vec<&FaceMeta> = c.iter().filter_map(|&i| ctx.meta(i)).collect();
        let hidden_n = metas.iter().filter(|f| f.hidden).count();
        let hidden = hidden_n * 10 >= metas.len() * 3 && hidden_n > 0;
        let photos = distinct_media(metas.iter().copied());
        if !hidden && photos < MIN_PHOTOS {
            continue;
        }
        let mut faces: Vec<(i64, f32)> = c.iter().map(|&i| (g.id(i), similarity(g.model, g.emb(i), &centre))).collect();
        faces.sort_by(|a, b| b.1.total_cmp(&a.1).then(a.0.cmp(&b.0)));
        if hidden {
            out.hide.extend(metas.iter().filter(|f| !f.hidden).map(|f| f.id));
        }
        let looks_like = conf_centre
            .iter()
            .chain(prov_centre.iter().filter(|(p, _)| !conf_centre.contains_key(p)))
            .map(|(p, pc)| (*p, similarity(g.model, &centre, pc)))
            .filter(|(p, s)| *s >= m.hint && faces.iter().filter(|(f, _)| input.rejects.contains(&(*f, *p))).count() * 2 < faces.len())
            .max_by(|a, b| a.1.total_cmp(&b.1).then(b.0.cmp(&a.0)))
            .or_else(|| {
                // Not like anyone known, but in the folder of someone the app
                // knows nothing about yet: probably them.
                let mut best: Option<(i64, usize)> = None;
                for p in input.people.iter().filter(|p| !refs.contains_key(&p.id) && !out.owners.contains_key(&p.id)) {
                    let n = distinct_media(metas.iter().copied().filter(|f| f.folder.is_some_and(|x| p.inside.contains(&x)) && !input.rejects.contains(&(f.id, p.id))));
                    if n > 0 && best.is_none_or(|b| n > b.1) {
                        best = Some((p.id, n));
                    }
                }
                best.map(|(p, _)| (p, m.hint))
            });
        out.groups.push(Group { faces, photos, hidden, looks_like });
    }
    out.groups.sort_by(|a, b| a.hidden.cmp(&b.hidden).then(b.photos.cmp(&a.photos)).then(a.faces[0].0.cmp(&b.faces[0].0)));

    // 4. Two people who look the same.
    let centre_any = |p: i64| conf_centre.get(&p).or_else(|| prov_centre.get(&p));
    for (ai, &a) in people_ids.iter().enumerate() {
        for &b in &people_ids[ai + 1..] {
            if input.not_same.contains(&(a, b)) {
                continue;
            }
            if let (Some(x), Some(y)) = (centre_any(a), centre_any(b)) {
                let s = similarity(g.model, x, y);
                if s >= m.merge {
                    out.merges.push((a, b, s));
                }
            }
        }
    }
    out.merges.sort_by(|a, b| b.2.total_cmp(&a.2));
    out
}

#[cfg(test)]
mod tests {
    use super::*;

    /// A unit fingerprint near "person" `p` (a few people far apart), with a little noise.
    fn fp(p: usize, noise: u64) -> Vec<f32> {
        let mut v = vec![0.0f32; 512];
        v[p * 7] = 1.0;
        // Deterministic noise.
        let mut x = noise.wrapping_mul(6364136223846793005).wrapping_add(1442695040888963407);
        for k in v.iter_mut() {
            x = x.wrapping_mul(6364136223846793005).wrapping_add(1442695040888963407);
            *k += ((x >> 33) as f32 / (1u64 << 31) as f32 - 0.5) * 0.06;
        }
        crate::faceid_math::normalize(&mut v);
        v
    }

    struct World {
        g: Graph,
        faces: Vec<FaceMeta>,
        people: Vec<PersonMeta>,
        rejects: HashSet<(i64, i64)>,
        not_same: HashSet<(i64, i64)>,
        next: i64,
    }

    impl World {
        fn new() -> Self {
            World { g: Graph::new(1), faces: vec![], people: vec![], rejects: HashSet::new(), not_same: HashSet::new(), next: 1 }
        }
        /// A photo in `folder` with these people (by base) in it; returns face ids.
        fn photo(&mut self, media: i64, folder: Option<i64>, who: &[usize]) -> Vec<i64> {
            let mut ids = vec![];
            for &p in who {
                let id = self.next;
                self.next += 1;
                self.g.add(vec![(id, fp(p, id as u64))]);
                self.faces.push(FaceMeta { id, media, folder, person: None, auto: false, hidden: false, video: false });
                ids.push(id);
            }
            ids
        }
        fn name(&mut self, face: i64, person: i64) {
            let f = self.faces.iter_mut().find(|f| f.id == face).unwrap();
            f.person = Some(person);
            f.auto = false;
        }
        fn run(&self) -> Analysis {
            analyse(&self.g, &Input { faces: &self.faces, people: &self.people, rejects: &self.rejects, not_same: &self.not_same })
        }
    }

    #[test]
    fn similarity_by_model() {
        let a = fp(0, 1);
        let b = fp(0, 2);
        let c = fp(1, 3);
        assert!(similarity(1, &a, &b) > 0.4, "{}", similarity(1, &a, &b));
        assert!(similarity(1, &a, &c) < 0.2);
        assert!((similarity(0, &[0.0, 0.0], &[3.0, 4.0]) + 4.0).abs() < 1e-6);
        let cen = centroid(1, &[&a[..], &b[..]]).unwrap();
        assert!((dot(&cen, &cen) - 1.0).abs() < 1e-4);
    }

    #[test]
    fn graph_links_lookalikes_and_forgets_removed_faces() {
        let mut g = Graph::new(1);
        g.add((0..20).map(|i| (i, fp((i % 2) as usize, i as u64))).collect());
        assert_eq!(g.len(), 20);
        let i0 = g.idx(0).unwrap();
        assert!(g.neighbours(i0).all(|(j, _)| g.id(j) % 2 == 0), "only the same person is close");
        assert_eq!(g.neighbours(i0).count(), 9);
        // Wrong length or duplicates are ignored.
        g.add(vec![(0, fp(0, 99)), (500, vec![1.0; 3])]);
        assert_eq!(g.len(), 20);
        let present: HashSet<i64> = (0..18).chain([100]).collect();
        assert_eq!(g.sync(&present), vec![100]);
        assert_eq!(g.len(), 18);
        assert!(g.idx(19).is_none());
        assert!(g.neighbours(g.idx(1).unwrap()).all(|(j, _)| g.id(j) != 19));
    }

    #[test]
    fn whispers_split_people() {
        let mut g = Graph::new(1);
        g.add((0..30).map(|i| (i, fp((i % 3) as usize, i as u64))).collect());
        let nodes: Vec<usize> = (0..30).map(|i| g.idx(i).unwrap()).collect();
        let l = whispers(&g, &nodes, 0.42);
        for a in 0..30 {
            for b in 0..30 {
                assert_eq!(l[a] == l[b], a % 3 == b % 3, "{a} {b}");
            }
        }
    }

    #[test]
    fn known_people_are_named_suggested_and_strangers_grouped() {
        let mut w = World::new();
        let baran = 100;
        w.people.push(PersonMeta { id: baran, inside: HashSet::from([baran]) });
        // Three confirmed photos of Baran (person 0) in his folder.
        for m in 1..=3 {
            let f = w.photo(m, Some(baran), &[0])[0];
            w.name(f, baran);
        }
        // Baran elsewhere, alone and in group photos with person 1 and 2.
        let alone = w.photo(10, None, &[0])[0];
        let group = w.photo(11, None, &[0, 1, 2]);
        // Strangers: person 3 in four photos, person 4 in one.
        for m in 20..24 {
            w.photo(m, None, &[3]);
        }
        w.photo(30, None, &[4]);
        let a = w.run();
        let named: HashSet<i64> = a.auto_set.iter().map(|x| x.0).collect();
        assert!(named.contains(&alone) && named.contains(&group[0]), "{:?}", a.auto_set);
        assert!(a.auto_set.iter().all(|x| x.1 == baran));
        assert!(!named.contains(&group[1]));
        assert_eq!(a.groups.len(), 1, "the stranger in four photos; the one-off isn't shown");
        assert_eq!(a.groups[0].photos, 4);
        assert!(a.groups[0].looks_like.is_none());
        assert_eq!(a.confirmed[&baran], 3);
        assert!(a.merges.is_empty());

        // Rejected stays rejected.
        w.rejects.insert((alone, baran));
        let a = w.run();
        assert!(!a.auto_set.iter().any(|x| x.0 == alone));
        assert!(!a.suggestions.get(&baran).is_some_and(|s| s.iter().any(|x| x.0 == alone)));

        // An automatic name that no longer fits is taken back.
        if let Some(f) = w.faces.iter_mut().find(|f| f.id == group[1]) {
            f.person = Some(baran);
            f.auto = true;
        }
        let a = w.run();
        assert!(a.auto_clear.contains(&group[1]));
    }

    #[test]
    fn with_one_confirmed_face_suggestions_not_auto() {
        let mut w = World::new();
        let p = 7;
        w.people.push(PersonMeta { id: p, inside: HashSet::from([p]) });
        let f = w.photo(1, None, &[0])[0];
        w.name(f, p);
        let other = w.photo(2, None, &[0])[0];
        let a = w.run();
        assert!(a.auto_set.is_empty(), "one face isn't enough to name on its own");
        assert_eq!(a.suggestions[&p][0].0, other);
        assert!(a.suggestions[&p][0].1 >= ARCFACE.sure);
    }

    #[test]
    fn the_folder_owner_is_found_even_in_group_photos() {
        let mut w = World::new();
        let p = 50;
        w.people.push(PersonMeta { id: p, inside: HashSet::from([p, 51]) });
        // Ten photos in Baran's folder (and a subfolder): him in each, friends now and then.
        let mut his = vec![];
        for m in 1..=10 {
            let mut who = vec![0];
            if m % 2 == 0 {
                who.push(1);
            }
            if m % 3 == 0 {
                who.push(2);
            }
            his.push(w.photo(m, Some(if m > 7 { 51 } else { p }), &who)[0]);
        }
        let a = w.run();
        let o = &a.owners[&p];
        assert_eq!(o.photos, 10);
        let ids: HashSet<i64> = o.faces.iter().map(|x| x.0).collect();
        assert_eq!(ids, his.iter().copied().collect());
        // Until confirmed, the owner stands in: Baran elsewhere is suggested (not named).
        let elsewhere = w.photo(99, None, &[0])[0];
        let a = w.run();
        assert!(a.suggestions[&p].iter().any(|x| x.0 == elsewhere));
        assert!(a.auto_set.is_empty());
        // The friends (person 1, in five photos) form a group of their own.
        assert!(a.groups.iter().any(|g| g.photos == 5));
        // A person folder with a single photo: the group that has it is probably them.
        let q = 60;
        w.people.push(PersonMeta { id: q, inside: HashSet::from([q]) });
        let one = w.photo(200, Some(q), &[4])[0];
        w.photo(201, None, &[4]);
        w.photo(202, None, &[4]);
        let a = w.run();
        let g = a.groups.iter().find(|g| g.faces.iter().any(|f| f.0 == one)).unwrap();
        assert_eq!(g.looks_like.map(|x| x.0), Some(q));
        // Confirmed: no more owner question, and he is named elsewhere automatically.
        for f in &his {
            w.name(*f, p);
        }
        let a = w.run();
        assert!(!a.owners.contains_key(&p));
        assert!(a.auto_set.iter().any(|x| x.0 == elsewhere));
        // On request, the owner of a folder with confirmed faces is the group most like them.
        let input = Input { faces: &w.faces, people: &w.people, rejects: &w.rejects, not_same: &w.not_same };
        assert!(find_owner(&w.g, &input, p).is_none(), "all of his photos are confirmed already");
    }

    #[test]
    fn hidden_groups_stay_hidden_and_merges_are_offered() {
        let mut w = World::new();
        let mut ids = vec![];
        for m in 1..=4 {
            ids.extend(w.photo(m, None, &[5]));
        }
        for f in w.faces.iter_mut() {
            f.hidden = true;
        }
        let new = w.photo(5, None, &[5])[0];
        let a = w.run();
        assert_eq!(a.groups.len(), 1);
        assert!(a.groups[0].hidden);
        assert_eq!(a.hide, vec![new], "a new face of a hidden person is hidden too");

        // Two person folders for the same person.
        let (x, y) = (200, 201);
        w.people.push(PersonMeta { id: x, inside: HashSet::from([x]) });
        w.people.push(PersonMeta { id: y, inside: HashSet::from([y]) });
        let fx = w.photo(10, Some(x), &[6])[0];
        let fy = w.photo(11, Some(y), &[6])[0];
        w.name(fx, x);
        w.name(fy, y);
        let a = w.run();
        assert_eq!(a.merges.len(), 1);
        assert_eq!((a.merges[0].0, a.merges[0].1), (x, y));
        w.not_same.insert((x, y));
        assert!(w.run().merges.is_empty());
    }
}
