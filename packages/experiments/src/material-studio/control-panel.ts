/**
 * DOM control panel for Material Studio.
 *
 * AI-first workflow: the user picks a kit + role, types a prompt, hits
 * Generate. No manual PBR sliders — iteration is done by editing the prompt
 * and regenerating. Prompt-delta buttons append short modifiers to the
 * current prompt ("more weathered", "cooler hue", etc.) so common
 * adjustments are one click.
 */

import type { KitInfo, MaterialRole } from "./types";
import { buildPromptForMaterial } from "./api-client";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export type ControlPanelCallbacks = {
  onKitChange: (kit: KitInfo) => void;
  onRoleChange: (role: MaterialRole) => void;
  onGenerate: (prompt: string) => void | Promise<void>;
  onSave: () => void | Promise<void>;
};

export type ControlPanel = {
  element: HTMLElement;
  setKits: (kits: KitInfo[]) => void;
  setPreview: (imageData: ImageData) => void;
  setStatus: (text: string) => void;
  setGenerating: (busy: boolean) => void;
  setSaving: (busy: boolean) => void;
  getSelectedRole: () => MaterialRole | null;
  getSelectedKit: () => KitInfo | null;
  destroy: () => void;
};

// ---------------------------------------------------------------------------
// Prompt-delta presets — quick modifiers appended to the current prompt
// ---------------------------------------------------------------------------

const PROMPT_DELTAS: ReadonlyArray<{ label: string; suffix: string }> = [
  { label: "+ weathered", suffix: " More weathered and aged." },
  { label: "+ pristine", suffix: " More pristine and clean." },
  { label: "+ warmer", suffix: " Shift palette warmer." },
  { label: "+ cooler", suffix: " Shift palette cooler." },
  { label: "+ darker", suffix: " Slightly darker overall." },
  { label: "+ lighter", suffix: " Slightly lighter overall." }
];

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
  promptArea.rows = 4;
  promptArea.style.cssText = `
    width: 100%; padding: 8px; min-height: 44px;
    background: #1e2430; color: #ccd; border: 1px solid #333;
    border-radius: 4px; font: 12px/1.4 monospace;
    resize: vertical; box-sizing: border-box;
  `;
  panel.appendChild(promptArea);

  // Prompt-delta quick buttons
  const deltaRow = el(
    "div",
    "display: flex; flex-wrap: wrap; gap: 4px; margin-top: 6px;",
    panel
  );
  for (const delta of PROMPT_DELTAS) {
    const btn = document.createElement("button");
    btn.textContent = delta.label;
    btn.style.cssText = `
      flex: 0 0 auto; padding: 4px 8px; min-height: 28px;
      background: #1e2430; color: #aab; border: 1px solid #333;
      border-radius: 3px; font: 11px/1 monospace; cursor: pointer;
    `;
    btn.addEventListener("click", () => {
      const current = promptArea.value.trim();
      promptArea.value = current + delta.suffix;
      promptArea.focus();
    });
    deltaRow.appendChild(btn);
  }

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

  // --- Save ---
  const saveBtn = document.createElement("button");
  saveBtn.textContent = "Save to Registry";
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
      saveBtn.textContent = busy ? "Saving..." : "Save to Registry";
      saveBtn.style.opacity = busy ? "0.6" : "1";
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
