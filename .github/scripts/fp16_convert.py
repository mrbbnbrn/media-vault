"""Turns the "Fast" 3D-photo depth model (Depth Anything V2 Small, fp32, the
exact file the depth pack ships) into a half-precision (float16) copy for the
"Fast (half precision)" pack, and checks it against the fp32 model.

Used by .github/workflows/depthhalf.yml.

  python fp16_convert.py <fp32 model.onnx> <out model.onnx> [pictures...]

The weights and the maths inside become float16; the input and output stay
float32 (keep_io_types), so the app feeds and reads it exactly like Fast. The
pack is marked graphics-card only ("gpuOnly": true in depth.json): half
precision is what makes it quicker on a graphics card (DirectML), and on the
processor it would be slower or stall, so the app never runs it there.

The check runs both models on ONNX Runtime (the processor; the check is about
the numbers, not the speed) on several pictures: the depth maps' correlation
must be >= 0.995 on every picture (and nothing may come out not-a-number), else
the job fails. Pictures: scikit-image's sample photos, any given, and a
synthetic scene. Writes <out>.json with what was made and how close it is.
"""

import hashlib
import json
import sys
import time
from pathlib import Path

import numpy as np
import onnx
import onnx.inliner
import onnxruntime as ort
from onnxconverter_common import float16
from PIL import Image

SRC, DST = Path(sys.argv[1]), Path(sys.argv[2])
EXTRA = [Path(p) for p in sys.argv[3:]]
SIDE = 518
MEAN = np.array([0.485, 0.456, 0.406], np.float32)
STD = np.array([0.229, 0.224, 0.225], np.float32)
MIN_CORR = 0.995


def sha256(path):
    h = hashlib.sha256()
    with open(path, "rb") as f:
        for block in iter(lambda: f.read(1 << 20), b""):
            h.update(block)
    return h.hexdigest()


def pictures():
    out = []
    try:
        from skimage import data

        for name in ("astronaut", "chelsea", "coffee", "rocket", "camera"):
            try:
                out.append((name, Image.fromarray(getattr(data, name)()).convert("RGB")))
            except Exception as e:  # noqa: BLE001 — a missing sample is fine, the others still count
                print(f"(sample {name} not available: {e})")
    except ImportError:
        print("(scikit-image not installed: no sample photos)")
    for p in EXTRA:
        out.append((p.stem, Image.open(p).convert("RGB")))
    # A synthetic scene: a floor going away, a wall, a ball in front.
    yy, xx = np.mgrid[0:SIDE, 0:SIDE] / SIDE
    synth = np.stack([0.3 + 0.5 * yy, 0.35 + 0.3 * yy, 0.6 - 0.2 * yy], -1)
    synth[yy < 0.45] = [0.75, 0.72, 0.65]
    synth[(xx - 0.45) ** 2 + (yy - 0.65) ** 2 < 0.02] = [0.85, 0.2, 0.15]
    out.append(("synthetic", Image.fromarray((synth * 255).astype(np.uint8))))
    res = []
    for name, im in out:
        a = np.asarray(im.resize((SIDE, SIDE), Image.BICUBIC), np.float32) / 255.0
        res.append((name, ((a - MEAN) / STD).transpose(2, 0, 1)[None].astype(np.float32)))
    return res


def session(path):
    so = ort.SessionOptions()
    so.enable_cpu_mem_arena = False
    return ort.InferenceSession(str(path), so, providers=["CPUExecutionProvider"])


