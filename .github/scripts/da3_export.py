"""Exports a Depth Anything 3 model (Apache-2.0 weights only) to ONNX for the
app's optional depth packs, and checks the result against PyTorch.

Used by .github/workflows/depthmodels.yml; runs on a Linux runner with the
Depth Anything 3 source checked out next to it.

  python da3_export.py <model> <hf repo> <out dir>

Writes <out dir>/model.onnx and <out dir>/export.json (what was made: the
input sizes it takes, fp16 or fp32, and how close it is to PyTorch).

The network is wrapped so the ONNX model takes one picture (1 × 3 × H × W,
ImageNet-normalised, H and W multiples of 14) and returns one "depth" map
(1 × H × W; bigger = farther). Camera and multi-view parts are left out. For
the mono model the sky is set to the farthest non-sky depth, as the original
code does (but with the maximum instead of a sampled quantile, so it exports).

First it tries a model that takes any size (so the app's "High" detail can
use 756 px); if that doesn't export, or doesn't match PyTorch at both sizes,
it falls back to a model fixed at 518 × 518. Then it tries half precision
(smaller, faster on graphics cards) and keeps it only if it still matches.
"""

import json
import sys
import time
from pathlib import Path

import numpy as np
import torch
import torch.nn as nn

MODEL, REPO, OUT = sys.argv[1], sys.argv[2], Path(sys.argv[3])
OUT.mkdir(parents=True, exist_ok=True)
STANDARD, HIGH, PATCH = 518, 756, 14
MEAN = np.array([0.485, 0.456, 0.406], np.float32)
STD = np.array([0.229, 0.224, 0.225], np.float32)


def build():
    from huggingface_hub import snapshot_download
    from safetensors.torch import load_file

    from depth_anything_3.cfg import create_object, load_config
    from depth_anything_3.registry import MODEL_REGISTRY

    net = create_object(load_config(MODEL_REGISTRY[MODEL]))
    folder = Path(snapshot_download(REPO, allow_patterns=["*.safetensors", "*.json", "LICENSE*", "README*"]))
    state = {}
    for f in sorted(folder.glob("*.safetensors")):
        state.update(load_file(str(f)))
    # The hub checkpoint belongs to the API wrapper (self.model = the network).
    state = {k[len("model."):] if k.startswith("model.") else k: v for k, v in state.items()}
    missing, unexpected = net.load_state_dict(state, strict=False)
    # Only camera / GS parts may be missing or extra; the backbone and head must load.
    bad = [k for k in missing if k.startswith(("backbone.", "head."))]
    print(f"weights: {len(state)} tensors; missing {len(missing)} (backbone/head: {len(bad)}), unexpected {len(unexpected)}")
    if bad:
        raise SystemExit(f"backbone/head weights missing: {bad[:10]}")
    net.eval()
    return net, folder


class OnePicture(nn.Module):
    """1 × 3 × H × W → 1 × H × W depth (bigger = farther)."""

    def __init__(self, net):
        super().__init__()
        self.net = net

    def forward(self, x):
        h, w = x.shape[-2], x.shape[-1]
        feats, _ = self.net.backbone(x[:, None], cam_token=None, export_feat_layers=[])
        out = self.net._process_depth_head(feats, h, w)
        depth = out["depth"].reshape(1, h, w)
        if "sky" in out:
            sky = out["sky"].reshape(1, h, w)
            ground = sky < 0.3
            far = torch.where(ground, depth, torch.zeros_like(depth)).amax()
            depth = torch.where(ground, depth, far.expand_as(depth))
        return depth


