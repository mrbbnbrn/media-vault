"""Score WebP thumbnail qualities against the JPEG quality 86 they replace.

Run the app's encoders on real photos first (they write every picture's
640 px reference PNG, its JPEG q86 and WebP at several qualities):

    MV_CORPUS=<folder of photos> MV_OUT=<out> \
      cargo test -p media-vault-app webp_quality_corpus -- --ignored --nocapture

then score them (needs numpy, Pillow, scikit-image):

    python3 tools/thumbquality.py <out>

For each WebP quality: the median size compared with JPEG q86, the median
SSIM and PSNR, and on how many photos it is at least as close to the
reference as the JPEG. Pick the lowest quality that matches the JPEG.
"""
import glob
import os
import statistics
import sys

import numpy as np
from PIL import Image
from skimage.metrics import peak_signal_noise_ratio as psnr
from skimage.metrics import structural_similarity as ssim


def load(p):
    return np.asarray(Image.open(p).convert('RGB'))


def main(out):
    refs = sorted(glob.glob(os.path.join(out, '*.ref.png')))
    rows = []
    for r in refs:
        stem = r[: -len('.ref.png')]
        ref = load(r)
        j = stem + '.jpg86.jpg'
        js = ssim(ref, load(j), channel_axis=2, data_range=255)
        jp = psnr(ref, load(j))
        w = {}
        for p in glob.glob(stem + '.webp*.webp'):
            q = float(p[len(stem) + 5: -5])
            d = load(p)
            w[q] = (os.path.getsize(p), ssim(ref, d, channel_axis=2, data_range=255), psnr(ref, d))
        rows.append((os.path.getsize(j), js, jp, w))
    if not rows:
        sys.exit('no pictures found in ' + out)
    print(f'{len(rows)} photos; JPEG q86: median {statistics.median(r[0] for r in rows) / 1024:.1f} KB, '
          f'SSIM {statistics.median(r[1] for r in rows):.4f}, PSNR {statistics.median(r[2] for r in rows):.2f} dB')
    for q in sorted(rows[0][3]):
        size = statistics.median(r[3][q][0] / r[0] for r in rows)
        total = sum(r[3][q][0] for r in rows) / sum(r[0] for r in rows)
        s = statistics.median(r[3][q][1] for r in rows)
        p = statistics.median(r[3][q][2] for r in rows)
        s_ok = sum(r[3][q][1] >= r[1] for r in rows)
        p_ok = sum(r[3][q][2] >= r[2] for r in rows)
        print(f'WebP q{q:g}: size {size:.2f}× (all together {total:.2f}×), SSIM {s:.4f} '
              f'(≥ JPEG on {s_ok}/{len(rows)}), PSNR {p:.2f} dB (≥ JPEG on {p_ok}/{len(rows)})')


if __name__ == '__main__':
    main(sys.argv[1])
