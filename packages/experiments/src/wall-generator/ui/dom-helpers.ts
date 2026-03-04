/** Minimal DOM control helpers — no framework dependency */

const PANEL_STYLES = `
  .wg-panel {
    position: absolute;
    top: 8px;
    left: 8px;
    width: 260px;
    max-height: calc(100% - 16px);
    overflow-y: auto;
    background: rgba(20, 20, 20, 0.92);
    border-radius: 8px;
    padding: 12px;
    font-family: system-ui, sans-serif;
    font-size: 12px;
    color: #ddd;
    z-index: 10;
    user-select: none;
  }
  .wg-panel::-webkit-scrollbar { width: 4px; }
  .wg-panel::-webkit-scrollbar-thumb { background: #555; border-radius: 2px; }
  .wg-section { margin-bottom: 10px; }
  .wg-section-title {
    font-weight: 600;
    font-size: 11px;
    text-transform: uppercase;
    letter-spacing: 0.5px;
    color: #888;
    margin-bottom: 6px;
    border-bottom: 1px solid #333;
    padding-bottom: 3px;
  }
  .wg-row {
    display: flex;
    align-items: center;
    justify-content: space-between;
    margin-bottom: 4px;
  }
  .wg-row label { flex: 0 0 80px; font-size: 11px; }
  .wg-row input[type="range"] { flex: 1; margin: 0 6px; }
  .wg-row select { flex: 1; background: #333; color: #ddd; border: 1px solid #555; border-radius: 3px; padding: 2px; font-size: 11px; }
  .wg-row input[type="number"] { width: 60px; background: #333; color: #ddd; border: 1px solid #555; border-radius: 3px; padding: 2px 4px; font-size: 11px; }
  .wg-row input[type="color"] { width: 32px; height: 22px; border: none; padding: 0; cursor: pointer; }
  .wg-value { width: 36px; text-align: right; font-size: 10px; color: #999; }
  .wg-btn {
    display: block;
    width: 100%;
    padding: 6px 0;
    margin-top: 4px;
    background: #3a6ea5;
    color: #fff;
    border: none;
    border-radius: 4px;
    cursor: pointer;
    font-size: 12px;
    font-weight: 500;
  }
  .wg-btn:hover { background: #4a7eb5; }
  .wg-btn:disabled { opacity: 0.5; cursor: default; }
  .wg-btn.secondary { background: #555; }
  .wg-progress {
    width: 100%;
    height: 4px;
    background: #333;
    border-radius: 2px;
    margin-top: 6px;
    overflow: hidden;
  }
  .wg-progress-bar {
    height: 100%;
    background: #3a6ea5;
    transition: width 0.2s;
  }
  .wg-toggle-row {
    display: flex;
    gap: 6px;
    margin-bottom: 4px;
  }
  .wg-toggle-btn {
    flex: 1;
    padding: 4px 0;
    background: #333;
    color: #999;
    border: 1px solid #555;
    border-radius: 3px;
    cursor: pointer;
    font-size: 11px;
    text-align: center;
  }
  .wg-toggle-btn.active {
    background: #3a6ea5;
    color: #fff;
    border-color: #3a6ea5;
  }
`;

let stylesInjected = false;

export function injectStyles(container: HTMLElement) {
  if (stylesInjected) return;
  const style = document.createElement("style");
  style.textContent = PANEL_STYLES;
  container.appendChild(style);
  stylesInjected = true;
}

export function createPanel(container: HTMLElement): HTMLDivElement {
  injectStyles(container);
  const panel = document.createElement("div");
  panel.className = "wg-panel";
  container.appendChild(panel);
  return panel;
}

export function createSection(parent: HTMLElement, title: string): HTMLDivElement {
  const section = document.createElement("div");
  section.className = "wg-section";
  const titleEl = document.createElement("div");
  titleEl.className = "wg-section-title";
  titleEl.textContent = title;
  section.appendChild(titleEl);
  parent.appendChild(section);
  return section;
}

export function createSlider(
  parent: HTMLElement,
  label: string,
  min: number,
  max: number,
  step: number,
  value: number,
  onChange: (v: number) => void,
): HTMLInputElement {
  const row = document.createElement("div");
  row.className = "wg-row";

  const lbl = document.createElement("label");
  lbl.textContent = label;
  row.appendChild(lbl);

  const input = document.createElement("input");
  input.type = "range";
  input.min = String(min);
  input.max = String(max);
  input.step = String(step);
  input.value = String(value);
  row.appendChild(input);

  const valDisplay = document.createElement("span");
  valDisplay.className = "wg-value";
  valDisplay.textContent = value.toFixed(2);
  row.appendChild(valDisplay);

  input.addEventListener("input", () => {
    const v = parseFloat(input.value);
    valDisplay.textContent = v.toFixed(2);
    onChange(v);
  });

  parent.appendChild(row);
  return input;
}

