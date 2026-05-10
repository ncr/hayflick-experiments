import { useAppDispatch, useAppState } from "../state/context";

type Props = {
  onSave: () => void;
  busy: boolean;
};

const NAME_RE = /^[a-z0-9][a-z0-9_-]{0,63}$/i;

export function SaveBar({ onSave, busy }: Props) {
  const { authoring } = useAppState();
  const dispatch = useAppDispatch();
  if (!authoring) return null;

  const allApproved =
    authoring.surfaces.length > 0 && authoring.surfaces.every((s) => authoring.surfaceStates[s.role]?.approved);
  const nameValid = NAME_RE.test(authoring.entryName);
  const isProtected = authoring.protected && authoring.mode === "edit";

  const canSave = !isProtected && !busy && !authoring.baking && allApproved && nameValid;

  return (
    <div className="ms-save-bar">
      <label className="ms-field ms-save-field">
        <span>Entry name</span>
        <input
          className="ms-input"
          value={authoring.entryName}
          onChange={(e) => dispatch({ type: "AUTHORING_SET_NAME", name: e.target.value })}
          placeholder="my-textured-mesh"
          disabled={busy || authoring.baking || isProtected}
        />
      </label>
      <button className="ms-btn ms-btn-primary" onClick={onSave} disabled={!canSave}>
        {authoring.baking ? "Baking…" : authoring.mode === "edit" ? "Save" : "Create"}
      </button>
      {!allApproved && (
        <div className="ms-hint ms-hint-sub">
          Approve every PBR surface to save.
        </div>
      )}
      {!nameValid && authoring.entryName && (
        <div className="ms-hint ms-hint-sub ms-hint-error">
          Name must be alphanumeric, dash or underscore, ≤64 chars.
        </div>
      )}
      {isProtected && (
        <div className="ms-hint-warn">
          Locked — unlock from the Library to edit.
        </div>
      )}
    </div>
  );
}
