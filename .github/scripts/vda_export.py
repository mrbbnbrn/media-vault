"""Video Depth Anything Small (Apache-2.0) to ONNX for Media Vault's prepared 3D for videos.

One run takes 32 frames at once: input `frames` 1 x 32 x 3 x 518 x 518 (ImageNet-normalised RGB),
output `depth` 1 x 32 x 518 x 518 (relative nearness: bigger = closer), steady from frame to frame.
The app sends a video's frames in runs of 32 that overlap and lines the runs up (video3d.ts).

Checked against PyTorch on a made-up moving clip before it is packed; writes export.json
(frames, side, worst correlation) next to model.onnx.

Usage: python vda_export.py <repo dir> <out dir>
"""

import json
import pathlib
import sys

import numpy as np
import torch

REPO = pathlib.Path(sys.argv[1]).resolve()
OUT = pathlib.Path(sys.argv[2])
OUT.mkdir(parents=True, exist_ok=True)
sys.path.insert(0, str(REPO))

from huggingface_hub import hf_hub_download  # noqa: E402
from video_depth_anything.video_depth import VideoDepthAnything  # noqa: E402

HF = "depth-anything/Video-Depth-Anything-Small"
T = 32
SIDE = 518
MEAN = np.array([0.485, 0.456, 0.406], dtype=np.float32)
STD = np.array([0.229, 0.224, 0.225], dtype=np.float32)

ckpt = hf_hub_download(HF, "video_depth_anything_vits.pth")
for name in ("README.md", "LICENSE", "LICENSE.txt"):
    try:
        p = hf_hub_download(HF, name)
        (OUT / f"weights-{name}").write_bytes(pathlib.Path(p).read_bytes())
    except Exception:  # not every repo has every file
        pass

model = VideoDepthAnything(encoder="vits", features=64, out_channels=[48, 96, 192, 384])
model.load_state_dict(torch.load(ckpt, map_location="cpu"), strict=True)
model.eval()


def clip() -> torch.Tensor:
    """A made-up clip: a soft gradient room with a bright box sliding across it."""
    ys, xs = np.mgrid[0:SIDE, 0:SIDE].astype(np.float32) / SIDE
    frames = []
    for t in range(T):
        img = np.stack([0.3 + 0.5 * ys, 0.2 + 0.6 * xs, 0.5 - 0.3 * ys], axis=-1)
        x0 = int((0.1 + 0.6 * t / T) * SIDE)
        img[int(0.3 * SIDE):int(0.8 * SIDE), x0:x0 + SIDE // 5] = (0.9, 0.85, 0.2)
        frames.append(((img - MEAN) / STD).transpose(2, 0, 1))
    return torch.from_numpy(np.stack(frames)[None].astype(np.float32))


x = clip()
with torch.no_grad():
    ref = model(x).numpy()
print("PyTorch output:", ref.shape)
assert ref.shape == (1, T, SIDE, SIDE), ref.shape

torch.onnx.export(
    model,
    (x,),
    str(OUT / "model.onnx"),
    input_names=["frames"],
    output_names=["depth"],
    opset_version=17,
    do_constant_folding=True,
    dynamo=False,
)

import onnxruntime as ort  # noqa: E402

sess = ort.InferenceSession(str(OUT / "model.onnx"), providers=["CPUExecutionProvider"])
got = sess.run(None, {"frames": x.numpy()})[0]
assert got.shape == ref.shape, (got.shape, ref.shape)
worst = 1.0
for t in range(T):
    a = ref[0, t].ravel()
    b = got[0, t].ravel()
    c = float(np.corrcoef(a, b)[0, 1])
    worst = min(worst, c)
print("worst per-frame correlation ONNX vs PyTorch:", worst)
assert worst > 0.995, worst
# Steady: neighbouring frames of the background stay alike (the model's whole point).
bg = got[0, :, : SIDE // 5, :].reshape(T, -1)
drift = float(np.max(np.abs(np.diff(bg.mean(axis=1)))) / (np.abs(bg).mean() + 1e-6))
print("background drift between frames (share):", drift)
(OUT / "export.json").write_text(json.dumps({"frames": T, "side": SIDE, "worstCorrelation": worst, "backgroundDrift": drift, "weights": HF}, indent=2))