export function createDropdown(
  parent: HTMLElement,
  label: string,
  options: Array<{ value: string; label: string }>,
  value: string,
  onChange: (v: string) => void,
): HTMLSelectElement {
  const row = document.createElement("div");
  row.className = "wg-row";

  const lbl = document.createElement("label");
  lbl.textContent = label;
  row.appendChild(lbl);

  const select = document.createElement("select");
  for (const opt of options) {
    const o = document.createElement("option");
    o.value = opt.value;
    o.textContent = opt.label;
    if (opt.value === value) o.selected = true;
    select.appendChild(o);
  }
  row.appendChild(select);

  select.addEventListener("change", () => onChange(select.value));
  parent.appendChild(row);
  return select;
}

export function createColorPicker(
  parent: HTMLElement,
  label: string,
  value: [number, number, number],
  onChange: (v: [number, number, number]) => void,
): HTMLInputElement {
  const row = document.createElement("div");
  row.className = "wg-row";

  const lbl = document.createElement("label");
  lbl.textContent = label;
  row.appendChild(lbl);

  const input = document.createElement("input");
  input.type = "color";
  input.value = rgbToHex(value);
  row.appendChild(input);

  input.addEventListener("input", () => {
    onChange(hexToRgb(input.value));
  });

  parent.appendChild(row);
  return input;
}

export function createCheckbox(
  parent: HTMLElement,
  label: string,
  value: boolean,
  onChange: (v: boolean) => void,
): HTMLInputElement {
  const row = document.createElement("div");
  row.className = "wg-row";

  const lbl = document.createElement("label");
  lbl.textContent = label;
  row.appendChild(lbl);

  const input = document.createElement("input");
  input.type = "checkbox";
  input.checked = value;
  row.appendChild(input);

  input.addEventListener("change", () => onChange(input.checked));
  parent.appendChild(row);
  return input;
}

export function createNumberInput(
  parent: HTMLElement,
  label: string,
  value: number,
  onChange: (v: number) => void,
): HTMLInputElement {
  const row = document.createElement("div");
  row.className = "wg-row";

  const lbl = document.createElement("label");
  lbl.textContent = label;
  row.appendChild(lbl);

  const input = document.createElement("input");
  input.type = "number";
  input.value = String(value);
  row.appendChild(input);

  input.addEventListener("change", () => onChange(parseFloat(input.value) || 0));
  parent.appendChild(row);
  return input;
}

export function createButton(
  parent: HTMLElement,
  label: string,
  onClick: () => void,
  className = "wg-btn",
): HTMLButtonElement {
  const btn = document.createElement("button");
  btn.className = className;
  btn.textContent = label;
  btn.addEventListener("click", onClick);
  parent.appendChild(btn);
  return btn;
}

export function createToggleRow(
  parent: HTMLElement,
  options: string[],
  active: string,
  onChange: (v: string) => void,
): HTMLDivElement {
  const row = document.createElement("div");
  row.className = "wg-toggle-row";

  const buttons: HTMLButtonElement[] = [];
  for (const opt of options) {
    const btn = document.createElement("button");
    btn.className = `wg-toggle-btn${opt === active ? " active" : ""}`;
    btn.textContent = opt;
    btn.addEventListener("click", () => {
      buttons.forEach((b) => b.classList.remove("active"));
      btn.classList.add("active");
      onChange(opt);
    });
    row.appendChild(btn);
    buttons.push(btn);
  }

  parent.appendChild(row);
  return row;
}

export function createProgressBar(parent: HTMLElement): {
  container: HTMLDivElement;
  setProgress: (v: number) => void;
} {
  const container = document.createElement("div");
  container.className = "wg-progress";
  container.style.display = "none";

  const bar = document.createElement("div");
  bar.className = "wg-progress-bar";
  bar.style.width = "0%";
  container.appendChild(bar);

  parent.appendChild(container);

  return {
    container,
    setProgress(v: number) {
      container.style.display = v > 0 ? "block" : "none";
      bar.style.width = `${Math.round(v * 100)}%`;
    },
  };
}

// Color helpers
function rgbToHex(rgb: [number, number, number]): string {
  const r = Math.round(rgb[0] * 255).toString(16).padStart(2, "0");
  const g = Math.round(rgb[1] * 255).toString(16).padStart(2, "0");
  const b = Math.round(rgb[2] * 255).toString(16).padStart(2, "0");
  return `#${r}${g}${b}`;
}

function hexToRgb(hex: string): [number, number, number] {
  const r = parseInt(hex.slice(1, 3), 16) / 255;
  const g = parseInt(hex.slice(3, 5), 16) / 255;
  const b = parseInt(hex.slice(5, 7), 16) / 255;
  return [r, g, b];
}
