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

const PANEL_BORDER = "1px solid rgba(128, 150, 167, 0.56)";
const PANEL_CHROME_BG = "linear-gradient(160deg, rgba(24, 30, 36, 0.92), rgba(12, 17, 23, 0.96))";
const PANEL_SECTION_BG =
  "linear-gradient(160deg, rgba(35, 45, 53, 0.62), rgba(20, 27, 33, 0.7))";
const PANEL_SECTION_BORDER = "1px solid rgba(142, 164, 181, 0.34)";
const BUTTON_BORDER = "1px solid rgba(128, 151, 169, 0.62)";
const BUTTON_BG = "linear-gradient(180deg, rgba(39, 50, 59, 0.95), rgba(21, 30, 36, 0.95))";
const BUTTON_FG = "#ebf4fa";
const BUTTON_ACTIVE_BG =
  "linear-gradient(180deg, rgba(78, 136, 177, 0.96), rgba(40, 92, 126, 0.94))";
const BUTTON_ACTIVE_BORDER = "rgba(154, 201, 232, 0.98)";
const BUTTON_ACTIVE_FG = "#ffffff";
const INSET_SECTION_BG =
  "linear-gradient(150deg, rgba(28, 37, 45, 0.82), rgba(16, 22, 27, 0.86))";
const INSET_SECTION_BORDER = "1px solid rgba(138, 161, 178, 0.38)";
const TITLE_FG = "#f4f8fb";
const BODY_FG = "rgba(219, 231, 240, 0.93)";
const MUTED_FG = "rgba(194, 209, 220, 0.86)";

function applyPanelStyle(panel: HTMLDivElement): void {
  panel.style.background = PANEL_CHROME_BG;
  panel.style.border = PANEL_BORDER;
  panel.style.borderRadius = "14px";
  panel.style.padding = "12px";
  panel.style.pointerEvents = "auto";
  panel.style.backdropFilter = "blur(7px)";
  panel.style.boxShadow =
    "0 16px 40px rgba(0, 0, 0, 0.45), inset 0 1px 0 rgba(255, 255, 255, 0.07)";
  panel.style.display = "flex";
  panel.style.flexDirection = "column";
  panel.style.gap = "10px";
}

export function createEditorHud(options: EditorHudOptions): EditorHud {
  const root = document.createElement("div");
  root.style.position = "absolute";
  root.style.inset = "14px";
  root.style.display = "flex";
  root.style.justifyContent = "space-between";
  root.style.alignItems = "flex-start";
  root.style.pointerEvents = "none";
  root.style.fontFamily = "\"Rajdhani\", \"IBM Plex Sans\", \"Segoe UI\", sans-serif";
  root.style.color = BODY_FG;
  root.style.gap = "14px";
  options.mount.appendChild(root);

  const leftPanel = document.createElement("div");
  applyPanelStyle(leftPanel);
  leftPanel.style.width = options.leftPanelWidth ?? "min(430px, 60vw)";
  leftPanel.style.maxHeight = "calc(100vh - 28px)";
  leftPanel.style.overflowY = "auto";
  root.appendChild(leftPanel);

  const rightPanel = document.createElement("div");
  applyPanelStyle(rightPanel);
  rightPanel.style.minWidth = options.rightPanelMinWidth ?? "288px";
  rightPanel.style.alignItems = "stretch";
  rightPanel.style.maxWidth = "min(420px, 38vw)";
  root.appendChild(rightPanel);

  const title = document.createElement("div");
  title.textContent = options.title;
  title.style.fontWeight = "700";
  title.style.fontSize = "17px";
  title.style.letterSpacing = "0.06em";
  title.style.textTransform = "uppercase";
  title.style.color = TITLE_FG;
  title.style.lineHeight = "1.1";
  leftPanel.appendChild(title);

  const description = document.createElement("div");
  description.textContent = options.description;
  description.style.fontSize = "12px";
  description.style.lineHeight = "1.45";
  description.style.color = MUTED_FG;
  description.style.padding = "8px 10px";
  description.style.background = INSET_SECTION_BG;
  description.style.border = INSET_SECTION_BORDER;
  description.style.borderRadius = "10px";
  leftPanel.appendChild(description);

  const stats = document.createElement("div");
  if (options.statsTestId) {
    stats.dataset.testid = options.statsTestId;
  }
  stats.style.fontSize = "12px";
  stats.style.lineHeight = "1.45";
  stats.style.color = BODY_FG;
  stats.style.padding = "8px 10px";
  stats.style.background = PANEL_SECTION_BG;
  stats.style.border = PANEL_SECTION_BORDER;
  stats.style.borderRadius = "10px";
  rightPanel.appendChild(stats);

  const status = document.createElement("div");
  if (options.statusTestId) {
    status.dataset.testid = options.statusTestId;
  }
  status.style.fontSize = "12px";
  status.style.lineHeight = "1.45";
  status.style.color = TITLE_FG;
  status.style.padding = "8px 10px";
  status.style.background = PANEL_SECTION_BG;
  status.style.border = PANEL_SECTION_BORDER;
  status.style.borderRadius = "10px";
  rightPanel.appendChild(status);

  const hints = document.createElement("div");
  hints.textContent = options.hints;
  hints.style.fontSize = "12px";
  hints.style.lineHeight = "1.45";
  hints.style.color = MUTED_FG;
  hints.style.padding = "8px 10px";
  hints.style.background = PANEL_SECTION_BG;
  hints.style.border = PANEL_SECTION_BORDER;
  hints.style.borderRadius = "10px";
  rightPanel.appendChild(hints);

  const focusTarget = options.focusTarget;

  function createRow(label: string): HTMLDivElement {
    const row = document.createElement("div");
    row.style.display = "flex";
    row.style.flexDirection = "column";
    row.style.gap = "8px";
    row.style.padding = "9px 10px";
    row.style.background = PANEL_SECTION_BG;
    row.style.border = PANEL_SECTION_BORDER;
    row.style.borderRadius = "10px";

    const caption = document.createElement("div");
    caption.textContent = label;
    caption.style.fontSize = "12px";
    caption.style.opacity = "0.92";
    caption.style.letterSpacing = "0.08em";
    caption.style.fontWeight = "700";
    caption.style.color = TITLE_FG;
    caption.style.textTransform = "uppercase";
    row.appendChild(caption);

    const controls = document.createElement("div");
    controls.style.display = "flex";
    controls.style.flexWrap = "wrap";
    controls.style.gap = "7px";
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
    button.style.padding = "6px 10px";
    button.style.borderRadius = "9px";
    button.style.minHeight = "32px";
    button.style.cursor = "pointer";
    button.style.fontSize = "12px";
    button.style.fontWeight = "600";
    button.style.letterSpacing = "0.03em";
    button.style.textTransform = "uppercase";
    button.style.boxShadow = "inset 0 1px 0 rgba(255, 255, 255, 0.12)";
    button.style.transition = "filter 90ms ease";
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
    return button;
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
      button.style.borderColor = BUTTON_BORDER;
      button.style.color = BUTTON_FG;
      button.style.boxShadow = "inset 0 1px 0 rgba(255, 255, 255, 0.12)";
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
