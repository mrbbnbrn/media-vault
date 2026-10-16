"""Exports a BiRefNet model (MIT) to ONNX for the app's optional "subject
outline" packs, and checks the result against the original PyTorch model.

Used by .github/workflows/subjectmodels.yml.

  python birefnet_export.py <id> <out dir> [extra pictures...]

(the PyTorch half and the ONNX half each run in a process of their own).

<id> is "birefnet-lite" (ZhengPeng7/BiRefNet_lite) or "birefnet"
(ZhengPeng7/BiRefNet); the weights are pinned to a commit below.

Writes <out dir>/model.onnx (fp32, one 1 × 3 × 1024 × 1024 ImageNet-normalised
picture in, the finest 1 × 1 × 1024 × 1024 mask logits out), <out dir>/export.json
(what was made and how close it is to PyTorch) and the weights' model card as
weights-README.md (for the licence check and LICENSES.txt).

Why not an existing export: the ONNX files on Hugging Face spell the
decoder's deformable convolutions out as huge gathers (one 7 × 7 layer makes
several 800 MB tensors at 1024 px), so the processor needs well over 6 GB and
small graphics cards run out of memory. Here each deformable convolution is
written as one bilinear sample (GridSample) and a 1 × 1 convolution per kernel
position, added up one at a time: the same maths, a few MB at a time, and
only standard operators that the ONNX Runtime the app ships (1.24, which has
no DeformConv) runs on the processor and with DirectML.

The check: the ONNX model (on ONNX Runtime, processor, in a fresh process)
and the original PyTorch model (torchvision's deform_conv2d) see the same
pictures; the masks' correlation (>= 0.995) and IoU (>= 0.98) must be high on
every one, else the job fails.
"""

import hashlib
import json
import os
import sys
import time
from pathlib import Path

import numpy as np

# Each half runs in a process of its own, so their memory never adds up (at
# 1024 px either one alone needs several GB on the processor):
#   "--torch <id> <out dir> [pictures...]": PyTorch's masks, then the export;
#   "--check <model.onnx> <refs.npz>": the ONNX model on the same pictures.
# Without a flag: both, one after the other, then export.json.
MODE = sys.argv[1] if len(sys.argv) > 1 and sys.argv[1] in ("--torch", "--check") else ""
ARGS = sys.argv[2:] if MODE else sys.argv[1:]
if MODE == "--torch":
    import torch
    import torch.nn.functional as F

    torch.set_grad_enabled(False)

ID, OUT = ("birefnet-lite", Path(".")) if MODE == "--check" else (ARGS[0], Path(ARGS[1]))
EXTRA = [Path(p) for p in ARGS[2:]] if MODE != "--check" else []
if MODE != "--check":
    OUT.mkdir(parents=True, exist_ok=True)

# The square size the model takes (BiRefNet is trained at 1024; smaller needs far less memory).
SIDE = int(os.environ.get("BIREFNET_SIDE", "1024"))
MEAN = np.array([0.485, 0.456, 0.406], np.float32)
STD = np.array([0.229, 0.224, 0.225], np.float32)
MODELS = {
    "birefnet-lite": ("ZhengPeng7/BiRefNet_lite", "aa62cd87eafb9cc43056d08ef3615a14628b831d"),
    "birefnet": ("ZhengPeng7/BiRefNet", "e2bf8e4460fc8fa32bba5ea4d94b3233d367b0e4"),
}
REPO, REV = MODELS[ID]
MIN_CORR = 0.995
MIN_IOU = 0.98


def lean_deform_conv2d(input, offset, weight, bias=None, stride=(1, 1), padding=(0, 0), dilation=(1, 1), mask=None):
    """torchvision.ops.deform_conv2d (modulated, one offset group, stride 1) as
    GridSample + 1 × 1 convolutions, one kernel position at a time."""
    s = stride if isinstance(stride, (tuple, list)) else (stride, stride)
    p = padding if isinstance(padding, (tuple, list)) else (padding, padding)
    d = dilation if isinstance(dilation, (tuple, list)) else (dilation, dilation)
    assert tuple(s) == (1, 1) and tuple(d) == (1, 1), "only stride 1, dilation 1"
    # Plain numbers (while exporting, sizes come as tensors; the model's size is fixed anyway).
    b, c, h, w = (int(v) for v in input.shape)
    o, ci, kh, kw = (int(v) for v in weight.shape)
    assert ci == c and int(offset.shape[1]) == 2 * kh * kw, "one group, one offset group"
    ho, wo = int(offset.shape[-2]), int(offset.shape[-1])
    ys = torch.arange(ho, dtype=input.dtype).view(1, ho, 1) - p[0]
    xs = torch.arange(wo, dtype=input.dtype).view(1, 1, wo) - p[1]
    sy, sx = 2.0 / max(h - 1, 1), 2.0 / max(w - 1, 1)
    out = None
    for k in range(kh * kw):
        i, j = divmod(k, kw)
        y = ys + i + offset[:, 2 * k]
        x = xs + j + offset[:, 2 * k + 1]
        grid = torch.stack((x * sx - 1.0, y * sy - 1.0), dim=-1)
        v = F.grid_sample(input, grid, mode="bilinear", padding_mode="zeros", align_corners=True)
        part = F.conv2d(v, weight[:, :, i:i + 1, j:j + 1])
        if mask is not None:
            part = part * mask[:, k:k + 1]
        out = part if out is None else out + part
    if bias is not None:
        out = out + bias.view(1, -1, 1, 1)
    return out


