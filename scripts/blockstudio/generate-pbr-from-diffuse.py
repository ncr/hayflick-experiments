#!/usr/bin/env python3
"""
Generate normal + ARM maps from a pixel-art baseColor texture.

Derives PBR maps directly from the diffuse so they match the pixel-art
shapes (large stones, planks, cracks) rather than carrying unrelated
photographic detail from the original Polyhaven source.

- Normal map: grayscale height → Sobel gradients → tangent-space normal
  (OpenGL convention: R=+X right, G=+Y up, B=+Z out; flat = 128,128,255).
- ARM map: R=AO (edge-darken from Sobel magnitude), G=Roughness (from
  inverse luminance — brighter areas are smoother), B=Metalness (0).

Usage:
    python3 scripts/blockstudio/generate-pbr-from-diffuse.py \\
        --input  assets/materials/polyhaven/cobblestone_floor_04/cobblestone_floor_04_diff_pixart.png \\
        --normal assets/materials/polyhaven/cobblestone_floor_04/cobblestone_floor_04_nor_pixart.png \\
        --arm    assets/materials/polyhaven/cobblestone_floor_04/cobblestone_floor_04_arm_pixart.png \\
        --strength 2.0
"""

import argparse
import numpy as np
from PIL import Image


def load_grayscale(path: str) -> np.ndarray:
    """Load image as float32 grayscale in [0, 1]."""
    img = Image.open(path).convert("L")
    return np.asarray(img, dtype=np.float32) / 255.0


def sobel_gradients(height: np.ndarray) -> tuple[np.ndarray, np.ndarray]:
    """Compute horizontal and vertical gradients with Sobel kernels.

    Uses np.roll for seamless tiling (wraps around edges).
    """
    # Sobel X: detects vertical edges → horizontal gradient
    gx = (
        -1.0 * np.roll(np.roll(height, 1, axis=0), -1, axis=1)
        +  1.0 * np.roll(np.roll(height, 1, axis=0),  1, axis=1)
        + -2.0 * np.roll(height, -1, axis=1)
        +  2.0 * np.roll(height,  1, axis=1)
        + -1.0 * np.roll(np.roll(height, -1, axis=0), -1, axis=1)
        +  1.0 * np.roll(np.roll(height, -1, axis=0),  1, axis=1)
    )
    # Sobel Y: detects horizontal edges → vertical gradient
    gy = (
        -1.0 * np.roll(np.roll(height, -1, axis=1), 1, axis=0)
        +  1.0 * np.roll(np.roll(height, -1, axis=1), -1, axis=0)
        + -2.0 * np.roll(height, 1, axis=0)
        +  2.0 * np.roll(height, -1, axis=0)
        + -1.0 * np.roll(np.roll(height, 1, axis=1), 1, axis=0)
        +  1.0 * np.roll(np.roll(height, 1, axis=1), -1, axis=0)
    )
    return gx, gy


def generate_normal_map(height: np.ndarray, strength: float = 1.5) -> np.ndarray:
    """Height map → OpenGL tangent-space normal map (uint8 RGB)."""
    gx, gy = sobel_gradients(height)

    # Scale gradients by strength
    gx *= strength
    gy *= strength

    # Normal vector: (-dh/dx, -dh/dy, 1), then normalize
    # OpenGL convention: +X right, +Y up (image Y is flipped)
    nx = -gx
    ny = gy  # flip for OpenGL (image Y goes down, normal Y goes up)
    nz = np.ones_like(nx)

    length = np.sqrt(nx * nx + ny * ny + nz * nz)
    nx /= length
    ny /= length
    nz /= length

    # Encode to [0, 255]: n * 0.5 + 0.5
    r = np.clip((nx * 0.5 + 0.5) * 255, 0, 255).astype(np.uint8)
    g = np.clip((ny * 0.5 + 0.5) * 255, 0, 255).astype(np.uint8)
    b = np.clip((nz * 0.5 + 0.5) * 255, 0, 255).astype(np.uint8)

    return np.stack([r, g, b], axis=-1)


def generate_arm_map(
    height: np.ndarray,
    base_roughness: float = 0.7,
    roughness_range: float = 0.25
) -> np.ndarray:
    """Height map → ARM map (R=AO, G=Roughness, B=Metalness).

    - AO: edge-darkened from gradient magnitude (crevices are darker)
    - Roughness: inverse luminance (darker areas = mortar/cracks = rougher)
    - Metalness: always 0 for natural materials
    """
    gx, gy = sobel_gradients(height)
    edge_mag = np.sqrt(gx * gx + gy * gy)

    # AO: 1.0 minus edge strength (clamped). Edges (mortar lines, cracks)
    # get darker AO.
    ao = np.clip(1.0 - edge_mag * 3.0, 0.3, 1.0)

    # Roughness: darker pixels → rougher (mortar, cracks), lighter → smoother
    roughness = base_roughness + (1.0 - height) * roughness_range
    roughness = np.clip(roughness, 0.0, 1.0)

    # Metalness: 0 for all natural materials
    metalness = np.zeros_like(height)

    r = np.clip(ao * 255, 0, 255).astype(np.uint8)
    g = np.clip(roughness * 255, 0, 255).astype(np.uint8)
    b = np.clip(metalness * 255, 0, 255).astype(np.uint8)

    return np.stack([r, g, b], axis=-1)


def main():
    parser = argparse.ArgumentParser(description="Generate PBR maps from pixel-art diffuse.")
    parser.add_argument("--input", required=True, help="Pixel-art baseColor PNG.")
    parser.add_argument("--normal", required=True, help="Output normal map PNG.")
    parser.add_argument("--arm", required=True, help="Output ARM map PNG.")
    parser.add_argument("--strength", type=float, default=2.0,
                        help="Normal map strength (default 2.0).")
    parser.add_argument("--roughness", type=float, default=0.7,
                        help="Base roughness (default 0.7).")
    parser.add_argument("--roughness-range", type=float, default=0.25,
                        help="Roughness variation range (default 0.25).")
    args = parser.parse_args()

    height = load_grayscale(args.input)

    normal = generate_normal_map(height, strength=args.strength)
    Image.fromarray(normal, "RGB").save(args.normal)
    print(f"[pbr] normal → {args.normal} ({normal.shape[1]}×{normal.shape[0]})")

    arm = generate_arm_map(height, base_roughness=args.roughness,
                           roughness_range=args.roughness_range)
    Image.fromarray(arm, "RGB").save(args.arm)
    print(f"[pbr] arm    → {args.arm} ({arm.shape[1]}×{arm.shape[0]})")


if __name__ == "__main__":
    main()
