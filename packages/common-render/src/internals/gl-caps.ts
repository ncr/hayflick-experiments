export function queryMaxBackingSize(
  gl: WebGLRenderingContext | WebGL2RenderingContext
): { width: number; height: number } {
  const viewportDims = gl.getParameter(gl.MAX_VIEWPORT_DIMS) as Int32Array | number[];
  const safeLimit = (value: number): number =>
    Number.isFinite(value) && value > 0 ? Math.floor(value) : 8192;

  const viewportWidth = safeLimit(Number(viewportDims?.[0] ?? 0));
  const viewportHeight = safeLimit(Number(viewportDims?.[1] ?? 0));
  const renderbufferMax = safeLimit(Number(gl.getParameter(gl.MAX_RENDERBUFFER_SIZE) ?? 0));
  const textureMax = safeLimit(Number(gl.getParameter(gl.MAX_TEXTURE_SIZE) ?? 0));

  return {
    width: Math.max(1, Math.min(viewportWidth, renderbufferMax, textureMax)),
    height: Math.max(1, Math.min(viewportHeight, renderbufferMax, textureMax))
  };
}
