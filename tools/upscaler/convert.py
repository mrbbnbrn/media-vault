"""Turn the official Real-ESRGAN x4plus and GFPGAN v1.4 weights into ONNX
models for Media Vault's offline upscaler (used by .github/workflows/upscaler.yml).

    python -I convert.py --archs ARCH_DIR --realesrgan RealESRGAN_x4plus.pth \
        --gfpgan GFPGANv1.4.pth --out OUT_DIR

ARCH_DIR holds the network definitions, unchanged, from the official repos at
pinned commits (the workflow downloads them):
    rrdbnet_arch.py          XPixelGroup/BasicSR  basicsr/archs/rrdbnet_arch.py
    gfpganv1_clean_arch.py   TencentARC/GFPGAN    gfpgan/archs/gfpganv1_clean_arch.py
    stylegan2_clean_arch.py  TencentARC/GFPGAN    gfpgan/archs/stylegan2_clean_arch.py

Their only outside needs (BasicSR's registry and three small helpers) are
provided here, so neither BasicSR nor GFPGAN has to be installed.

Each model is checked after export: ONNX Runtime (CPU) must give the same
result as PyTorch on a test input.

Outputs (float32, opset 17):
    realesrgan-x4plus.onnx  input  "input"  1x3xHxW RGB 0..1   -> 1x3x4Hx4W RGB 0..1
                            (H and W can be anything; the app always uses 192)
    gfpgan-v1.4.onnx        input  "input"  1x3x512x512 RGB -1..1 (aligned FFHQ face)
                                                         -> 1x3x512x512 RGB -1..1
"""

import argparse
import importlib.util
import math
import sys
import types
from pathlib import Path

import numpy as np
import torch
from torch import nn
from torch.nn import init as nn_init


# ---- what the architecture files import from BasicSR ------------------------------------
# (the same code as basicsr/archs/arch_util.py and basicsr/utils/registry.py, v1.4.2)

class _Registry:
    def register(self, obj=None):
        if obj is None:
            return lambda o: o
        return obj


@torch.no_grad()
def default_init_weights(module_list, scale=1, bias_fill=0, **kwargs):
    if not isinstance(module_list, list):
        module_list = [module_list]
    for module in module_list:
        for m in module.modules():
            if isinstance(m, (nn.Conv2d, nn.Linear)):
                nn_init.kaiming_normal_(m.weight, **kwargs)
                m.weight.data *= scale
                if m.bias is not None:
                    m.bias.data.fill_(bias_fill)
            elif isinstance(m, nn.modules.batchnorm._BatchNorm):
                nn_init.constant_(m.weight, 1)
                if m.bias is not None:
                    m.bias.data.fill_(bias_fill)


def make_layer(basic_block, num_basic_block, **kwarg):
    return nn.Sequential(*[basic_block(**kwarg) for _ in range(num_basic_block)])


def pixel_unshuffle(x, scale):
    b, c, hh, hw = x.size()
    out_channel = c * (scale**2)
    assert hh % scale == 0 and hw % scale == 0
    h = hh // scale
    w = hw // scale
    x_view = x.view(b, c, h, scale, w, scale)
    return x_view.permute(0, 1, 3, 5, 2, 4).reshape(b, out_channel, h, w)


def _install_basicsr_stub():
    def mod(name, **attrs):
        m = types.ModuleType(name)
        m.__dict__.update(attrs)
        m.__path__ = []  # a package, so submodules can be found
        sys.modules[name] = m
        return m

    mod('basicsr')
    mod('basicsr.utils')
    mod('basicsr.utils.registry', ARCH_REGISTRY=_Registry())
    mod('basicsr.archs')
    mod('basicsr.archs.arch_util', default_init_weights=default_init_weights, make_layer=make_layer,
        pixel_unshuffle=pixel_unshuffle)
    mod('gfpgan_archs')


