// Settings → Faces: which face model is used, the optional faces pack, and
// the one-time rescan when the pack arrives.

import { useEffect, useState } from 'react';
import { api, type FaceEngineStatus, type ScanStatus } from '../api';
import { checkFaceEngine, faceBackend, kickFaceScanner } from '../ml/facescan';
import './people.css';

/** Where to get the faces pack (shown when it isn't installed). */
export const NO_FACE_PACK =
  'For much better recognition, download MediaVault-faces-windows.zip from the Releases page (the faces pack, once) and unzip it next to the app: it adds MediaVault\\tools\\faces.';

export function FaceSection() {
  const [faces, setFaces] = useState<ScanStatus | null>(null);
  const [engine, setEngine] = useState<FaceEngineStatus | null>(null);
  const [checking, setChecking] = useState(false);
  const load = () => {
    api.facesStatus().then(setFaces).catch(() => {});
    api.facesEngine().then(setEngine).catch(() => {});
  };
  useEffect(load, []);
  const again = async () => {
    setChecking(true);
    await checkFaceEngine();
    kickFaceScanner();
    load();
    setChecking(false);
  };
  const native = engine?.native;
  const backend = faceBackend();
  const runsOn = engine?.active === 'buffalo_l'
    ? native?.device === 'gpu' ? 'graphics card' : 'processor'
    : backend === 'webgl' ? 'graphics card' : backend ? 'processor' : null;
  const total = engine ? engine.upgraded + engine.upgradeLeft : 0;
  return (
    <section className="section face-engine">
      <h2>Face recognition</h2>
      <p className="muted" style={{ margin: 0, lineHeight: 1.6 }}>
        Scan your pictures and the people in them are grouped in <b>People</b>: name someone once and every photo of them is
        named. Faces that are clearly them are named automatically (easy to undo); only unsure ones are asked. Files are never
        moved unless you say so. Everything stays on this PC, inside the encrypted vault.
      </p>
      {engine && (
        <div className="stats face-stats">
          <div className="stat"><span className="faint" style={{ fontSize: 12 }}>Face model</span><b>{engine.active === 'buffalo_l' ? 'InsightFace buffalo_l' : 'Built-in (face-api)'}</b></div>
          {runsOn && <div className="stat"><span className="faint" style={{ fontSize: 12 }}>Runs on</span><b>{runsOn}</b></div>}
          {faces && <div className="stat"><span className="faint" style={{ fontSize: 12 }}>Scanned</span><b>{faces.scanned.toLocaleString()}</b></div>}
          {faces && <div className="stat"><span className="faint" style={{ fontSize: 12 }}>Faces found</span><b>{faces.faces.toLocaleString()}</b></div>}
          {faces && <div className="stat"><span className="faint" style={{ fontSize: 12 }}>Waiting</span><b>{faces.queued.toLocaleString()}</b></div>}
        </div>
      )}
      {engine && engine.upgradeLeft > 0 && (
        <div className="info people-upgrade">
          <span>Scanning again with the new model: {engine.upgraded.toLocaleString()} of {total.toLocaleString()}. Your answers are kept.</span>
          <span className="people-bar"><i style={{ width: `${Math.round((100 * engine.upgraded) / Math.max(1, total))}%` }} /></span>
        </div>
      )}
      {native && (native.available ? (
        <div className="info">
          Faces pack found{native.sharedRuntime ? ' (using the upscaler’s ONNX Runtime)' : ''}. InsightFace buffalo_l is for
          personal use only (its licence doesn't allow commercial use).
        </div>
      ) : (
        <div className="notice row-between" style={{ gap: 12 }}>
          <span>{native.problem && native.problem !== "The face recognition pack isn't installed." ? `${native.problem} ` : ''}{NO_FACE_PACK}</span>
          <button type="button" className="btn btn-sm" disabled={checking} onClick={again}>{checking ? 'Checking…' : 'Check again'}</button>
        </div>
      ))}
    </section>
  );
}
