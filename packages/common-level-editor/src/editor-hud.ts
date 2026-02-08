export type EditorHudOptions = {
  mount: HTMLElement;
  title: string;
  description: string;
  hints: string;
  focusTarget?: HTMLElement;
  leftPanelWidth?: string;
  rightPanelMinWidth?: string;
  statsTestId?: string;
  statusTestId?: string;
};

export type EditorHud = {
  root: HTMLDivElement;
  leftPanel: HTMLDivElement;
  rightPanel: HTMLDivElement;
  stats: HTMLDivElement;
  status: HTMLDivElement;
  hints: HTMLDivElement;
  createRow(label: string): HTMLDivElement;
  createButton(label: string, onClick: () => void): HTMLButtonElement;
  setButtonActive(button: HTMLButtonElement, active: boolean): void;
  destroy(): void;
};

const PANEL_BG = "rgba(9, 17, 25, 0.76)";
const PANEL_BORDER = "1px solid rgba(121, 153, 177, 0.45)";
const BUTTON_BORDER = "1px solid rgba(124, 155, 178, 0.62)";
const BUTTON_BG = "rgba(20, 35, 49, 0.92)";
const BUTTON_FG = "#d8e8f4";
const BUTTON_ACTIVE_BG = "rgba(78, 136, 177, 0.9)";
const BUTTON_ACTIVE_BORDER = "rgba(150, 197, 229, 0.95)";
const BUTTON_ACTIVE_FG = "#f3fbff";

function applyPanelStyle(panel: HTMLDivElement): void {
  panel.style.background = PANEL_BG;
  panel.style.border = PANEL_BORDER;
  panel.style.borderRadius = "10px";
  panel.style.padding = "10px";
  panel.style.pointerEvents = "auto";
  panel.style.backdropFilter = "blur(6px)";
  panel.style.display = "flex";
  panel.style.flexDirection = "column";
  panel.style.gap = "8px";
}

export function createEditorHud(options: EditorHudOptions): EditorHud {
  const root = document.createElement("div");
  root.style.position = "absolute";
  root.style.inset = "12px";
  root.style.display = "flex";
  root.style.justifyContent = "space-between";
  root.style.alignItems = "flex-start";
  root.style.pointerEvents = "none";
  root.style.fontFamily = "\"IBM Plex Sans\", \"Segoe UI\", sans-serif";
  root.style.color = "#d8e8f4";
  root.style.gap = "12px";
  options.mount.appendChild(root);

  const leftPanel = document.createElement("div");
  applyPanelStyle(leftPanel);
  leftPanel.style.width = options.leftPanelWidth ?? "min(390px, 56vw)";
  root.appendChild(leftPanel);

  const rightPanel = document.createElement("div");
  applyPanelStyle(rightPanel);
  rightPanel.style.minWidth = options.rightPanelMinWidth ?? "260px";
  rightPanel.style.alignItems = "stretch";
  root.appendChild(rightPanel);

  const title = document.createElement("div");
  title.textContent = options.title;
  title.style.fontWeight = "600";
  title.style.letterSpacing = "0.02em";
  leftPanel.appendChild(title);

  const description = document.createElement("div");
  description.textContent = options.description;
  description.style.fontSize = "12px";
  description.style.lineHeight = "1.35";
  description.style.color = "rgba(207, 225, 240, 0.88)";
  leftPanel.appendChild(description);

  const stats = document.createElement("div");
  if (options.statsTestId) {
    stats.dataset.testid = options.statsTestId;
  }
  stats.style.fontSize = "12px";
  stats.style.lineHeight = "1.4";
  stats.style.color = "#c9dceb";
  rightPanel.appendChild(stats);

  const status = document.createElement("div");
  if (options.statusTestId) {
    status.dataset.testid = options.statusTestId;
  }
  status.style.fontSize = "12px";
  status.style.lineHeight = "1.35";
  status.style.color = "#d8e8f4";
  rightPanel.appendChild(status);

  const hints = document.createElement("div");
  hints.textContent = options.hints;
  hints.style.fontSize = "12px";
  hints.style.lineHeight = "1.35";
  hints.style.opacity = "0.92";
  rightPanel.appendChild(hints);

  const focusTarget = options.focusTarget;

  function createRow(label: string): HTMLDivElement {
    const row = document.createElement("div");
    row.style.display = "grid";
    row.style.gridTemplateColumns = "72px 1fr";
    row.style.alignItems = "center";
    row.style.gap = "8px";

    const caption = document.createElement("span");
    caption.textContent = label;
    caption.style.fontSize = "12px";
    caption.style.opacity = "0.82";
    row.appendChild(caption);

    const controls = document.createElement("div");
    controls.style.display = "flex";
    controls.style.flexWrap = "wrap";
    controls.style.gap = "6px";
    row.appendChild(controls);

    leftPanel.appendChild(row);
    return controls;
  }

  function createButton(label: string, onClick: () => void): HTMLButtonElement {
    const button = document.createElement("button");
    button.type = "button";
    button.textContent = label;
    button.style.border = BUTTON_BORDER;
    button.style.background = BUTTON_BG;
    button.style.color = BUTTON_FG;
    button.style.padding = "4px 8px";
    button.style.borderRadius = "8px";
    button.style.cursor = "pointer";
    button.style.fontSize = "12px";
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
    return button;
  }

  function setButtonActive(button: HTMLButtonElement, active: boolean): void {
    if (active) {
      button.style.background = BUTTON_ACTIVE_BG;
      button.style.borderColor = BUTTON_ACTIVE_BORDER;
      button.style.color = BUTTON_ACTIVE_FG;
    } else {
      button.style.background = BUTTON_BG;
      button.style.borderColor = BUTTON_BORDER;
      button.style.color = BUTTON_FG;
    }
  }

  function destroy(): void {
    if (root.parentElement) {
      root.parentElement.removeChild(root);
    }
  }

  return {
    root,
    leftPanel,
    rightPanel,
    stats,
    status,
    hints,
    createRow,
    createButton,
    setButtonActive,
    destroy
  };
}