def _load(name, path):
    spec = importlib.util.spec_from_file_location(name, path)
    m = importlib.util.module_from_spec(spec)
    sys.modules[name] = m
    spec.loader.exec_module(m)
    return m


# ---- export ---------------------------------------------------------------------------------

class _GFPGANOnly(nn.Module):
    """GFPGAN as GFPGANer runs it: the restored face only, no random noise."""

    def __init__(self, net):
        super().__init__()
        self.net = net

    def forward(self, x):
        return self.net(x, return_rgb=False, randomize_noise=False)[0]


def _weights(path):
    ck = torch.load(path, map_location='cpu', weights_only=True)
    return ck['params_ema'] if 'params_ema' in ck else ck['params']


def _export(model, sample, out, dynamic):
    kw = dict(input_names=['input'], output_names=['output'], opset_version=17, do_constant_folding=True)
    if dynamic:
        kw['dynamic_axes'] = {'input': {2: 'height', 3: 'width'}, 'output': {2: 'height4', 3: 'width4'}}
    try:
        torch.onnx.export(model, (sample,), str(out), dynamo=False, **kw)
    except TypeError:  # older PyTorch without the dynamo switch
        torch.onnx.export(model, (sample,), str(out), **kw)


def _check(model, onnx_path, sample, tol):
    import onnxruntime as ort
    with torch.no_grad():
        want = model(sample).numpy()
    sess = ort.InferenceSession(str(onnx_path), providers=['CPUExecutionProvider'])
    got = sess.run(None, {'input': sample.numpy()})[0]
    diff = float(np.abs(want - got).max())
    print(f'{onnx_path.name}: output {got.shape}, largest difference from PyTorch {diff:.2e}')
    if got.shape != want.shape or not math.isfinite(diff) or diff > tol:
        raise SystemExit(f'{onnx_path.name} does not match PyTorch (difference {diff})')


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument('--archs', required=True, type=Path)
    ap.add_argument('--realesrgan', required=True, type=Path)
    ap.add_argument('--gfpgan', required=True, type=Path)
    ap.add_argument('--out', required=True, type=Path)
    a = ap.parse_args()
    a.out.mkdir(parents=True, exist_ok=True)
    torch.manual_seed(0)
    _install_basicsr_stub()

    rrdb = _load('basicsr.archs.rrdbnet_arch', a.archs / 'rrdbnet_arch.py')
    esrgan = rrdb.RRDBNet(num_in_ch=3, num_out_ch=3, num_feat=64, num_block=23, num_grow_ch=32, scale=4)
    esrgan.load_state_dict(_weights(a.realesrgan), strict=True)
    esrgan.eval()
    out = a.out / 'realesrgan-x4plus.onnx'
    _export(esrgan, torch.rand(1, 3, 64, 64), out, dynamic=True)
    _check(esrgan, out, torch.rand(1, 3, 96, 80), 2e-3)

    _load('gfpgan_archs.stylegan2_clean_arch', a.archs / 'stylegan2_clean_arch.py')
    gfp = _load('gfpgan_archs.gfpganv1_clean_arch', a.archs / 'gfpganv1_clean_arch.py')
    # The settings GFPGANer uses for v1.4 ("clean" architecture).
    net = gfp.GFPGANv1Clean(out_size=512, num_style_feat=512, channel_multiplier=2, decoder_load_path=None,
                            fix_decoder=False, num_mlp=8, input_is_latent=True, different_w=True, narrow=1,
                            sft_half=True)
    net.load_state_dict(_weights(a.gfpgan), strict=True)
    face = _GFPGANOnly(net).eval()
    out = a.out / 'gfpgan-v1.4.onnx'
    sample = torch.rand(1, 3, 512, 512) * 2 - 1
    _export(face, sample, out, dynamic=False)
    _check(face, out, torch.rand(1, 3, 512, 512) * 2 - 1, 5e-3)


if __name__ == '__main__':
    main()
