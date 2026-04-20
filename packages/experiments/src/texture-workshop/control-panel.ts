/**
 * Vanilla TS DOM control panel for the texture workshop.
 *
 * Layout: 320px fixed-width left panel with dark theme.
 * Sections: Kit/Tile/Role selectors, prompt textarea, preview canvas,
 * PBR sliders, Save button, status text.
 */

import type { KitInfo, MaterialRole, PbrParams } from "./types";
import { DEFAULT_PBR_PARAMS } from "./types";
import { buildPromptForMaterial, MATERIAL_DESCRIPTIONS } from "./api-client";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export type ControlPanelCallbacks = {
  onKitChange: (kit: KitInfo) => void;
  onRoleChange: (role: MaterialRole) => void;
  onGenerate: (prompt: string) => void | Promise<void>;
  onSliderChange: (params: PbrParams) => void;
  onSave: () => void | Promise<void>;
};

export type ControlPanel = {
  element: HTMLElement;
  setKits: (kits: KitInfo[]) => void;
  setPreview: (imageData: ImageData) => void;
  setStatus: (text: string) => void;
  setGenerating: (busy: boolean) => void;
  setSaving: (busy: boolean) => void;
  getParams: () => PbrParams;
  getSelectedRole: () => MaterialRole | null;
  getSelectedKit: () => KitInfo | null;
  destroy: () => void;
};

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

const PANEL_WIDTH = 320;

function el<K extends keyof HTMLElementTagNameMap>(
  tag: K,
  css: string,
  parent: HTMLElement
): HTMLElementTagNameMap[K] {
  const e = document.createElement(tag);
  e.style.cssText = css;
  parent.appendChild(e);
  return e;
}

function label(text: string, parent: HTMLElement): HTMLLabelElement {
  const l = document.createElement("label");
  l.textContent = text;
  l.style.cssText = "font: 11px/1 monospace; color: #889; display: block; margin-bottom: 3px;";
  parent.appendChild(l);
  return l;
}

function select(parent: HTMLElement): HTMLSelectElement {
  const s = document.createElement("select");
  s.style.cssText = `
    width: 100%; min-height: 44px; padding: 8px;
    background: #1e2430; color: #ccd; border: 1px solid #333;
    border-radius: 4px; font: 13px/1 monospace; cursor: pointer;
  `;
  parent.appendChild(s);
  return s;
}

function separator(parent: HTMLElement): void {
  const d = document.createElement("div");
  d.style.cssText = "height: 1px; background: #2a2e36; margin: 12px 0;";
  parent.appendChild(d);
}

function rangeSlider(
  labelText: string,
  min: number,
  max: number,
  step: number,
  value: number,
  parent: HTMLElement,
  onChange: (v: number) => void
): HTMLInputElement {
  const row = el("div", "display: flex; align-items: center; gap: 8px; margin-bottom: 6px;", parent);

  const lbl = document.createElement("span");
  lbl.textContent = labelText;
  lbl.style.cssText = "font: 11px/1 monospace; color: #889; width: 80px; flex-shrink: 0;";
  row.appendChild(lbl);

  const input = document.createElement("input");
  input.type = "range";
  input.min = String(min);
  input.max = String(max);
  input.step = String(step);
  input.value = String(value);
  input.style.cssText = "flex: 1; min-height: 44px; cursor: pointer;";
  row.appendChild(input);

  const val = document.createElement("span");
  val.textContent = String(value);
  val.style.cssText = "font: 11px/1 monospace; color: #aab; width: 36px; text-align: right;";
  row.appendChild(val);

  input.addEventListener("input", () => {
    val.textContent = input.value;
    onChange(Number(input.value));
  });

  return input;
}

// ---------------------------------------------------------------------------
// Panel construction
// ---------------------------------------------------------------------------

