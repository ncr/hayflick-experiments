/**
 * DOM control panel for Material Studio.
 *
 * Flow: pick a base mesh from the flat catalog → name the entry → walk each
 * texturable surface (discovered from the GLB's textureRole extras) →
 * generate-and-approve each in turn → Bake produces one GLB in
 * `assets/textured-meshes/<name>/`.
 *
 * The panel owns per-surface authoring state (prompt, last maps, approved
 * flag). Index.ts drives 3D-view updates via callbacks.
 */

import type { GeneratedMaps, Surface, SurfaceState } from "./types";
import { defaultPromptForRole } from "./api-client";

const PANEL_WIDTH = 340;

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
// Types
// ---------------------------------------------------------------------------

export type ControlPanelCallbacks = {
  /** User picked a new base mesh. Index.ts loads the GLB and calls setSurfaces. */
  onMeshChange: (meshId: string) => void;
  /** User focused a different surface. Index.ts may highlight it in the 3D view. */
  onSurfaceFocus: (role: string) => void;
  /** User clicked Generate. Returns the new maps; panel stores them + updates preview. */
  onGenerate: (role: string, prompt: string) => Promise<GeneratedMaps>;
  /** User clicked Approve. Panel marks the surface approved. */
  onApprove: (role: string) => void;
  /** User clicked Bake. Index.ts builds the POST body and calls the bake endpoint. */
  onBake: (entryName: string, states: SurfaceState[]) => Promise<void>;
};

export type ControlPanel = {
  element: HTMLElement;
  setMeshList: (meshes: string[]) => void;
  /** Called by index.ts after a mesh is loaded and its surfaces discovered. */
  setSurfaces: (surfaces: Surface[]) => void;
  setStatus: (text: string) => void;
  destroy: () => void;
};

