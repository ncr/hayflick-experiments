// ---------------------------------------------------------------------------
// CAD-style horizontal toolbar for the map editor
// ---------------------------------------------------------------------------

export const TOOLBAR_HEIGHT = 48;

const TOOLBAR_BG = "linear-gradient(180deg, rgba(24, 30, 36, 0.96), rgba(12, 17, 23, 0.98))";
const TOOLBAR_BORDER = "1px solid rgba(128, 150, 167, 0.4)";
const GROUP_BG = "rgba(35, 45, 53, 0.5)";
const GROUP_BORDER = "1px solid rgba(142, 164, 181, 0.25)";
const BUTTON_BORDER = "1px solid rgba(128, 151, 169, 0.62)";
const BUTTON_BG = "linear-gradient(180deg, rgba(39, 50, 59, 0.95), rgba(21, 30, 36, 0.95))";
const BUTTON_FG = "#ebf4fa";
const BUTTON_ACTIVE_BG =
  "linear-gradient(180deg, rgba(78, 136, 177, 0.96), rgba(40, 92, 126, 0.94))";
const BUTTON_ACTIVE_BORDER = "rgba(154, 201, 232, 0.98)";
const BUTTON_ACTIVE_FG = "#ffffff";
const MUTED_FG = "rgba(194, 209, 220, 0.7)";
const LABEL_FG = "rgba(194, 209, 220, 0.86)";

export type EditorToolbarOptions = {
  mount: HTMLElement;
  focusTarget?: HTMLElement;
};

export type EditorToolbar = {
  root: HTMLDivElement;
  createGroup(label: string): HTMLDivElement;
  createButton(label: string, onClick: () => void): HTMLButtonElement;
  createSeparator(): HTMLDivElement;
  setButtonActive(button: HTMLButtonElement, active: boolean): void;
  setStats(text: string): void;
  setRotation(degrees: number): void;
  setUndoRedoEnabled(canUndo: boolean, canRedo: boolean): void;
  destroy(): void;
};

