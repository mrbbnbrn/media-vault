"""Builds the ONNX model of an optional "background fill" (inpainting) pack
and checks it against the reference implementation before it is packed.

Used by .github/workflows/inpaintmodels.yml.

  python inpaint_export.py <id> <out dir> [extra pictures...]

  <id>  "migan" = MI-GAN 512 Places2 (Picsart AI Research, MIT, code and weights)
        "lama"  = big-lama (LaMa, Samsung AI Center Moscow, Apache-2.0)

Needs the reference code checked out (MIGAN_SRC = the MI-GAN repository,
LAMA_SRC = the LaMa repository, both at the commits the workflow pins); the
weights are downloaded here from fixed revisions and their SHA-256 checked.

What the app gets, for both models (fp32, fixed 512 x 512, opset 17):
  inputs   image  1 x 3 x 512 x 512  RGB, 0-1
           mask   1 x 1 x 512 x 512  1 = fill this pixel, 0 = keep it (0 or 1 only)
  output   result 1 x 3 x 512 x 512  RGB, 0-1: the model's picture of the whole square.
The app keeps the picture outside the mask and blends the model's picture in
with a soft edge (the same blend as MI-GAN's own pipeline: the kept area grown
by one pixel with a 3 x 3 maximum, then a 5 x 5 Gaussian blur, sigma 1).
`composite` below is that blend; app/src-tauri/src/inpaint.rs does the same.

MI-GAN: the network is the official PyTorch code (lib/model_zoo/migan_inference.py).
The authors publish the weights as PyTorch files on Google Drive (which CI
can't download reliably) and inside their ONNX pipeline on Hugging Face
(andraniksargsyan/migan, MIT, linked from the official README); the weights
are read from that ONNX file (its initializers carry the PyTorch names; the
fixed noise of each synthesis layer was folded into one constant there and is
read back the same way). The check: (1) that PyTorch model must reproduce the
authors' ONNX pipeline exactly on 512 x 512 pictures (so the weights were read
back right), and (2) the exported model, on ONNX Runtime, must match PyTorch.

LaMa: the network is the official PyTorch code (saicinpainting FFCResNetGenerator)
with big-lama's generator weights (Hugging Face smartywu/big-lama, which the
official README links). Its Fourier units use torch.fft, which doesn't export
cleanly (complex numbers) and would need ONNX's DFT; here each 2-D real FFT
and its inverse are written as small matrix products with the DFT's cosines
and sines (the same maths; 64 x 64 at 512 px), so the model has only plain
MatMul/Conv operators that ONNX Runtime 1.24 runs on the processor and with
DirectML. The check: the matrix version must match torch.fft in PyTorch, and
the exported model, on ONNX Runtime, must match the original PyTorch model.

Thresholds (every picture, over the area that is filled): PSNR >= 40 dB for the
ONNX model against PyTorch, and >= 38 dB for MI-GAN's rebuilt PyTorch model
against the authors' pipeline (which rounds to whole 0-255 values). Pictures:
MI-GAN's own example photos with their object masks, plus centred ellipses.

Writes <out dir>/model.onnx, <out dir>/export.json (what was made and how
close it is) and the weights' model card and licence as weights-* (for the
licence check and LICENSES.txt). INPAINT_SAMPLES=<dir> also writes the
filled pictures as PNGs, for looking at.
"""

import hashlib
import importlib.util
import json
import math
import os
import pickle
import sys
import time
import types
import urllib.request
import zipfile
from pathlib import Path

import numpy as np
import torch
import torch.nn as nn
import torch.nn.functional as F
from PIL import Image

torch.set_grad_enabled(False)

ID, OUT = sys.argv[1], Path(sys.argv[2])
EXTRA = [Path(p) for p in sys.argv[3:]]
OUT.mkdir(parents=True, exist_ok=True)
CACHE = Path(os.environ.get("INPAINT_CACHE", OUT / "download"))
SAMPLES = Path(os.environ["INPAINT_SAMPLES"]) if os.environ.get("INPAINT_SAMPLES") else None
SIDE = 512
MIN_PSNR = 40.0
MIN_PSNR_PIPELINE = 38.0
OPSET = 17
# Operators the exported model may use: plain ones that ONNX Runtime 1.24 runs on the
# processor and that DirectML has (no DFT, NonZero, ScatterND, loops or dynamic shapes).
ALLOWED_OPS = {
    "Add", "Sub", "Mul", "Div", "Conv", "ConvTranspose", "MatMul", "Gemm", "Relu", "LeakyRelu", "Sigmoid", "Tanh",
    "Clip", "Concat", "Slice", "Reshape", "Transpose", "Pad", "Resize", "Constant", "Identity", "Cast", "Split",
    "Unsqueeze", "Squeeze", "BatchNormalization", "AveragePool", "MaxPool", "Max", "Min", "Neg", "Sqrt", "Pow",
    "Shape", "Gather", "Expand", "Flatten", "ReduceMean", "GlobalAveragePool", "ConstantOfShape",
}