def main():
    print(f"ONNX Runtime {ort.__version__}, onnx {onnx.__version__}")
    m = onnx.load(str(SRC))
    # The export keeps each layer as a model-local function (torch's dynamo exporter): put them
    # inline first, so every operator is converted (the converter doesn't look inside functions).
    if len(m.functions):
        m = onnx.inliner.inline_local_functions(m)
        print(f"inlined: {len(m.graph.node)} operators, {len(m.functions)} functions left")
    # Sizes are fixed (518 x 518), so the arithmetic the exporter left for them (shapes, Resize
    # scales) folds into constants: ONNX Runtime's basic, standard-operator-only optimisations.
    # Otherwise the converter would turn those float32 helper values to float16 too.
    inlined = DST.with_name(DST.stem + "-fp32-inlined.onnx")
    folded = DST.with_name(DST.stem + "-fp32-folded.onnx")
    onnx.save(m, str(inlined))
    so = ort.SessionOptions()
    so.graph_optimization_level = ort.GraphOptimizationLevel.ORT_ENABLE_BASIC
    so.optimized_model_filepath = str(folded)
    ort.InferenceSession(str(inlined), so, providers=["CPUExecutionProvider"])
    m = onnx.load(str(folded))
    inlined.unlink()
    folded.unlink()
    print(f"folded: {len(m.graph.node)} operators")
    # Resize stays float32 (its scales must be float32; it is cheap): the converter puts casts around it.
    block = list(float16.DEFAULT_OP_BLOCK_LIST) + ["Resize"]
    half = float16.convert_float_to_float16(m, keep_io_types=True, op_block_list=block)
    # The model's own casts to float32 (the exporter's) now feed float16 maths: they cast to
    # float16 instead (the converter turns their outputs' types, not their "to").
    types = {v.name: v.type.tensor_type.elem_type for v in half.graph.value_info}
    fixed = 0
    for n in half.graph.node:
        if n.op_type == "Cast" and types.get(n.output[0]) == onnx.TensorProto.FLOAT16:
            for a in n.attribute:
                if a.name == "to" and a.i == onnx.TensorProto.FLOAT:
                    a.i = onnx.TensorProto.FLOAT16
                    fixed += 1
    print(f"{fixed} casts now give float16")
    # LayerNormalization's mean and spread outputs are float32 by definition: unused ones go,
    # used ones keep their float32 type.
    used = {i for n in half.graph.node for i in n.input} | {o.name for o in half.graph.output}
    vi = {v.name: v for v in half.graph.value_info}
    for n in half.graph.node:
        if n.op_type == "LayerNormalization":
            for k in range(1, len(n.output)):
                if n.output[k] and n.output[k] not in used:
                    n.output[k] = ""
                elif n.output[k] in vi:
                    vi[n.output[k]].type.tensor_type.elem_type = onnx.TensorProto.FLOAT
            while len(n.output) > 1 and not n.output[-1]:
                n.output.pop()
    onnx.checker.check_model(half)
    for v in list(half.graph.input) + list(half.graph.output):
        if v.type.tensor_type.elem_type != onnx.TensorProto.FLOAT:
            raise SystemExit(f"{v.name} isn't float32 any more (keep_io_types)")
    onnx.save(half, str(DST))
    print(f"{SRC.name}: {SRC.stat().st_size / 2**20:.0f} MB -> {DST.name}: {DST.stat().st_size / 2**20:.0f} MB")

    full, small = session(SRC), session(DST)
    name_in = full.get_inputs()[0].name
    rows = []
    for name, x in pictures():
        t = time.time()
        a = full.run(None, {name_in: x})[0].astype(np.float64).ravel()
        t1 = time.time()
        b = small.run(None, {small.get_inputs()[0].name: x})[0].astype(np.float64).ravel()
        t2 = time.time()
        if a.shape != b.shape or not np.isfinite(b).all():
            raise SystemExit(f"{name}: the half-precision model gave {b.shape} with odd values")
        corr = float(np.corrcoef(a, b)[0, 1])
        rel = float(np.abs(a - b).max() / max(np.abs(a).max(), 1e-6))
        rows.append({"picture": name, "correlation": corr, "maxRelativeDiff": rel, "fp32CpuMs": (t1 - t) * 1000, "fp16CpuMs": (t2 - t1) * 1000})
        print(f"  {name}: correlation {corr:.6f}, max relative difference {rel:.4f}", flush=True)
    worst = min(r["correlation"] for r in rows)
    print(f"worst correlation {worst:.6f} over {len(rows)} pictures")
    if len(rows) < 3 or worst < MIN_CORR:
        raise SystemExit(f"the half-precision model doesn't match the fp32 one (need correlation >= {MIN_CORR} on every picture)")
    made = {"source": SRC.name, "sourceSha256": sha256(SRC), "fp16": True, "keepIoTypes": True, "side": SIDE,
            "check": {"against": "the fp32 model (ONNX Runtime, processor)", "minCorrelation": MIN_CORR},
            "worstCorrelation": worst, "pictures": rows, "onnxruntime": ort.__version__,
            "sizeBytes": DST.stat().st_size, "sha256": sha256(DST)}
    DST.with_suffix(".json").write_text(json.dumps(made, indent=2))


if __name__ == "__main__":
    main()