export function createEditorToolbar(options: EditorToolbarOptions): EditorToolbar {
  const focusTarget = options.focusTarget;

  // Root toolbar
  const root = document.createElement("div");
  root.style.position = "absolute";
  root.style.top = "0";
  root.style.left = "0";
  root.style.right = "0";
  root.style.height = `${TOOLBAR_HEIGHT}px`;
  root.style.zIndex = "10";
  root.style.background = TOOLBAR_BG;
  root.style.borderBottom = TOOLBAR_BORDER;
  root.style.display = "flex";
  root.style.alignItems = "center";
  root.style.padding = "0 10px";
  root.style.gap = "8px";
  root.style.fontFamily = '"Rajdhani", "IBM Plex Sans", "Segoe UI", sans-serif';
  root.style.color = BUTTON_FG;
  root.style.pointerEvents = "auto";
  root.style.overflowX = "auto";
  root.style.overflowY = "hidden";
  options.mount.appendChild(root);

  // Right section (pushed to far right)
  const rightSection = document.createElement("div");
  rightSection.style.marginLeft = "auto";
  rightSection.style.display = "flex";
  rightSection.style.alignItems = "center";
  rightSection.style.gap = "8px";
  rightSection.style.flexShrink = "0";

  // Rotation indicator
  const rotationEl = document.createElement("div");
  rotationEl.style.fontSize = "11px";
  rotationEl.style.color = MUTED_FG;
  rotationEl.style.whiteSpace = "nowrap";
  rotationEl.textContent = "R: 0\u00b0";
  rightSection.appendChild(rotationEl);

  // Stats
  const statsEl = document.createElement("div");
  statsEl.style.fontSize = "11px";
  statsEl.style.color = MUTED_FG;
  statsEl.style.whiteSpace = "nowrap";
  rightSection.appendChild(statsEl);

  // Undo/redo buttons (stored for enable/disable)
  let undoBtn: HTMLButtonElement | null = null;
  let redoBtn: HTMLButtonElement | null = null;

  function createGroup(label: string): HTMLDivElement {
    const group = document.createElement("div");
    group.style.display = "flex";
    group.style.alignItems = "center";
    group.style.gap = "4px";
    group.style.padding = "4px 6px";
    group.style.background = GROUP_BG;
    group.style.border = GROUP_BORDER;
    group.style.borderRadius = "8px";
    group.style.flexShrink = "0";

    if (label) {
      const labelEl = document.createElement("span");
      labelEl.textContent = label;
      labelEl.style.fontSize = "10px";
      labelEl.style.fontWeight = "700";
      labelEl.style.letterSpacing = "0.06em";
      labelEl.style.textTransform = "uppercase";
      labelEl.style.color = LABEL_FG;
      labelEl.style.marginRight = "4px";
      labelEl.style.whiteSpace = "nowrap";
      group.appendChild(labelEl);
    }

    // Insert before rightSection (which is always last)
    root.insertBefore(group, rightSection);
    return group;
  }

  function createButton(label: string, onClick: () => void): HTMLButtonElement {
    const button = document.createElement("button");
    button.type = "button";
    button.textContent = label;
    button.style.border = BUTTON_BORDER;
    button.style.background = BUTTON_BG;
    button.style.color = BUTTON_FG;
    button.style.padding = "4px 8px";
    button.style.borderRadius = "6px";
    button.style.minHeight = "28px";
    button.style.cursor = "pointer";
    button.style.fontSize = "11px";
    button.style.fontWeight = "600";
    button.style.letterSpacing = "0.03em";
    button.style.textTransform = "uppercase";
    button.style.boxShadow = "inset 0 1px 0 rgba(255, 255, 255, 0.12)";
    button.style.transition = "filter 90ms ease";
    button.style.whiteSpace = "nowrap";
    button.addEventListener("pointerdown", () => {
      button.style.filter = "brightness(1.12)";
    });
    button.addEventListener("pointerup", () => {
      button.style.filter = "";
    });
    button.addEventListener("pointerleave", () => {
      button.style.filter = "";
    });
    button.addEventListener("click", (event) => {
      event.preventDefault();
      onClick();
      if (focusTarget?.focus) {
        try {
          focusTarget.focus({ preventScroll: true });
        } catch {
          focusTarget.focus();
        }
      }
    });

    // Track undo/redo buttons by label
    if (label === "Undo") undoBtn = button;
    if (label === "Redo") redoBtn = button;

    return button;
  }

  function createSeparator(): HTMLDivElement {
    const sep = document.createElement("div");
    sep.style.width = "1px";
    sep.style.height = "20px";
    sep.style.background = "rgba(128, 150, 167, 0.3)";
    sep.style.flexShrink = "0";
    return sep;
  }

  function setButtonActive(button: HTMLButtonElement, active: boolean): void {
    if (active) {
      button.style.background = BUTTON_ACTIVE_BG;
      button.style.borderColor = BUTTON_ACTIVE_BORDER;
      button.style.color = BUTTON_ACTIVE_FG;
      button.style.boxShadow =
        "inset 0 1px 0 rgba(255, 255, 255, 0.22), 0 0 0 1px rgba(154, 201, 232, 0.2)";
    } else {
      button.style.background = BUTTON_BG;
      button.style.borderColor = "";
      button.style.color = BUTTON_FG;
      button.style.boxShadow = "inset 0 1px 0 rgba(255, 255, 255, 0.12)";
    }
  }

  function setStats(text: string): void {
    statsEl.textContent = text;
  }

  function setRotation(degrees: number): void {
    rotationEl.textContent = `R: ${degrees}\u00b0`;
  }

  function setUndoRedoEnabled(canUndo: boolean, canRedo: boolean): void {
    if (undoBtn) {
      undoBtn.style.opacity = canUndo ? "1" : "0.35";
      undoBtn.style.pointerEvents = canUndo ? "auto" : "none";
    }
    if (redoBtn) {
      redoBtn.style.opacity = canRedo ? "1" : "0.35";
      redoBtn.style.pointerEvents = canRedo ? "auto" : "none";
    }
  }

  function destroy(): void {
    root.remove();
  }

  // Append right section last
  root.appendChild(rightSection);

  return {
    root,
    createGroup,
    createButton,
    createSeparator,
    setButtonActive,
    setStats,
    setRotation,
    setUndoRedoEnabled,
    destroy
  };
}