def load():
    from huggingface_hub import hf_hub_download
    from transformers import AutoModelForImageSegmentation

    card = Path(hf_hub_download(REPO, "README.md", revision=REV))
    (OUT / "weights-README.md").write_bytes(card.read_bytes())
    net = AutoModelForImageSegmentation.from_pretrained(REPO, revision=REV, trust_remote_code=True)
    return net.eval().float()


def code_module(net):
    """The module of the model's own code (where deform_conv2d is looked up)."""
    return sys.modules[type(net).__module__]


def finest_only(net):
    """The model's finest mask only (logits): BiRefNet returns its maps coarse to fine."""

    class Finest(torch.nn.Module):
        def __init__(self):
            super().__init__()
            self.net = net

        def forward(self, x):
            return self.net(x)[-1]

    return Finest().eval()


def pictures():
    """Test inputs: scikit-image's sample photos (a person, an animal, objects),
    any extra pictures given, and a synthetic shape on a plain background."""
    from PIL import Image
    from skimage import data

    out = []
    for name in ("astronaut", "chelsea", "coffee", "rocket"):
        try:
            out.append((name, Image.fromarray(getattr(data, name)()).convert("RGB")))
        except Exception as e:  # noqa: BLE001 — a missing sample is fine, the others still count
            print(f"(sample {name} not available: {e})")
    for p in EXTRA:
        out.append((p.stem, Image.open(p).convert("RGB")))
    yy, xx = np.mgrid[0:SIDE, 0:SIDE] / SIDE
    synth = np.stack([0.85 - 0.1 * yy, 0.85 - 0.05 * xx, 0.8 + 0 * xx], -1)
    synth[(xx - 0.5) ** 2 + (yy - 0.55) ** 2 < 0.07] = [0.8, 0.15, 0.1]
    out.append(("synthetic", Image.fromarray((synth * 255).astype(np.uint8))))
    res = []
    for name, im in out:
        a = np.asarray(im.resize((SIDE, SIDE), Image.BILINEAR), np.float32) / 255.0
        res.append((name, ((a - MEAN) / STD).transpose(2, 0, 1)[None].astype(np.float32)))
    return res


def sigmoid(x):
    return 1.0 / (1.0 + np.exp(-np.clip(x.astype(np.float64), -60, 60)))


def compare(ref, got):
    pr, pg = sigmoid(ref).ravel(), sigmoid(got).ravel()
    if not np.isfinite(pg).all():
        return -1.0, 0.0, 1.0
    corr = float(np.corrcoef(pr, pg)[0, 1]) if pr.std() > 1e-6 and pg.std() > 1e-6 else (1.0 if np.abs(pr - pg).max() < 1e-3 else -1.0)
    a, b = pr > 0.5, pg > 0.5
    union = (a | b).sum()
    iou = float((a & b).sum() / union) if union else 1.0
    return corr, iou, float(np.abs(pr - pg).max())


def sha256(path):
    h = hashlib.sha256()
    with open(path, "rb") as f:
        for block in iter(lambda: f.read(1 << 20), b""):
            h.update(block)
    return h.hexdigest()


