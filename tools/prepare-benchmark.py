#!/usr/bin/env python3
"""Подготовка кадров для бенчмарка: кроп и ресемплинг как в приложении.

Читает фотографии из папки, для каждой строит кадры под наборы Classic S
(1:1) и Classic M (2:3) и складывает в benchmark/frames. Сами фотографии в
репозиторий не попадают — только их кадры для локального прогона.

    python3 tools/prepare-benchmark.py ~/photos
"""
import glob, json, os, sys
from PIL import Image, ImageOps

src = sys.argv[1] if len(sys.argv) > 1 else 'benchmark/photos'
out = 'benchmark/frames'
os.makedirs(out, exist_ok=True)
presets = {'classic-s': (960, 960), 'classic-m': (832, 1248)}
photos = sorted(p for p in glob.glob(f'{src}/*') if p.lower().endswith(('.jpg', '.jpeg', '.png')))

for path in photos:
    tag = os.path.basename(path).rsplit('.', 1)[0][:24]
    im = ImageOps.exif_transpose(Image.open(path)).convert('RGB')
    for pid, (w, h) in presets.items():
        W, H = im.size; t = w / h
        if W / H > t: cw = int(H * t); box = ((W - cw) // 2, 0, (W - cw) // 2 + cw, H)
        else: ch = int(W / t); box = (0, (H - ch) // 2, W, (H - ch) // 2 + ch)
        crop = im.crop(box).resize((w, h), Image.LANCZOS).convert('RGBA')
        open(f'{out}/{tag}-{pid}.raw', 'wb').write(crop.tobytes())
        json.dump({'preset': pid, 'w': w, 'h': h, 'photo': os.path.basename(path)}, open(f'{out}/{tag}-{pid}.json', 'w'))
print(f'кадров: {len(photos) * len(presets)} из {len(photos)} фотографий → {out}')
