// The player's sound path: a video's sound can go through a short delay
// (0.1 s), with one shared AudioContext for every video instead of one each.

/** Sound of a video through a short delay (or straight through again): once routed, a video's sound always goes this way. */
const routes = new WeakMap<HTMLVideoElement, { ctx: AudioContext; delay: DelayNode }>();

/** One sound engine for every video (a new one per video kept running, one more each video). */
let sharedAudio: AudioContext | null = null;

export function audioRoute(v: HTMLVideoElement, on: boolean): ((on: boolean) => void) | null {
  let r = routes.get(v);
  if (!r) {
    if (!on) return null;
    try {
      const ctx = (sharedAudio ??= new AudioContext());
      const src = ctx.createMediaElementSource(v);
      const delay = ctx.createDelay(1);
      src.connect(delay).connect(ctx.destination);
      r = { ctx, delay };
      routes.set(v, r);
    } catch {
      return null;
    }
  }
  const set = (yes: boolean) => {
    r!.delay.delayTime.value = yes ? 0.1 : 0;
    if (yes) void r!.ctx.resume().catch(() => {});
  };
  set(on);
  return set;
}