def pictures(side):
    """A few test inputs at this size: the repo's sample frames plus a synthetic scene."""
    from PIL import Image

    out = []
    root = Path("Depth-Anything-3/assets/examples/SOH")
    for p in sorted(root.glob("*.png"))[:2]:
        im = Image.open(p).convert("RGB").resize((side, side), Image.BICUBIC)
        out.append(np.asarray(im, np.float32) / 255.0)
    yy, xx = np.mgrid[0:side, 0:side] / side
    synth = np.stack([0.3 + 0.5 * yy, 0.4 + 0.3 * np.sin(6 * xx), 0.6 - 0.4 * yy], -1).astype(np.float32)
    synth[side // 3: side // 2, side // 3: 2 * side // 3] = [0.9, 0.2, 0.2]
    out.append(synth)
    return [((p - MEAN) / STD).transpose(2, 0, 1)[None].astype(np.float32) for p in out]


def corr(a, b):
    a, b = a.ravel().astype(np.float64), b.ravel().astype(np.float64)
    if not np.isfinite(b).all():
        return -1.0
    return float(np.corrcoef(a, b)[0, 1])


def check(path, wrap, sides, fp16=False):
    import onnxruntime as ort

    so = ort.SessionOptions()
    s = ort.InferenceSession(str(path), so, providers=["CPUExecutionProvider"])
    name = s.get_inputs()[0].name
    worst = 1.0
    for side in sides:
        for x in pictures(side):
            with torch.no_grad():
                ref = wrap(torch.from_numpy(x)).numpy()
            t = time.time()
            got = s.run(None, {name: x})[0]
            ms = (time.time() - t) * 1000
            c = corr(ref, got)
            worst = min(worst, c)
            print(f"  {path.name} @ {side}: correlation {c:.5f}, CPU {ms:.0f} ms")
    return worst


def export(wrap, path, dynamic):
    x = torch.from_numpy(pictures(STANDARD)[0])
    if dynamic:
        h = torch.export.Dim("h", min=14, max=2048)
        w = torch.export.Dim("w", min=14, max=2048)
        torch.onnx.export(wrap, (x,), str(path), dynamo=True, input_names=["image"], output_names=["depth"],
                          dynamic_shapes={"x": {2: 14 * h, 3: 14 * w}}, opset_version=18, external_data=False)
    else:
        torch.onnx.export(wrap, (x,), str(path), dynamo=False, input_names=["image"], output_names=["depth"],
                          opset_version=17, do_constant_folding=True)


def main():
    net, folder = build()
    wrap = OnePicture(net).eval()
    fp32 = OUT / "model-fp32.onnx"
    made = {"model": MODEL, "repo": REPO, "dynamic": False, "fp16": False}
    try:
        export(wrap, fp32, dynamic=True)
        score = check(fp32, wrap, [STANDARD, HIGH])
        print(f"any-size export: worst correlation {score:.5f}")
        if score < 0.995:
            raise RuntimeError("any-size export doesn't match PyTorch")
        made["dynamic"] = True
    except Exception as e:  # noqa: BLE001 — any failure means: use the fixed size
        print(f"any-size export not usable ({e}); exporting at {STANDARD} × {STANDARD}")
        fp32.unlink(missing_ok=True)
        export(wrap, fp32, dynamic=False)
        score = check(fp32, wrap, [STANDARD])
        print(f"fixed export: worst correlation {score:.5f}")
        if score < 0.995:
            raise SystemExit("the ONNX model doesn't match PyTorch")
    made["fp32Correlation"] = score
    sides = [STANDARD, HIGH] if made["dynamic"] else [STANDARD]

    final = OUT / "model.onnx"
    try:
        import onnx
        from onnxconverter_common import float16

        m = float16.convert_float_to_float16(onnx.load(str(fp32)), keep_io_types=True,
                                             op_block_list=["Resize", "ReduceMax", "Pow", "Sqrt", "ReduceMean"])
        half = OUT / "model-fp16.onnx"
        onnx.save(m, str(half))
        s16 = check(half, wrap, sides)
        print(f"half precision: worst correlation {s16:.5f}")
        if s16 >= 0.99:
            half.rename(final)
            fp32.unlink()
            made["fp16"] = True
            made["fp16Correlation"] = s16
        else:
            half.unlink()
    except Exception as e:  # noqa: BLE001
        print(f"half precision not usable ({e}); keeping 32-bit")
    if not final.exists():
        fp32.rename(final)
    made["sizeBytes"] = final.stat().st_size
    made["sides"] = sides
    for f in folder.glob("LICENSE*"):
        (OUT / f"weights-{f.name}").write_bytes(f.read_bytes())
    for f in folder.glob("README*"):
        (OUT / f"weights-{f.name}").write_bytes(f.read_bytes())
    (OUT / "export.json").write_text(json.dumps(made, indent=2))
    print(json.dumps(made, indent=2))


if __name__ == "__main__":
    main()
