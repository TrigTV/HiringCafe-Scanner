"""
Run this once to generate the PNG icons needed by the extension.
Requires Pillow: pip install Pillow
"""
import os
from PIL import Image, ImageDraw, ImageFont

def make_icon(size):
    img = Image.new('RGBA', (size, size), (0, 0, 0, 0))
    draw = ImageDraw.Draw(img)

    # Background circle
    pad = size // 8
    draw.ellipse([pad, pad, size - pad, size - pad], fill=(99, 102, 241))

    # Simple document icon
    center = size // 2
    w = int(size * 0.35)
    h = int(size * 0.45)
    x0 = center - w // 2
    y0 = center - h // 2
    fold = w // 3

    # Document body
    draw.polygon([
        (x0, y0 + fold),
        (x0, y0 + h),
        (x0 + w, y0 + h),
        (x0 + w, y0),
        (x0 + fold, y0),
    ], fill='white')

    # Fold
    draw.polygon([
        (x0, y0 + fold),
        (x0 + fold, y0 + fold),
        (x0 + fold, y0),
    ], fill=(180, 185, 255))

    # Lines on document
    lx0 = x0 + w // 4
    lx1 = x0 + w - w // 4
    for i, frac in enumerate([0.45, 0.58, 0.71]):
        ly = int(y0 + h * frac)
        draw.rectangle([lx0, ly, lx1, ly + max(1, size // 24)], fill=(99, 102, 241))

    return img

os.makedirs('icons', exist_ok=True)
for size in [16, 48, 128]:
    img = make_icon(size)
    img.save(f'icons/icon{size}.png')
    print(f'Created icons/icon{size}.png')

print('Icons generated successfully!')