// ---------------------------------------------------------------------------
// Tiny DOM helpers
// ---------------------------------------------------------------------------

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
    width: 100%; min-height: 40px; padding: 8px;
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

  // --- Base mesh selector ---
  label("Base mesh", panel);
  const meshSelect = select(panel);

  // --- Entry name ---
  const nameRow = el("div", "margin-top: 8px;", panel);
  label("Entry name", nameRow);
  const nameInput = document.createElement("input");
  nameInput.type = "text";
  nameInput.placeholder = "e.g. desert-wall-weathered";
  nameInput.style.cssText = `
    width: 100%; padding: 8px; min-height: 40px;
    background: #1e2430; color: #ccd; border: 1px solid #333;
    border-radius: 4px; font: 12px/1 monospace; box-sizing: border-box;
  `;
  nameRow.appendChild(nameInput);

  separator(panel);

  // --- Surface tabs ---
  label("Surfaces", panel);
  const surfaceTabs = el(
    "div",
    "display: flex; flex-wrap: wrap; gap: 4px; margin-bottom: 8px;",
    panel
  );

  // --- Prompt ---
  label("Prompt", panel);
  const promptArea = document.createElement("textarea");
  promptArea.rows = 5;
  promptArea.style.cssText = `
    width: 100%; padding: 8px; min-height: 44px;
    background: #1e2430; color: #ccd; border: 1px solid #333;
    border-radius: 4px; font: 12px/1.4 monospace;
    resize: vertical; box-sizing: border-box;
  `;
  panel.appendChild(promptArea);

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
      promptArea.value = promptArea.value.trim() + delta.suffix;
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

  // --- Preview canvas ---
  const previewRow = el("div", "margin-top: 10px;", panel);
  label("Preview (64×64)", previewRow);
  const previewCanvas = document.createElement("canvas");
  previewCanvas.width = 64;
  previewCanvas.height = 64;
  previewCanvas.style.cssText = `
    width: 128px; height: 128px;
    image-rendering: pixelated;
    background: #0a0c10; border: 1px solid #333;
    border-radius: 4px; display: block;
  `;
  previewRow.appendChild(previewCanvas);
  const previewCtx = previewCanvas.getContext("2d")!;

  // --- Approve ---
  const approveBtn = document.createElement("button");
  approveBtn.textContent = "Approve surface";
  approveBtn.style.cssText = `
    width: 100%; min-height: 40px; margin-top: 10px; padding: 8px;
    background: #2a5a3e; color: #eef; border: 1px solid #4aaa70;
    border-radius: 4px; font: 12px/1 monospace; cursor: pointer;
  `;
  panel.appendChild(approveBtn);

  separator(panel);

  // --- Bake ---
  const bakeBtn = document.createElement("button");
  bakeBtn.textContent = "Bake textured mesh";
  bakeBtn.style.cssText = `
    width: 100%; min-height: 48px; padding: 8px;
    background: #4a3a1a; color: #fed; border: 1px solid #8a6a2a;
    border-radius: 4px; font: 13px/1 monospace; cursor: pointer;
  `;
  panel.appendChild(bakeBtn);

  const statusEl = el(
    "div",
    "margin-top: 10px; font: 11px/1.3 monospace; color: #778; min-height: 32px;",
    panel
  );

  // ---------------------------------------------------------------------------
  // State
  // ---------------------------------------------------------------------------

  let meshList: string[] = [];
  let currentMeshId: string | null = null;
  let surfaceStates: Map<string, SurfaceState> = new Map();
  let currentRole: string | null = null;

  function renderSurfaceTabs(): void {
    surfaceTabs.innerHTML = "";
    for (const state of surfaceStates.values()) {
      const btn = document.createElement("button");
      const active = state.surface.role === currentRole;
      const approvedMark = state.approved ? "✓" : "";
      const isSynthetic = state.surface.kind === "synthetic";
      btn.textContent = `${state.surface.role}${approvedMark ? ` ${approvedMark}` : ""}${isSynthetic ? " (preset)" : ""}`;
      btn.style.cssText = `
        padding: 6px 10px; min-height: 30px;
        background: ${active ? "#2a4a6e" : "#1e2430"};
        color: ${state.approved ? "#9c9" : active ? "#eef" : "#aab"};
        border: 1px solid ${active ? "#4a7ab0" : "#333"};
        border-radius: 3px; font: 11px/1 monospace; cursor: pointer;
      `;
      btn.addEventListener("click", () => focusSurface(state.surface.role));
      surfaceTabs.appendChild(btn);
    }
  }

  function focusSurface(role: string): void {
    const state = surfaceStates.get(role);
    if (!state) return;
    currentRole = role;

    if (state.surface.kind === "synthetic") {
      promptArea.value = `(preset: ${state.surface.synthetic ?? "synthetic"} — no prompt)`;
      promptArea.disabled = true;
      generateBtn.disabled = true;
      approveBtn.disabled = true;
      approveBtn.textContent = "Auto-approved (preset)";
    } else {
      promptArea.value = state.prompt;
      promptArea.disabled = false;
      generateBtn.disabled = false;
      approveBtn.disabled = !state.maps;
      approveBtn.textContent = state.approved ? "Approved ✓" : "Approve surface";
    }

    // Redraw preview from stored maps
    if (state.maps) {
      previewCtx.putImageData(state.maps.baseColor, 0, 0);
    } else {
      previewCtx.clearRect(0, 0, 64, 64);
    }

    renderSurfaceTabs();
    updateBakeGate();
    callbacks.onSurfaceFocus(role);
  }

  function updateBakeGate(): void {
    const allDone =
      surfaceStates.size > 0 &&
      Array.from(surfaceStates.values()).every(
        (s) => s.surface.kind === "synthetic" || s.approved
      );
    const hasName = nameInput.value.trim().length > 0;
    bakeBtn.disabled = !(allDone && hasName);
    bakeBtn.style.opacity = bakeBtn.disabled ? "0.5" : "1";
  }

  // ---------------------------------------------------------------------------
  // Events
  // ---------------------------------------------------------------------------

  meshSelect.addEventListener("change", () => {
    const id = meshSelect.value;
    if (!id) return;
    currentMeshId = id;
    surfaceStates = new Map();
    currentRole = null;
    renderSurfaceTabs();
    updateBakeGate();
    statusEl.textContent = "Loading mesh…";
    callbacks.onMeshChange(id);
  });

  nameInput.addEventListener("input", () => updateBakeGate());

  promptArea.addEventListener("input", () => {
    if (!currentRole) return;
    const state = surfaceStates.get(currentRole);
    if (state) state.prompt = promptArea.value;
  });

  generateBtn.addEventListener("click", async () => {
    if (!currentRole) return;
    const state = surfaceStates.get(currentRole);
    if (!state || state.surface.kind !== "pbr") return;

    state.prompt = promptArea.value.trim();
    generateBtn.disabled = true;
    generateBtn.textContent = "Generating…";
    statusEl.textContent = `Generating ${currentRole}…`;
    try {
      const maps = await callbacks.onGenerate(state.surface.role, state.prompt);
      state.maps = maps;
      previewCtx.putImageData(maps.baseColor, 0, 0);
      approveBtn.disabled = false;
      approveBtn.textContent = state.approved ? "Approved ✓" : "Approve surface";
      statusEl.textContent = `Generated ${currentRole}. Tweak prompt and regen or click Approve.`;
    } catch (err) {
      statusEl.textContent = `Error: ${(err as Error).message}`;
    } finally {
      generateBtn.disabled = false;
      generateBtn.textContent = "Generate";
    }
  });

  approveBtn.addEventListener("click", () => {
    if (!currentRole) return;
    const state = surfaceStates.get(currentRole);
    if (!state || !state.maps) return;
    state.approved = true;
    callbacks.onApprove(currentRole);
    renderSurfaceTabs();
    updateBakeGate();

    // Auto-advance to next unapproved non-synthetic surface
    const nextUnapproved = Array.from(surfaceStates.values()).find(
      (s) => s.surface.kind === "pbr" && !s.approved
    );
    if (nextUnapproved) {
      focusSurface(nextUnapproved.surface.role);
      statusEl.textContent = `Approved. Next surface: ${nextUnapproved.surface.role}`;
    } else {
      statusEl.textContent = "All surfaces approved. Ready to bake.";
      focusSurface(state.surface.role); // stay on current
    }
  });

  bakeBtn.addEventListener("click", async () => {
    const name = nameInput.value.trim();
    if (!name) return;
    bakeBtn.disabled = true;
    bakeBtn.textContent = "Baking… (Blender ~30s)";
    statusEl.textContent = `Baking '${name}'…`;
    try {
      await callbacks.onBake(name, Array.from(surfaceStates.values()));
      statusEl.textContent = `Baked '${name}' → assets/textured-meshes/${name}/artifact.glb`;
    } catch (err) {
      statusEl.textContent = `Bake failed: ${(err as Error).message}`;
    } finally {
      bakeBtn.disabled = false;
      bakeBtn.textContent = "Bake textured mesh";
      updateBakeGate();
    }
  });

  // ---------------------------------------------------------------------------
  // Public API
  // ---------------------------------------------------------------------------

  return {
    element: panel,

    setMeshList(meshes: string[]): void {
      meshList = meshes;
      meshSelect.innerHTML = "";
      for (const m of meshes) {
        const opt = document.createElement("option");
        opt.value = m;
        opt.textContent = m;
        meshSelect.appendChild(opt);
      }
      if (meshes.length > 0 && !currentMeshId) {
        currentMeshId = meshes[0];
        meshSelect.value = currentMeshId;
        callbacks.onMeshChange(currentMeshId);
      }
    },

    setSurfaces(surfaces: Surface[]): void {
      surfaceStates = new Map();
      for (const s of surfaces) {
        surfaceStates.set(s.role, {
          surface: s,
          prompt: defaultPromptForRole(s.role),
          maps: null,
          approved: s.kind === "synthetic"
        });
      }
      // Focus first pbr surface, or first surface if all synthetic
      const firstPbr = surfaces.find((s) => s.kind === "pbr");
      currentRole = (firstPbr ?? surfaces[0])?.role ?? null;
      renderSurfaceTabs();
      if (currentRole) focusSurface(currentRole);
      updateBakeGate();
      statusEl.textContent = `Loaded ${meshList.length > 0 ? currentMeshId : ""}. ${surfaces.length} surface(s).`;
    },

    setStatus(text: string): void {
      statusEl.textContent = text;
    },

    destroy(): void {
      panel.remove();
    }
  };
}
