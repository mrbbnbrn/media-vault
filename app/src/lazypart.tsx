// Parts of the app that load only when first needed (their code is a separate
// file of the build), so starting the app reads and compiles much less.
// Shortly after the start screen is up, they are fetched in the background
// (one at a time, when the PC is idle), so opening one later is still instant.

import { lazy, Suspense, type ComponentType, type JSX } from 'react';

type Loader = () => Promise<unknown>;

const all: { load: Loader; early: boolean; asked?: boolean }[] = [];

/**
 * A component whose code loads on first use. Drawn as nothing for the moment
 * it takes (a few milliseconds from disk). `early`: fetched first in the background.
 */
export function lazyPart<P extends object>(load: () => Promise<ComponentType<P>>, early = false): ((props: P) => JSX.Element) & { preload: Loader } {
  type Mod = { default: ComponentType<P> };
  let p: Promise<Mod> | null = null;
  let done: Mod | null = null;
  const get = () => (p ??= load().then((c) => (done = { default: c })));
  // Already fetched (in the background): hand it over at once, so nothing blinks on first use.
  const L = lazy(() => (done ? ({ then: (f: (m: Mod) => void) => f(done!) } as unknown as Promise<Mod>) : get())) as unknown as ComponentType<P>;
  const Part = (props: P) => (
    <Suspense fallback={null}>
      <L {...props} />
    </Suspense>
  );
  Part.preload = get;
  all.push({ load: get, early });
  return Part;
}

let started = false;

/**
 * Fetch every lazy part in the background, the early ones first; one per idle
 * moment. Parts declared inside a part (the library's dialogs) join the queue
 * as soon as that part has loaded.
 */
export function preloadParts() {
  if (started) return;
  started = true;
  const idle = (f: () => void) =>
    typeof requestIdleCallback === 'function' ? requestIdleCallback(f, { timeout: 2000 }) : setTimeout(f, 50);
  const next = () => {
    const part = all.find((x) => !x.asked && x.early) ?? all.find((x) => !x.asked);
    if (!part) return;
    part.asked = true;
    idle(() => {
      part.load().catch(() => {}).finally(next);
    });
  };
  next();
}
