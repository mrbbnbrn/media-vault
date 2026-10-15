// A box that shows a folder cover with its hand-set framing ("Adjust
// cover…"). The picture, GIF or pooled video inside picks the framing up from
// CSS variables (see `.cframe` in screens.css and coverframe.ts), so the card,
// the sidebar and the editor all draw it the same way, without measuring.

import type { CSSProperties, ReactNode } from 'react';
import { frameVars, type CoverPos } from '../coverframe';

export function Framed(props: { pos: CoverPos | null | undefined; className?: string; style?: CSSProperties; children: ReactNode }) {
  return (
    <span className={`cframe${props.className ? ` ${props.className}` : ''}`} style={{ ...frameVars(props.pos), ...props.style }} aria-hidden="true">
      {props.children}
    </span>
  );
}
