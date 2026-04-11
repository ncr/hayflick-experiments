#!/usr/bin/env python3
"""
Pixel-art stylization pass for a baked sprite PNG.

Takes a raw EEVEE render of a tile and applies a classic-pixel-art transform:

1. Contrast and saturation boost (makes the quantization "bite" cleanly).
2. Colour quantization to a small palette per sprite (median-cut, optional
   Floyd-Steinberg dither).
3. Silhouette outline: darken every opaque pixel that touches a transparent
   neighbour, giving the tile a readable 1px border at any zoom.

Everything else about the render stays as-is — the projection, the
dimensions, and the anchor pixel in the sidecar JSON remain valid.

Uses system python3 + PIL so it doesn't depend on Blender's bundled Python.

Usage:
    python3 scripts/pixel-art-pass.py \\
        --input raw/wall.png \\
        --output styled/wall.png \\
        --palette-size 16 \\
        --dither
"""

import os
import sys
from argparse import ArgumentParser

try:
    from PIL import Image, ImageEnhance
except ImportError:
    sys.stderr.write(
        "pixel-art-pass.py needs Pillow. Install with: python3 -m pip install --user Pillow\n"
    )
    sys.exit(2)


def parse_args():
    parser = ArgumentParser(description="Stylize a sprite PNG for pixel-art output.")
    parser.add_argument("--input", required=True, help="Input PNG (raw render).")
    parser.add_argument("--output", required=True, help="Output PNG (stylized).")
    parser.add_argument(
        "--palette-size",
        type=int,
        default=16,
        help="Number of colours per sprite. 12–24 works well at the game budget.",
    )
    parser.add_argument(
        "--contrast",
        type=float,
        default=1.2,
        help="Contrast multiplier before quantization.",
    )
    parser.add_argument(
        "--saturation",
        type=float,
        default=1.35,
        help="Saturation multiplier before quantization.",
    )
    parser.add_argument(
        "--dither",
        action="store_true",
        default=False,
        help="Apply Floyd-Steinberg dither when quantizing. Off by default for crisper blocks of colour.",
    )
    parser.add_argument(
        "--outline",
        action="store_true",
        default=True,
        help="Add a 1px silhouette outline (default on).",
    )
    parser.add_argument(
        "--no-outline",
        dest="outline",
        action="store_false",
    )
    parser.add_argument(
        "--outline-darken",
        type=float,
        default=0.45,
        help="Outline darkening factor (0 = black, 1 = no change). Default 0.45.",
    )
    parser.add_argument(
        "--texture-mode",
        action="store_true",
        default=False,
        help="Treat the input as a tileable material texture: no alpha, no outline, RGB output.",
    )
    parser.add_argument(
        "--diff-size",
        type=int,
        default=0,
        help="Texture-mode only: if >0, resample the diffuse to this size (square) with Lanczos before quantizing. Produces chunky pixel-art textures.",
    )
    return parser.parse_args()


def main():
    args = parse_args()
    if not os.path.exists(args.input):
        sys.stderr.write(f"pixel-art-pass: input not found: {args.input}\n")
        sys.exit(1)

    if args.texture_mode:
        stylize_texture(args)
        return

    img = Image.open(args.input).convert("RGBA")
    alpha = img.getchannel("A")

    # Step 1: contrast + saturation boost on the RGB channels only.
    rgb = img.convert("RGB")
    rgb = ImageEnhance.Contrast(rgb).enhance(args.contrast)
    rgb = ImageEnhance.Color(rgb).enhance(args.saturation)

    # Step 2: quantize to a small palette. Pillow quantize() returns a
    # palette-mode image; we convert back to RGB so we can recombine with
    # the original alpha channel.
    dither_mode = Image.Dither.FLOYDSTEINBERG if args.dither else Image.Dither.NONE
    palette_img = rgb.quantize(
        colors=max(2, args.palette_size),
        method=Image.Quantize.MEDIANCUT,
        dither=dither_mode,
    )
    quantized_rgb = palette_img.convert("RGB")

    # Step 3: merge RGB back with the untouched alpha channel. Any pixel
    # that was fully transparent stays transparent.
    r, g, b = quantized_rgb.split()
    result = Image.merge("RGBA", (r, g, b, alpha))

    # Step 4: silhouette outline — darken every opaque pixel that has at
    # least one transparent 4-neighbour. This gives the tile a crisp
    # silhouette against any background at any zoom level.
    if args.outline:
        result = apply_silhouette_outline(result, args.outline_darken)

    os.makedirs(os.path.dirname(args.output) or ".", exist_ok=True)
    result.save(args.output)
    print(
        f"[pixel-art-pass] {os.path.basename(args.input)} → {os.path.basename(args.output)} "
        f"palette={args.palette_size} dither={args.dither} outline={args.outline}"
    )