export function createControlPanel(callbacks: ControlPanelCallbacks): ControlPanel {
  const panel = document.createElement("div");
  panel.style.cssText = `
    position: absolute; top: 0; left: 0; bottom: 0;
    width: ${PANEL_WIDTH}px;
    background: #14181e; border-right: 1px solid #2a2e36;
    overflow-y: auto; overflow-x: hidden;
    padding: 12px; box-sizing: border-box;
    font: 13px/1.4 monospace; color: #ccd;
    z-index: 10;
    -webkit-overflow-scrolling: touch;
  `;

  // --- Kit selector ---
  label("Kit", panel);
  const kitSelect = select(panel);

  // --- Role selector ---
  const roleGroup = el("div", "margin-top: 8px;", panel);
  label("Role", roleGroup);
  const roleSelect = select(roleGroup);

  separator(panel);

  // --- Prompt ---
  label("Prompt", panel);
  const promptArea = document.createElement("textarea");
  promptArea.rows = 3;
  promptArea.style.cssText = `
    width: 100%; padding: 8px; min-height: 44px;
    background: #1e2430; color: #ccd; border: 1px solid #333;
    border-radius: 4px; font: 12px/1.4 monospace;
    resize: vertical; box-sizing: border-box;
  `;
  panel.appendChild(promptArea);

  const generateBtn = document.createElement("button");
  generateBtn.textContent = "Generate";
  generateBtn.style.cssText = `
    width: 100%; min-height: 44px; margin-top: 8px; padding: 8px;
    background: #2a4a6e; color: #eef; border: 1px solid #4a7ab0;
    border-radius: 4px; font: 13px/1 monospace; cursor: pointer;
  `;
  panel.appendChild(generateBtn);

  separator(panel);

  // --- Preview canvas ---
  label("Preview (64×64)", panel);
  const previewCanvas = document.createElement("canvas");
  previewCanvas.width = 64;
  previewCanvas.height = 64;
  previewCanvas.style.cssText = `
    width: 128px; height: 128px;
    image-rendering: pixelated;
    background: #0a0c10; border: 1px solid #333;
    border-radius: 4px; display: block;
  `;
  panel.appendChild(previewCanvas);
  const previewCtx = previewCanvas.getContext("2d")!;

  separator(panel);

  // --- PBR sliders ---
  label("PBR Parameters", panel);

  const params: PbrParams = { ...DEFAULT_PBR_PARAMS };

  const onSlider = (): void => callbacks.onSliderChange({ ...params });

  rangeSlider("strength", 0.5, 4, 0.1, params.strength, panel, (v) => {
    params.strength = v; onSlider();
  });
  rangeSlider("roughness", 0, 1, 0.05, params.baseRoughness, panel, (v) => {
    params.baseRoughness = v; onSlider();
  });
  rangeSlider("rough rng", 0, 0.5, 0.05, params.roughnessRange, panel, (v) => {
    params.roughnessRange = v; onSlider();
  });
  rangeSlider("ao floor", 0.2, 1, 0.05, params.aoFloor, panel, (v) => {
    params.aoFloor = v; onSlider();
  });
  rangeSlider("ao mult", 0.5, 4, 0.1, params.aoMultiplier, panel, (v) => {
    params.aoMultiplier = v; onSlider();
  });

  separator(panel);

  // --- Save ---
  const saveBtn = document.createElement("button");
  saveBtn.textContent = "Save to Assets";
  saveBtn.style.cssText = `
    width: 100%; min-height: 44px; padding: 8px;
    background: #2a5a3e; color: #eef; border: 1px solid #4aaa70;
    border-radius: 4px; font: 13px/1 monospace; cursor: pointer;
  `;
  panel.appendChild(saveBtn);

  const statusEl = el("div", "margin-top: 8px; font: 11px/1.2 monospace; color: #667; min-height: 16px;", panel);

  // --- State ---
  let kits: KitInfo[] = [];
  let currentKit: KitInfo | null = null;
  let currentRole: MaterialRole | null = null;

  function populateRoles(kit: KitInfo): void {
    roleSelect.innerHTML = "";
    for (const role of kit.roles) {
      const opt = document.createElement("option");
      opt.value = role.role;
      opt.textContent = role.role;
      roleSelect.appendChild(opt);
    }
    roleGroup.style.display = kit.roles.length <= 1 ? "none" : "";
    currentRole = kit.roles[0] ?? null;
    if (currentRole) callbacks.onRoleChange(currentRole);

    // Pre-fill prompt with material description
    if (currentRole) {
      promptArea.value = buildPromptForMaterial(currentRole.materialId);
    }
  }

  // --- Events ---
  kitSelect.addEventListener("change", () => {
    const kit = kits.find((k) => k.id === kitSelect.value);
    if (!kit) return;
    currentKit = kit;
    populateRoles(kit);
    callbacks.onKitChange(kit);
  });

  roleSelect.addEventListener("change", () => {
    if (!currentKit) return;
    const role = currentKit.roles.find((r) => r.role === roleSelect.value);
    if (!role) return;
    currentRole = role;
    callbacks.onRoleChange(role);
    promptArea.value = buildPromptForMaterial(role.materialId);
  });

  generateBtn.addEventListener("click", () => {
    callbacks.onGenerate(promptArea.value.trim());
  });

  saveBtn.addEventListener("click", () => {
    callbacks.onSave();
  });

  // --- Public API ---
  return {
    element: panel,

    setKits(newKits: KitInfo[]): void {
      kits = newKits;
      kitSelect.innerHTML = "";
      for (const kit of kits) {
        const opt = document.createElement("option");
        opt.value = kit.id;
        opt.textContent = kit.name.replace(/_/g, " ");
        kitSelect.appendChild(opt);
      }
      if (kits.length > 0) {
        currentKit = kits[0];
        kitSelect.value = currentKit.id;
        populateRoles(currentKit);
        callbacks.onKitChange(currentKit);
      }
    },

    setPreview(imageData: ImageData): void {
      previewCtx.putImageData(imageData, 0, 0);
    },

    setStatus(text: string): void {
      statusEl.textContent = text;
    },

    setGenerating(busy: boolean): void {
      generateBtn.disabled = busy;
      generateBtn.textContent = busy ? "Generating..." : "Generate";
      generateBtn.style.opacity = busy ? "0.6" : "1";
    },

    setSaving(busy: boolean): void {
      saveBtn.disabled = busy;
      saveBtn.textContent = busy ? "Saving..." : "Save to Assets";
      saveBtn.style.opacity = busy ? "0.6" : "1";
    },

    getParams(): PbrParams {
      return { ...params };
    },

    getSelectedRole(): MaterialRole | null {
      return currentRole;
    },

    getSelectedKit(): KitInfo | null {
      return currentKit;
    },

    destroy(): void {
      panel.remove();
    }
  };
}