def check(path, refs_path):
    """The ONNX side of the check, in a fresh process (PyTorch's memory is
    gone by then: at 1024 px the model alone needs a few GB on the processor)."""
    import onnxruntime as ort

    data = np.load(refs_path)
    names = [n[4:] for n in data.files if n.startswith("ref_")]
    so = ort.SessionOptions()
    so.enable_cpu_mem_arena = False
    so.enable_mem_pattern = False
    s = ort.InferenceSession(str(path), so, providers=["CPUExecutionProvider"])
    inp = s.get_inputs()[0].name
    rows = []
    for name in names:
        x, ref = data["in_" + name], data["ref_" + name]
        t = time.time()
        got = s.run(None, {inp: x})[-1]
        ms = (time.time() - t) * 1000
        if got.shape != ref.shape:
            raise SystemExit(f"{name}: ONNX gave {got.shape}, PyTorch {ref.shape}")
        c, i, d = compare(ref, got)
        share = float((sigmoid(ref) > 0.5).mean())
        rows.append({"picture": name, "correlation": c, "iou": i, "maxDiff": d, "subjectShare": share, "cpuMs": ms})
        print(f"  ONNX {name}: correlation {c:.5f}, IoU {i:.5f}, max difference {d:.4f}, subject {share:.0%}, CPU {ms:.0f} ms", flush=True)
    (Path(refs_path).with_suffix(".rows.json")).write_text(json.dumps(rows))


def torch_half():
    """PyTorch's masks of the test pictures (saved with them in refs.npz), then the export."""
    net = load()
    mod = code_module(net)
    original = mod.deform_conv2d
    wrap = finest_only(net)
    pics = pictures()

    # The reference: the original model, as published (torchvision's deformable convolution).
    refs = {}
    for name, x in pics:
        t = time.time()
        refs[name] = wrap(torch.from_numpy(x)).numpy()
        print(f"  PyTorch {name}: {time.time() - t:.1f} s, output {refs[name].shape}", flush=True)
        if refs[name].shape != (1, 1, SIDE, SIDE):
            raise SystemExit(f"the finest output is {refs[name].shape}, not 1 x 1 x {SIDE} x {SIDE}")

    # The lean deformable convolution must give the same answer in PyTorch first.
    mod.deform_conv2d = lean_deform_conv2d
    name, x = pics[0]
    c, i, d = compare(refs[name], wrap(torch.from_numpy(x)).numpy())
    print(f"lean deformable convolution in PyTorch ({name}): correlation {c:.6f}, IoU {i:.6f}, max difference {d:.5f}")
    if c < 0.9999:
        raise SystemExit("the lean deformable convolution doesn't match torchvision's")

    path = OUT / "model.onnx"
    t = time.time()
    torch.onnx.export(wrap, (torch.from_numpy(x),), str(path), dynamo=False, input_names=["input_image"], output_names=["output_image"],
                      opset_version=17, do_constant_folding=True)
    print(f"exported in {time.time() - t:.0f} s: {path.stat().st_size / 2**20:.0f} MB")
    mod.deform_conv2d = original

    np.savez(OUT / "refs.npz", **{f"in_{n}": x for n, x in pics}, **{f"ref_{n}": r for n, r in refs.items()})


def main():
    import subprocess

    path, refs_path = OUT / "model.onnx", OUT / "refs.npz"
    subprocess.run([sys.executable, "-I", __file__, "--torch", ID, str(OUT), *map(str, EXTRA)], check=True)
    subprocess.run([sys.executable, "-I", __file__, "--check", str(path), str(refs_path)], check=True)
    rows_path = refs_path.with_suffix(".rows.json")
    rows = json.loads(rows_path.read_text())
    refs_path.unlink()
    rows_path.unlink()

    worst_corr = min(r["correlation"] for r in rows)
    worst_iou = min(r["iou"] for r in rows)
    print(f"worst correlation {worst_corr:.5f}, worst IoU {worst_iou:.5f} over {len(rows)} pictures")
    if len(rows) < 3 or worst_corr < MIN_CORR or worst_iou < MIN_IOU:
        raise SystemExit(f"the ONNX model doesn't match PyTorch (need correlation >= {MIN_CORR} and IoU >= {MIN_IOU} on at least 3 pictures)")
    made = {"id": ID, "repo": REPO, "revision": REV, "side": SIDE, "output": "logits", "outputIndex": -1, "fp16": False, "opset": 17,
            "deformableConvolution": "GridSample + 1x1 Conv per kernel position (same maths as torchvision.ops.deform_conv2d)",
            "check": {"against": "the original PyTorch model (torchvision deform_conv2d)", "minCorrelation": MIN_CORR, "minIoU": MIN_IOU},
            "worstCorrelation": worst_corr, "worstIoU": worst_iou, "pictures": rows,
            "sizeBytes": path.stat().st_size, "sha256": sha256(path)}
    (OUT / "export.json").write_text(json.dumps(made, indent=2))
    print(json.dumps(made, indent=2))


if __name__ == "__main__":
    if MODE == "--check":
        check(Path(ARGS[0]), Path(ARGS[1]))
    elif MODE == "--torch":
        torch_half()
    else:
        main()