MODELS = {
    "migan": {
        "repo": "andraniksargsyan/migan",
        "revision": "406830d0fa60666da0071c342ad2fbc8f30c5c64",
        "files": {"migan_pipeline_v2.onnx": "6f1f3530a1a2324b19752018ce756088b07973cda8d7d890034ace5c8a48c40b",
                  "README.md": None, "LICENSE": None},
        "licence": "mit",
    },
    "lama": {
        "repo": "smartywu/big-lama",
        "revision": "05cb2be7f8dbe6ca7c6e78f4fc827a4b2baaa4a9",
        "files": {"big-lama.zip": "f1b358ca24093b93a106183b98a3dea6e8ed09f3b43ea7251eb2c81e7b4575f6", "README.md": None},
        "licence": "apache-2.0",
    },
}
SPEC = MODELS[ID]


def sha256(path):
    h = hashlib.sha256()
    with open(path, "rb") as f:
        for block in iter(lambda: f.read(1 << 20), b""):
            h.update(block)
    return h.hexdigest()


def fetch(name):
    """One file of the weights' Hugging Face repository at the pinned revision (SHA-256 checked when pinned)."""
    want = SPEC["files"][name]
    CACHE.mkdir(parents=True, exist_ok=True)
    path = CACHE / name
    if not (path.is_file() and (want is None or sha256(path) == want)):
        url = f"https://huggingface.co/{SPEC['repo']}/resolve/{SPEC['revision']}/{name}"
        print(f"downloading {url}", flush=True)
        tmp = path.with_suffix(path.suffix + ".part")
        with urllib.request.urlopen(url) as r, open(tmp, "wb") as f:
            while block := r.read(1 << 20):
                f.write(block)
        tmp.replace(path)
    if want is not None and sha256(path) != want:
        raise SystemExit(f"{name}: SHA-256 doesn't match the pinned one")
    return path


def module_from(path, name):
    spec = importlib.util.spec_from_file_location(name, path)
    mod = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(mod)
    return mod


# ---- test pictures --------------------------------------------------------------------------------


def ellipse(side, rx=0.22, ry=0.3):
    yy, xx = np.mgrid[0:side, 0:side] / side
    return (((xx - 0.5) / rx) ** 2 + ((yy - 0.5) / ry) ** 2 < 1.0).astype(np.float32)


def square(im):
    return np.asarray(im.convert("RGB").resize((SIDE, SIDE), Image.BILINEAR), np.float32) / 255.0


def pictures():
    """(name, RGB 0-1 SIDE x SIDE x 3, fill mask SIDE x SIDE 0/1): MI-GAN's example photos
    with their object masks (255 = fill there), the first two again with an ellipse, and any extras."""
    src = Path(os.environ.get("MIGAN_SRC", "MI-GAN")) / "examples" / "places2_512_object"
    out = []
    names = sorted((src / "images").glob("*.png"), key=lambda p: int(p.stem) if p.stem.isdigit() else 0)[:6]
    for p in names:
        m = np.asarray(Image.open(src / "masks" / p.name).convert("L").resize((SIDE, SIDE), Image.NEAREST)) >= 128
        if not 0.002 < m.mean() < 0.6:
            raise SystemExit(f"{p.name}: its mask doesn't look like 255 = fill ({m.mean():.1%} filled)")
        out.append((f"example{p.stem}", square(Image.open(p)), m.astype(np.float32)))
    for name, im, _ in out[:2]:
        out.append((name + "-ellipse", im, ellipse(SIDE)))
    for p in EXTRA:
        out.append((p.stem, square(Image.open(p)), ellipse(SIDE)))
    if len(out) < 4:
        raise SystemExit("not enough test pictures (is MIGAN_SRC set?)")
    return out


