import * as THREE from "three";
import type { TilesetConfig, PieceConfig, PieceMetadata, BatchResult } from "../model/types";
import { expandTileset, generateTilesetIndex } from "../model/tileset";
import { generatePieceMetadata, pieceSlug } from "../model/piece-metadata";
import { generatePieceGeometryDescriptors, mergeMeshData } from "../model/geometry";
import { buildPieceMesh, disposePieceGroup } from "../view/piece-builder";
import { bakeTexture, pixelsToPng, createPreviewMaterial } from "../view/texture-baker";
import { buildGlb } from "./glb-builder";
import { createZipBlob, downloadBlob, jsonToBytes } from "./zip-bundler";
import type { ZipEntry } from "./zip-bundler";

export type BatchProgress = (current: number, total: number) => void;

/**
 * Export a single piece: generate geometry, bake texture, build GLB.
 */
export async function exportSinglePiece(
  config: PieceConfig,
  renderer: THREE.WebGLRenderer,
): Promise<{ glb: ArrayBuffer; metadata: PieceMetadata; pngData: Uint8Array }> {
  const metadata = generatePieceMetadata(config);
  const descriptors = generatePieceGeometryDescriptors(config);

  // Collect all MeshData for GLB
  const allMeshes = [...descriptors.baseBoxes];
  if (descriptors.openingFrame) allMeshes.push(descriptors.openingFrame);
  allMeshes.push(...descriptors.trimMeshes);

  // Bake texture
  const pixels = bakeTexture(renderer, config.material, config.dimensions, config.textureResolution);
  const pngData = await pixelsToPng(pixels, config.textureResolution);

  // Build GLB
  const glb = await buildGlb(allMeshes, pngData);

  return { glb, metadata, pngData };
}

/**
 * Export a full tileset as a ZIP download.
 */
export async function exportTileset(
  tilesetConfig: TilesetConfig,
  renderer: THREE.WebGLRenderer,
  onProgress?: BatchProgress,
): Promise<void> {
  const configs = expandTileset(tilesetConfig);
  const index = generateTilesetIndex(configs);
  const entries: ZipEntry[] = [];

  // Index file
  entries.push({
    path: "index.json",
    data: jsonToBytes(index),
  });

  // Each piece
  for (let i = 0; i < configs.length; i++) {
    const config = configs[i];
    const slug = pieceSlug(config);
    onProgress?.(i, configs.length);

    const { glb, metadata } = await exportSinglePiece(config, renderer);

    entries.push({
      path: `${slug}/piece.json`,
      data: jsonToBytes(metadata),
    });
    entries.push({
      path: `${slug}/model.glb`,
      data: new Uint8Array(glb),
    });

    // Yield to event loop
    await new Promise((r) => setTimeout(r, 0));
  }

  onProgress?.(configs.length, configs.length);

  const blob = createZipBlob(entries);
  downloadBlob(blob, "tileset.zip");
}

/**
 * Export just the current single piece as a download.
 */
export async function exportCurrentPiece(
  config: PieceConfig,
  renderer: THREE.WebGLRenderer,
): Promise<void> {
  const slug = pieceSlug(config);
  const { glb, metadata } = await exportSinglePiece(config, renderer);

  const entries: ZipEntry[] = [
    { path: `${slug}/piece.json`, data: jsonToBytes(metadata) },
    { path: `${slug}/model.glb`, data: new Uint8Array(glb) },
  ];

  const blob = createZipBlob(entries);
  downloadBlob(blob, `${slug}.zip`);
}
