// The face wall: every face of a person, cut out of their photos, oldest to
// newest, under a heading per month. Clicking a face opens its photo, like
// clicking a tile. Shown instead of the grid on a person's page and on a
// search for one person.

import { useEffect, useMemo, useState } from 'react';
import { api, type PersonFace } from '../../api';
import { bigEnough, byMonth } from '../../facecrops';
import { saveViewerPrefs, useViewerPrefs } from '../../prefs';
import { FaceTile } from './FaceTile';
import { MinFaceSlider, PicturesOnly } from './MinFace';
import './facecrops.css';

export function FaceWall(props: { person: number; name: string; onOpen: (mediaId: number) => void; onContext?: (e: React.MouseEvent, mediaId: number) => void; tick?: number }) {
  const prefs = useViewerPrefs();
  const [all, setAll] = useState<PersonFace[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [min, setMin] = useState(prefs.faceWallMin ?? 40);
  useEffect(() => {
    let alive = true;
    setAll(null);
    setError(null);
    api.faceCropsList(props.person).then((l) => alive && setAll(l)).catch((e) => alive && setError(e instanceof Error ? e.message : String(e)));
    return () => {
      alive = false;
    };
  }, [props.person, props.tick]);
  const groups = useMemo(() => byMonth(bigEnough(all ?? [], min)), [all, min]);
  const date = (s: number) => new Date(s * 1000).toLocaleDateString('en-GB', { day: 'numeric', month: 'short', year: 'numeric' });

  return (
    <div className="fc-wall">
      <div className="fc-wall-bar">
        <MinFaceSlider faces={all ?? []} value={min} onChange={setMin} onCommit={(v) => { saveViewerPrefs({ faceWallMin: v }).catch(() => {}); }} />
        <PicturesOnly />
      </div>
      {error ? <p className="faint">{error}</p>
        : all == null ? <p className="faint">Finding faces…</p>
        : !all.length ? <p className="faint">No named faces of {props.name} in pictures yet. Faces you name on the People page show up here.</p>
        : !groups.length ? <p className="faint">No faces are this big. Lower “Smallest face”.</p>
        : groups.map((g) => (
          <section key={`${g.label}-${g.faces[0].id}`} className="fc-month">
            <h3>{g.label} <span className="faint">· {g.faces.length}</span></h3>
            <div className="fc-month-faces">
              {g.faces.map((f) => (
                <FaceTile key={f.id} face={f} size={96} round title={`${date(f.date)} · ${Math.round(f.facePx)} px face — click to open the photo`} onOpen={() => props.onOpen(f.mediaId)} onContext={props.onContext ? (e) => props.onContext!(e, f.mediaId) : undefined} />
              ))}
            </div>
          </section>
        ))}
    </div>
  );
}