def composite(img, fill, pred):
    """The app's blend (MI-GAN's pipeline): kept area grown 1 px (3 x 3 maximum), blurred
    (5 x 5 Gaussian, sigma 1, mirrored edges), then picture * kept + model * (1 - kept)."""
    keep = torch.from_numpy(1.0 - fill)[None, None]
    keep = F.max_pool2d(keep, 3, stride=1, padding=1)
    g = torch.exp(-((torch.arange(5, dtype=torch.float32) - 2) ** 2) / 2.0)
    k = (g[:, None] * g[None, :]) / (g.sum() ** 2)
    keep = F.conv2d(F.pad(keep, (2, 2, 2, 2), mode="reflect"), k[None, None])[0, 0].numpy()
    return img * keep[..., None] + pred * (1.0 - keep[..., None])


def psnr(a, b, where):
    """PSNR (0-1 pictures) over the pixels in `where` (the filled area, grown a little)."""
    w = where.astype(bool)
    d = ((a - b) ** 2)[w].mean() if w.any() else 0.0
    return 120.0 if d <= 1e-12 else float(10 * math.log10(1.0 / d))


def grown(fill, r=4):
    return F.max_pool2d(torch.from_numpy(fill)[None, None], 2 * r + 1, stride=1, padding=r)[0, 0].numpy() > 0.5


def save(name, a):
    if SAMPLES:
        SAMPLES.mkdir(parents=True, exist_ok=True)
        Image.fromarray((np.clip(a, 0, 1) * 255 + 0.5).astype(np.uint8)).save(SAMPLES / f"{ID}-{name}.png")


# ---- MI-GAN -------------------------------------------------------------------------------------


def migan_model():
    """The official MI-GAN 512 generator with the authors' weights (read from their ONNX pipeline)."""
    import onnx
    from onnx import numpy_helper

    mi = module_from(Path(os.environ.get("MIGAN_SRC", "MI-GAN")) / "lib" / "model_zoo" / "migan_inference.py", "migan_inference")
    gen = mi.Generator(resolution=SIDE).eval()
    pipeline = fetch("migan_pipeline_v2.onnx")
    m = onnx.load(str(pipeline))
    inits = {i.name: numpy_helper.to_array(i) for i in m.graph.initializer}
    consts = {}
    for n in m.graph.node:
        if n.op_type == "Constant":
            for a in n.attribute:
                if a.name == "value":
                    consts[n.output[0]] = numpy_helper.to_array(a.t)
    # The exporter shares identical tensors (the same fixed filter in several layers) through
    # Identity nodes named like the PyTorch tensor: follow them back to the stored one.
    for _ in range(4):
        for n in m.graph.node:
            if n.op_type == "Identity" and n.input[0] in inits and n.output[0] not in inits:
                inits[n.output[0]] = inits[n.input[0]]
    sd = gen.state_dict()
    new = {}
    for k in sd:
        if "model." + k in inits:
            new[k] = torch.from_numpy(inits["model." + k].copy())
    # The fixed noise of each synthesis layer (noise_const * noise_strength) was folded into
    # the constant added by the node /model/<path>/Add: read it back with strength 1.
    noise = {}
    for n in m.graph.node:
        if n.op_type == "Add" and n.name.startswith("/model/") and n.name.endswith("/Add"):
            for i in n.input:
                v = consts.get(i, inits.get(i))
                if v is not None and v.ndim == 2 and v.shape[0] == v.shape[1]:
                    noise[n.name[len("/model/"):-len("/Add")].replace("/", ".")] = v
    # Tensors the exporter shared between layers (the same fixed resampling filter) are found
    # through the Conv node that uses them: /model/<path>/Conv's weight is <path>.weight.
    for n in m.graph.node:
        if n.op_type == "Conv" and n.name.startswith("/model/") and n.name.endswith("/Conv") and len(n.input) > 1:
            k = n.name[len("/model/"):-len("/Conv")].replace("/", ".") + ".weight"
            v = inits.get(n.input[1], consts.get(n.input[1]))
            if k in sd and k not in new and v is not None:
                new[k] = torch.from_numpy(v.copy())
    for k in sd:
        if k.endswith(".noise_const"):
            path = k[: -len(".noise_const")]
            if path not in noise:
                raise SystemExit(f"the noise of {path} isn't in the pipeline")
            new[k] = torch.from_numpy(noise[path].copy())
            new[path + ".noise_strength"] = torch.tensor(1.0)
    missing = [k for k in sd if k not in new and not k.endswith("filter_const")]
    if missing:
        raise SystemExit(f"weights missing from the pipeline: {missing[:5]}")
    for k, v in new.items():
        if tuple(v.shape) != tuple(sd[k].shape):
            raise SystemExit(f"{k}: shape {tuple(v.shape)} in the pipeline, {tuple(sd[k].shape)} in the code")
    sd.update(new)
    gen.load_state_dict(sd, strict=True)
    print(f"MI-GAN: {len(new)} of {len(sd)} tensors from the authors' pipeline ({sum(v.numel() for v in gen.parameters()) / 1e6:.1f} M parameters)")
    return gen, pipeline