def stylize_texture(args):
    """Stylize a tileable material texture.

    Used for the baseColor maps embedded in GLB materials. Unlike the sprite
    path, there is no alpha channel and no silhouette outline: we only do
    contrast / saturation boost, optional downscale, and palette
    quantization. Normal and ARM maps must never go through this pass.

    If ``--diff-size > 0`` the image is first resampled to a square of that
    size with Lanczos — this gives genuinely chunky pixel-art textures
    (e.g. 64x64 with 8 colours) while leaving the PBR lighting pipeline
    intact (the engine samples with its own filter, and the normal / ARM
    maps stay at their original resolution for shadow / specular response).

    PNG output is preferred for texture-mode because the quantized palette
    survives losslessly. JPEG quality=100 subsampling=0 is the fallback
    when the caller explicitly asks for a .jpg extension.
    """
    img = Image.open(args.input).convert("RGB")

    # Optional: resample to a tiny pixel-art resolution before quantizing.
    if args.diff_size and args.diff_size > 0:
        img = img.resize((args.diff_size, args.diff_size), Image.LANCZOS)

    img = ImageEnhance.Contrast(img).enhance(args.contrast)
    img = ImageEnhance.Color(img).enhance(args.saturation)

    dither_mode = Image.Dither.FLOYDSTEINBERG if args.dither else Image.Dither.NONE
    palette_img = img.quantize(
        colors=max(2, args.palette_size),
        method=Image.Quantize.MEDIANCUT,
        dither=dither_mode,
    )

    os.makedirs(os.path.dirname(args.output) or ".", exist_ok=True)
    ext = os.path.splitext(args.output)[1].lower()
    if ext == ".png":
        # Save as palette-mode PNG. This preserves the exact N-colour palette
        # losslessly and produces tiny files — a 64x64 8-colour palette PNG
        # is typically 1-3 KB.
        palette_img.save(args.output, format="PNG", optimize=True)
    elif ext in (".jpg", ".jpeg"):
        # JPEG fallback at max quality and no chroma subsampling so the
        # quantized flat fields don't get smeared by the DCT.
        palette_img.convert("RGB").save(args.output, format="JPEG", quality=100, subsampling=0)
    else:
        palette_img.convert("RGB").save(args.output)

    print(
        f"[pixel-art-pass] texture {os.path.basename(args.input)} → {os.path.basename(args.output)} "
        f"size={palette_img.size[0]}x{palette_img.size[1]} palette={args.palette_size} dither={args.dither}"
    )


def apply_silhouette_outline(img, darken_factor):
    """Darken opaque pixels adjacent to transparent pixels.

    Uses direct pixel access for simplicity — sprites are < 100x100 px so
    the O(w*h*4) loop is trivial. For any meaningful speedup we'd switch
    to numpy, but the dependency isn't worth it at these sizes.
    """
    width, height = img.size
    source = img.load()
    output = img.copy()
    dst = output.load()

    for x in range(width):
        for y in range(height):
            pixel = source[x, y]
            if pixel[3] == 0:
                continue
            r, g, b, a = pixel
            adjacent_transparent = False
            for dx, dy in ((-1, 0), (1, 0), (0, -1), (0, 1)):
                nx, ny = x + dx, y + dy
                if nx < 0 or nx >= width or ny < 0 or ny >= height:
                    adjacent_transparent = True
                    break
                if source[nx, ny][3] == 0:
                    adjacent_transparent = True
                    break
            if adjacent_transparent:
                dst[x, y] = (
                    int(r * darken_factor),
                    int(g * darken_factor),
                    int(b * darken_factor),
                    a,
                )
    return output


if __name__ == "__main__":
    main()
