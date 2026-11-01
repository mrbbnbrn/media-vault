// A folder card's picture (with its living preview and hover cycle).

import { WholeCover } from './LibraryDialogs';
import { mediaUrl, thumbUrl, type FolderCard } from '../../api';
import { FolderIcon } from '../../components/Icons';
import { CoverImg, useCardHovered, useFolderSamples, useHoverCycle } from '../../components/CoverImg';
import { CoverVideo } from '../../components/VideoPreview';
import { Framed } from '../../components/FramedCover';
import { RoundCover } from '../../components/RoundCover';

/**
 * A folder card's picture: a round face for person folders, a playing video/GIF
 * cover, a stack of three with the cover on top, or the cover alone. While hovered
 * it cycles through pictures from inside (its own counter: nothing else redraws).
 */
export function FolderCover({ f, preview, whole, edge }: {
  f: FolderCard; preview: 'all' | 'hover' | 'off'; whole: boolean; edge: string;
}) {
  // Hovering redraws only this card (CoverImg.tsx), not the library.
  const hovered = useCardHovered(f.id);
  const list = useFolderSamples(f.id, hovered);
  const cycle = useHoverCycle(hovered);
  // Person folders: a round cover centred on the face; hovering opens it
  // into the card's square, and holding there cycles pictures from inside.
  if (f.person && f.cover) {
    const others = list?.filter((x) => x !== f.cover) ?? [];
    const cycling = hovered && others.length > 0 && cycle > 0 ? others[(cycle - 1) % others.length] : null;
    const before = hovered && others.length > 1 && cycle > 1 ? others[(cycle - 2) % others.length] : null;
    return <span className={`pcard${hovered ? ' open' : ''}`}><RoundCover folder={f} open={hovered} cycle={cycling} before={before}
      play={preview === 'all' || (preview === 'hover' && hovered)} /></span>;
  }
  const playing = preview === 'all' || (preview === 'hover' && hovered);
  const animated = f.coverKind === 'video' || f.coverKind === 'gif';
  if (f.cover && playing && animated) {
    const still = <CoverImg id={f.cover} />;
    // "Show the whole video on hover": the hovered card's video/GIF also shows uncropped.
    if (hovered && whole) return <><WholeCover id={f.cover} kind={f.coverKind === 'gif' ? 'gif' : 'video'} />{still}</>;
    if (f.coverPos) return <Framed pos={f.coverPos}>{f.coverKind === 'video' ? <>{still}<CoverVideo id={f.cover} /></> : <img src={mediaUrl(f.cover)} alt="" draggable={false} />}</Framed>;
    if (f.coverKind === 'video') return <>{still}<CoverVideo id={f.cover} /></>;
    return <img src={mediaUrl(f.cover)} alt="" draggable={false} />;
  }
  // Stacked card: two more pictures from inside peek out behind the cover;
  // hovering fans them out over the neighbouring cards (the mouse passes
  // through them), the front card grows a little and then cycles through
  // the folder. Cards in the first or last column fan less towards the edge.
  const behind = f.cover ? f.samples.filter((x) => x !== f.cover).slice(0, 2) : [];
  if (behind.length) {
    const others = list?.filter((x) => !behind.includes(x)) ?? [];
    const cycling = hovered && others.length > 1 && cycle > 0 ? others[(cycle - 1) % others.length] : null;
    // The picture before stays underneath while the next one fades in.
    const before = hovered && others.length > 1 && cycle > 1 ? others[(cycle - 2) % others.length] : null;
    return (
      <span className={`fstack${edge}`}>
        {behind.map((x, k) => <CoverImg key={x} id={x} className={`fstack-${k + 1}`} />)}
        {f.coverPos
          ? <Framed pos={f.coverPos} className="fstack-top"><CoverImg id={f.cover!} /></Framed>
          : <CoverImg id={f.cover!} className="fstack-top" />}
        {before != null && <img key={`b${before}`} className="fstack-top" src={thumbUrl(before)} alt="" draggable={false} />}
        {cycling != null && <img key={cycling} className="fstack-top cycle" src={thumbUrl(cycling)} alt="" draggable={false} />}
      </span>
    );
  }
  if (hovered && list && list.length > 1 && cycle > 0) {
    const id = list[(cycle - 1) % list.length];
    return <img key={id} className="cycle" src={thumbUrl(id)} alt="" draggable={false} />;
  }
  if (!f.cover) return <FolderIcon size={40} />;
  if (f.coverPos) return <Framed pos={f.coverPos}><CoverImg id={f.cover} /></Framed>;
  return <CoverImg id={f.cover} />;
}