class MiganApp(nn.Module):
    """The app's interface around MI-GAN: (image 0-1, mask 1 = fill) -> picture 0-1. As the
    official pipeline: input = [known - 0.5, (image * 2 - 1) * known], output * 0.5 + 0.5."""

    def __init__(self, gen):
        super().__init__()
        self.gen = gen

    def forward(self, image, mask):
        known = 1.0 - mask
        x = torch.cat([known - 0.5, (image * 2.0 - 1.0) * known], dim=1)
        return (self.gen(x) * 0.5 + 0.5).clamp(0.0, 1.0)


def migan_pipeline_check(pipeline, pics, preds):
    """The authors' own ONNX pipeline (uint8 in and out; 255 = keep) against our blend of the
    rebuilt PyTorch model: at 512 x 512 it works on the whole picture, so the two must agree."""
    import onnxruntime as ort

    s = ort.InferenceSession(str(pipeline), providers=["CPUExecutionProvider"])
    rows = []
    for (name, img, fill), pred in zip(pics, preds):
        u8 = (img * 255 + 0.5).astype(np.uint8)
        keep = ((1 - fill) * 255).astype(np.uint8)
        got = s.run(None, {"image": u8.transpose(2, 0, 1)[None], "mask": keep[None, None]})[0][0].transpose(1, 2, 0) / 255.0
        ours = composite(u8 / 255.0, fill, pred)
        p = psnr(got, ours, grown(fill))
        rows.append({"picture": name, "psnrVsAuthorsPipeline": p})
        print(f"  {name}: rebuilt PyTorch vs the authors' pipeline {p:.1f} dB", flush=True)
    return rows


# ---- LaMa -------------------------------------------------------------------------------------


def stub_modules():
    """The parts of the LaMa code base the generator doesn't use (training, kornia's rotate)."""
    pl = types.ModuleType("pytorch_lightning")
    pl.seed_everything = lambda *a, **k: None
    sys.modules.setdefault("pytorch_lightning", pl)
    for name in ("kornia", "kornia.geometry", "kornia.geometry.transform"):
        sys.modules.setdefault(name, types.ModuleType(name))
    sys.modules["kornia.geometry.transform"].rotate = lambda *a, **k: (_ for _ in ()).throw(RuntimeError("not used"))


class _Anything:
    """Stands in for classes in the checkpoint that only training needs."""

    def __init__(self, *a, **k):
        pass

    def __setstate__(self, state):
        pass

    def __call__(self, *a, **k):
        return self


class _Unpickler(pickle.Unpickler):
    def find_class(self, module, name):
        if module.startswith(("torch", "collections", "numpy", "builtins", "_codecs")):
            return super().find_class(module, name)
        return _Anything


