/**
 * Shape of a cached image generation result. Stored in IndexedDB.
 *
 * The cache is intentionally generic so callers from different experiments
 * can share one history. Use `source` to namespace (e.g. "material-studio"
 * vs "forge.concept") and `tags` for any structured filter keys.
 */
export type CachedGeneration = {
  /** UUID assigned when the entry is saved. */
  id: string;
  /** Source label, e.g. "material-studio" or "forge.concept-image". */
  source: string;
  /** User-written prompt. */
  prompt: string;
  /** Structured tags for filtering — e.g. { baseMeshId, role }. */
  tags: Record<string, string>;
  /** Optional input image (base64 PNG) for edit-image flows. */
  inputImageB64: string | null;
  /** Output image as base64 PNG. */
  outputB64: string;
  /** MIME type of the output. */
  outputMimeType: string;
  /** Source-defined auxiliary payload (JSON string), used to restore extra state
   *  the consumer needs beyond the output image. Material-Studio stuffs the
   *  recomposed atlas and island layout here so a "pick from history" can
   *  fully restore the surface. */
  contextJson: string | null;
  /** Unix ms timestamp. */
  createdAt: number;
  /** Optional user-supplied note (rename, label, etc.). */
  note?: string;
};

export type SaveCachedGenerationInput = Omit<
  CachedGeneration,
  "id" | "createdAt" | "contextJson" | "inputImageB64"
> &
  Partial<Pick<CachedGeneration, "id" | "createdAt" | "contextJson" | "inputImageB64">>;

export type ListFilter = {
  source?: string;
  /** Match all listed tag entries. Tag values must match exactly. */
  tags?: Record<string, string>;
  limit?: number;
};
