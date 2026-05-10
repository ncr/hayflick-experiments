/**
 * SharedModelCache — in-memory Three.js model sharing across stages.
 *
 * Mesh stage stores processed models here; Physics stage reads from cache
 * instead of loading from disk, enabling instant cross-stage sync.
 */
import type * as THREE from "three";

export type ModelVariant = "raw" | "processed";

export class SharedModelCache {
  private cache = new Map<string, Map<ModelVariant, THREE.Group>>();

  set(propId: string, variant: ModelVariant, model: THREE.Group): void {
    let variants = this.cache.get(propId);
    if (!variants) {
      variants = new Map();
      this.cache.set(propId, variants);
    }
    variants.set(variant, model);
  }

  get(propId: string, variant: ModelVariant): THREE.Group | null {
    return this.cache.get(propId)?.get(variant) ?? null;
  }

  evictProp(propId: string): void {
    this.cache.delete(propId);
  }

  clear(): void {
    this.cache.clear();
  }

  has(propId: string, variant: ModelVariant): boolean {
    return this.cache.get(propId)?.has(variant) ?? false;
  }

  get size(): number {
    return this.cache.size;
  }
}
