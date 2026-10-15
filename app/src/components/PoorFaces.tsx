// People → Poor faces: faces too small, too blurry or turned too far away to
// be trusted (Settings → Faces decides where that starts). They are never
// named on their own or learned from; naming one yourself makes it count.

import { useState } from 'react';
import { api, type FaceReview, type Item, type PoorFace } from '../api';
import { poorReason } from '../poorfaces';
import { personFolders, WhoIsIt } from './FaceBoxes';
import { FaceCrop } from './People';
import './poorfaces.css';

export function PoorFacesSection(props: {
  review: FaceReview;
  onOpenItem: (it: Item) => void;
  /** Something changed: say so and load People again. */
  onDone: (message: string) => void;
  onError: (message: string) => void;
  /** Show more of them. */
  onMore: () => void;
}) {
  const [ask, setAsk] = useState<{ face: PoorFace; left: number; top: number } | null>(null);
  const list = props.review.poor ?? [];
  const total = props.review.poorTotal ?? list.length;
  if (!list.length) return null;
  const hide = async (p: PoorFace) => {
    try {
      await api.facesHide([p.faceId], true);
      props.onDone('Hidden: not important.');
    } catch (e) {
      props.onError(e instanceof Error ? e.message : String(e));
    }
  };
  return (
    <details className="person hidden-people poor-faces">
      <summary>
        <b>Poor faces</b>{' '}
        <span className="faint">· {total.toLocaleString()} — too small, blurry or turned away; never named on their own or used to learn anyone</span>
      </summary>
      <div className="poor-grid">
        {list.map((p) => (
          <div key={p.faceId} className="poor-tile">
            <button type="button" className="found-face" title={`${poorReason(p)} · open this photo`} aria-label="Open this photo" onClick={() => props.onOpenItem(p.item)}>
              <FaceCrop s={p} size={64} />
            </button>
            <span className="faint poor-why">{poorReason(p)}</span>
            <div className="poor-actions">
              <button type="button" className="btn btn-sm" title="Say who this is: a face you name counts, and teaches the app"
                onClick={(e) => {
                  const b = e.currentTarget.getBoundingClientRect();
                  setAsk({ face: p, left: b.left, top: b.bottom + 6 });
                }}>Who?</button>
              <button type="button" className="btn btn-sm ghost" title="Not important: never asked about again" onClick={() => hide(p)}>Hide</button>
            </div>
          </div>
        ))}
      </div>
      {total > list.length && (
        <button type="button" className="btn btn-sm people-more" onClick={props.onMore}>Show more ({(total - list.length).toLocaleString()} more)</button>
      )}
      {ask && (
        <WhoIsIt left={ask.left} top={ask.top} onClose={() => setAsk(null)}
          face={{ id: ask.face.faceId, frameMs: ask.face.frameMs, x: ask.face.x, y: ask.face.y, w: ask.face.w, h: ask.face.h, person: null }}
          onDone={(msg) => {
            setAsk(null);
            personFolders(true).catch(() => {});
            props.onDone(msg);
          }} />
      )}
    </details>
  );
}