def lama_model():
    import yaml

    stub_modules()
    sys.path.insert(0, str(Path(os.environ.get("LAMA_SRC", "lama")).resolve()))
    from saicinpainting.training.modules import ffc

    work = CACHE / "big-lama"
    # Unzipped once (the marker names the checked zip it came from).
    marker = work / f".from-{SPEC['files']['big-lama.zip']}"
    if not (marker.is_file() and (work / "big-lama" / "models" / "best.ckpt").is_file()):
        z = fetch("big-lama.zip")
        with zipfile.ZipFile(z) as f:
            f.extractall(work)
        marker.write_text("checked\n")
        z.unlink()
    cfg = yaml.safe_load((work / "big-lama" / "config.yaml").read_text())["generator"]
    # The config's ${...} links, resolved as OmegaConf would.
    init = dict(cfg["init_conv_kwargs"])
    down = dict(cfg["downsample_conv_kwargs"], ratio_gin=init["ratio_gout"])
    down["ratio_gout"] = down["ratio_gin"]
    res = dict(cfg["resnet_conv_kwargs"])
    res["ratio_gout"] = res["ratio_gin"]
    kw = {k: v for k, v in cfg.items() if k not in ("kind", "init_conv_kwargs", "downsample_conv_kwargs", "resnet_conv_kwargs")}
    if cfg["kind"] != "ffc_resnet":
        raise SystemExit(f"unexpected generator {cfg['kind']}")
    gen = ffc.FFCResNetGenerator(init_conv_kwargs=init, downsample_conv_kwargs=down, resnet_conv_kwargs=res, **kw).eval()
    pm = types.ModuleType("lama_pickle")
    pm.Unpickler = _Unpickler
    pm.load = pickle.load
    pm.__name__ = "lama_pickle"
    ckpt = torch.load(work / "big-lama" / "models" / "best.ckpt", map_location="cpu", pickle_module=pm, weights_only=False)
    state = ckpt["state_dict"] if isinstance(ckpt, dict) and "state_dict" in ckpt else ckpt
    sd = {k[len("generator."):]: v for k, v in state.items() if k.startswith("generator.")}
    gen.load_state_dict(sd, strict=True)
    print(f"LaMa: {len(sd)} tensors, {sum(v.numel() for v in gen.parameters()) / 1e6:.1f} M parameters ({cfg})")
    return gen, ffc


