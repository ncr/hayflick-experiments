/**
 * PIX workspace — the mesh viewport stays mounted via MeshWorkspace (CSS visibility).
 * This component shows any PIX-specific overlays or status on top.
 */
export function PixWorkspace() {
  return (
    <div className="ps-pix-workspace">
      <div className="ps-pix-overlay-hint">
        <span className="ps-text-muted">
          Mesh and pixel views are shown above. Review the result and approve when ready.
        </span>
      </div>
    </div>
  );
}