def _dft(n, half=False, weights=False):
    """cos and sin of 2 pi k m / n (n x n), or n x (n/2 + 1) for the half spectrum of a real
    signal; with `weights`, transposed and weighted for the inverse (1 at 0 and n/2, else 2).
    Made with numpy, so they go into the model as plain constants."""
    k = np.arange(n, dtype=np.float64)
    l = np.arange(n // 2 + 1, dtype=np.float64) if half else k
    a = 2 * np.pi * k[:, None] * l[None, :] / n
    c, s = np.cos(a), np.sin(a)
    if weights:
        wt = np.full(len(l), 2.0)
        wt[0] = 1.0
        if n % 2 == 0:
            wt[-1] = 1.0
        c, s = (c * wt).T, (s * wt).T
    return torch.from_numpy(np.ascontiguousarray(c, np.float32)), torch.from_numpy(np.ascontiguousarray(s, np.float32))


def rfft2_matmul(x):
    """torch.fft.rfftn(x, dim=(-2, -1), norm='ortho') as (real, imaginary), with matrix products."""
    h, w = int(x.shape[-2]), int(x.shape[-1])
    cw, sw = _dft(w, half=True)  # w x half
    ch, sh = _dft(h)
    re1, im1 = x @ cw, -(x @ sw)
    re = ch @ re1 + sh @ im1
    im = ch @ im1 - sh @ re1
    s = 1.0 / math.sqrt(h * w)
    return re * s, im * s


def irfft2_matmul(re, im, h, w):
    """torch.fft.irfftn(re + i im, s=(h, w), dim=(-2, -1), norm='ortho'), with matrix products
    (like torch, the imaginary parts at 0 and w/2 are ignored)."""
    ch, sh = _dft(h)
    yr = ch @ re - sh @ im
    yi = ch @ im + sh @ re
    ci, si = _dft(w, half=True, weights=True)  # half x w
    out = yr @ ci - yi @ si
    return out / math.sqrt(h * w)


def fourier_unit_matmul(self, x):
    """FourierUnit.forward of LaMa (2-D, no positional encoding, no squeeze-excitation) with
    the matrix FFT: the same maths as the original, in plain operators."""
    assert not self.ffc3d and not self.spectral_pos_encoding and not self.use_se and self.fft_norm == "ortho"
    # Plain numbers for every size (the model's size is fixed), so no shape arithmetic is exported.
    batch = int(x.shape[0])
    if self.spatial_scale_factor is not None:
        orig_size = tuple(int(v) for v in x.shape[-2:])
        x = F.interpolate(x, scale_factor=self.spatial_scale_factor, mode=self.spatial_scale_mode, align_corners=False)
    h, w = int(x.shape[-2]), int(x.shape[-1])
    re, im = rfft2_matmul(x)
    c = int(x.shape[1])
    ffted = torch.stack((re, im), dim=2).reshape(batch, c * 2, h, w // 2 + 1)  # (batch, c, 2, h, half) as the original
    ffted = self.conv_layer(ffted)
    ffted = self.relu(self.bn(ffted))
    ffted = ffted.reshape(batch, int(ffted.shape[1]) // 2, 2, h, w // 2 + 1)
    output = irfft2_matmul(ffted[:, :, 0], ffted[:, :, 1], h, w)
    if self.spatial_scale_factor is not None:
        output = F.interpolate(output, size=orig_size, mode=self.spatial_scale_mode, align_corners=False)
    return output


class LamaApp(nn.Module):
    """The app's interface around LaMa: as its predict.py, input = [image * (1 - mask), mask],
    the generator's output (0-1, it ends in a sigmoid) is the picture."""

    def __init__(self, gen):
        super().__init__()
        self.gen = gen

    def forward(self, image, mask):
        x = torch.cat([image * (1.0 - mask), mask], dim=1)
        return self.gen(x).clamp(0.0, 1.0)


# ---- the export and the check ----------------------------------------------------------------------


def to_tensors(img, fill):
    return torch.from_numpy(img.transpose(2, 0, 1)[None].copy()), torch.from_numpy(fill[None, None].copy())


def main():
    import onnx
    import onnxruntime as ort

    print(f"ONNX Runtime {ort.__version__}, onnx {onnx.__version__}, torch {torch.__version__}")
    want_ort = os.environ.get("INPAINT_ORT")
    if want_ort and not ort.__version__.startswith(want_ort):
        raise SystemExit(f"the check must run on ONNX Runtime {want_ort} (the version the app ships), not {ort.__version__}")
    pics = pictures()
    extra_rows = {}
    if ID == "migan":
        gen, pipeline = migan_model()
        app = MiganApp(gen).eval()
    else:
        gen, ffc = lama_model()
        app = LamaApp(gen).eval()

    # The reference: the PyTorch model as published.
    refs = []
    for name, img, fill in pics:
        t = time.time()
        refs.append(app(*to_tensors(img, fill))[0].numpy().transpose(1, 2, 0))
        print(f"  PyTorch {name}: {time.time() - t:.1f} s, {fill.mean():.0%} filled", flush=True)

    if ID == "migan":
        rows = migan_pipeline_check(pipeline, pics, refs)
        worst = min(r["psnrVsAuthorsPipeline"] for r in rows)
        if worst < MIN_PSNR_PIPELINE:
            raise SystemExit(f"the rebuilt MI-GAN doesn't match the authors' pipeline ({worst:.1f} dB < {MIN_PSNR_PIPELINE})")
        extra_rows = {r["picture"]: r for r in rows}
    else:
        # The matrix FFT in PyTorch first: it must give the original's answer.
        x = torch.randn(2, 3, 64, 64)
        ref = torch.fft.rfftn(x, dim=(-2, -1), norm="ortho")
        re, im = rfft2_matmul(x)
        back = irfft2_matmul(re, im, 64, 64)
        d1 = max(float((re - ref.real).abs().max()), float((im - ref.imag).abs().max()))
        d2 = float((back - x).abs().max())
        print(f"matrix FFT: forward max difference {d1:.2e}, round trip {d2:.2e}")
        if d1 > 1e-4 or d2 > 1e-4:
            raise SystemExit("the matrix FFT doesn't match torch.fft")
        ffc.FourierUnit.forward = fourier_unit_matmul
        name, img, fill = pics[0]
        got = app(*to_tensors(img, fill))[0].numpy().transpose(1, 2, 0)
        p = psnr(refs[0], got, grown(fill))
        print(f"matrix FFT in the whole model ({name}): {p:.1f} dB against torch.fft")
        if p < MIN_PSNR + 5:
            raise SystemExit("the model with the matrix FFT doesn't match the original")

    path = OUT / "model.onnx"
    name, img, fill = pics[0]
    t = time.time()
    torch.onnx.export(app, to_tensors(img, fill), str(path), dynamo=False, input_names=["image", "mask"], output_names=["result"],
                      opset_version=OPSET, do_constant_folding=True)
    print(f"exported in {time.time() - t:.0f} s: {path.stat().st_size / 2**20:.0f} MB")
    m = onnx.shape_inference.infer_shapes(onnx.load(str(path)))
    # The exporter can leave the output's size open: it is fixed (the input's), so say so.
    for d, n in zip(m.graph.output[0].type.tensor_type.shape.dim, (1, 3, SIDE, SIDE)):
        if d.dim_value in (0, n):
            d.ClearField("dim_param")
            d.dim_value = n
    onnx.save(m, str(path))
    onnx.checker.check_model(m)
    ops = sorted({n.op_type for n in m.graph.node})
    odd = [o for o in ops if o not in ALLOWED_OPS]
    print("operators:", ", ".join(ops))
    if odd:
        raise SystemExit(f"operators the app's ONNX Runtime may not run well (DirectML): {odd}")
    for v in list(m.graph.input) + list(m.graph.output):
        dims = [d.dim_value for d in v.type.tensor_type.shape.dim]
        if v.type.tensor_type.elem_type != onnx.TensorProto.FLOAT or 0 in dims:
            raise SystemExit(f"{v.name}: not a fixed-size float32 tensor ({dims})")

    # The exported model on ONNX Runtime (processor), against PyTorch.
    so = ort.SessionOptions()
    so.enable_cpu_mem_arena = False
    s = ort.InferenceSession(str(path), so, providers=["CPUExecutionProvider"])
    rows = []
    for (name, img, fill), ref in zip(pics, refs):
        im_t, m_t = to_tensors(img, fill)
        t = time.time()
        got = s.run(None, {"image": im_t.numpy(), "mask": m_t.numpy()})[0][0].transpose(1, 2, 0)
        ms = (time.time() - t) * 1000
        where = grown(fill)
        p = psnr(ref, got, where)
        diff = float(np.abs(ref - got)[where].max())
        row = {"picture": name, "psnr": p, "maxDiff": diff, "filled": float(fill.mean()), "cpuMs": ms}
        row.update({k: v for k, v in extra_rows.get(name, {}).items() if k != "picture"})
        rows.append(row)
        print(f"  ONNX {name}: {p:.1f} dB against PyTorch (max difference {diff:.4f}), CPU {ms:.0f} ms", flush=True)
        save(name, composite(img, fill, got))
        save(name + "-input", img * (1 - fill[..., None]) + fill[..., None] * np.array([1.0, 0.0, 1.0]))

    worst = min(r["psnr"] for r in rows)
    print(f"worst {worst:.1f} dB over {len(rows)} pictures")
    if len(rows) < 4 or worst < MIN_PSNR:
        raise SystemExit(f"the ONNX model doesn't match PyTorch (need >= {MIN_PSNR} dB on every picture)")

    # The weights' model card (and MI-GAN's licence file) for the licence check and LICENSES.txt.
    (OUT / "weights-README.md").write_bytes(fetch("README.md").read_bytes())
    if "LICENSE" in SPEC["files"]:
        (OUT / "weights-LICENSE").write_bytes(fetch("LICENSE").read_bytes())
    made = {
        "id": ID, "repo": SPEC["repo"], "revision": SPEC["revision"], "side": SIDE, "fp16": False, "opset": OPSET,
        "inputs": {"image": "1x3x512x512 RGB 0-1", "mask": "1x1x512x512, 1 = fill"}, "output": "1x3x512x512 RGB 0-1",
        "operators": ops, "onnxruntime": ort.__version__, "torch": torch.__version__,
        "check": {"against": "the original PyTorch model" + (" (rebuilt from the authors' ONNX pipeline and checked against it)" if ID == "migan" else ""),
                  "minPsnr": MIN_PSNR, **({"minPsnrVsAuthorsPipeline": MIN_PSNR_PIPELINE} if ID == "migan" else {})},
        "worstPsnr": worst, "pictures": rows, "sizeBytes": path.stat().st_size, "sha256": sha256(path),
    }
    if ID == "lama":
        made["fft"] = "2-D real FFT and inverse as MatMul with DFT cosines/sines (same maths as torch.fft, norm ortho)"
    (OUT / "export.json").write_text(json.dumps(made, indent=2))
    print(json.dumps({k: v for k, v in made.items() if k != "pictures"}, indent=2))


if __name__ == "__main__":
    main()
