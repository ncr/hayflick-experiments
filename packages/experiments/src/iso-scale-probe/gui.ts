import GUI from "lil-gui";

export type ScalePreset = {
  label: string;
  fixedRenderHeight: number;
  baseOrthoHeight: number;
};

// Only the RATIO R = fixedRenderHeight / baseOrthoHeight defines the look.
// The actual lowpixel render height comes from the browser/canvas + zoom +
// DPR; orthoHeight scales linearly with that, so R is invariant. The
// (FRH, BOH) pair below is one of infinitely many representations of each
// R — picked so baseOrthoHeight = 4*sqrt(2) for the clean ones (smallest
// irrational form). The "Equivalence check" presets at the bottom store
// the SAME R as 32x16 with different absolute (FRH, BOH) values so you
// can confirm the two outputs are pixel-identical.
//
//   H per tile = R * sqrt(2)/2     (1 tile = 1 world unit = 1.28 m)
//   V per tile = H / 2             (2:1 iso collapse along horizontal world axes)
//
// Clean integer V requires R = 2N * sqrt(2) for integer N (so V = N).
// R = 25*sqrt(2) is the current default and gives V = 12.5 (broken).
export const PRESETS: ScalePreset[] = [
  // The LOCKED iso contract — what PixelPerfectDefaults uses today.
  // ISO_VIEW_CONTRACT in @common/render is the source of truth; do not
  // override these values on the game render path.
  {
    label: "** LOCKED 32 x 16 ** (R = 32 sqrt(2)) -- the game contract",
    fixedRenderHeight: 256,
    baseOrthoHeight: 4 * Math.SQRT2
  },
  // Historical / comparison presets. None of these ship.
  {
    label: "Old default 25 x 12.5 (R = 25 sqrt(2)) -- pre-lock, half-pixel V",
    fixedRenderHeight: 240,
    baseOrthoHeight: 4.8 * Math.SQRT2
  },
  {
    label: "16 x 8    (R = 16 sqrt(2)) -- comparison, chunky",
    fixedRenderHeight: 128,
    baseOrthoHeight: 4 * Math.SQRT2
  },
  {
    label: "48 x 24   (R = 48 sqrt(2)) -- CLEAN, mid",
    fixedRenderHeight: 384,
    baseOrthoHeight: 4 * Math.SQRT2
  },
  {
    label: "64 x 32   (R = 64 sqrt(2)) -- CLEAN, 4x pixels",
    fixedRenderHeight: 512,
    baseOrthoHeight: 4 * Math.SQRT2
  },
  {
    label: "96 x 48   (R = 96 sqrt(2)) -- CLEAN, dense",
    fixedRenderHeight: 768,
    baseOrthoHeight: 4 * Math.SQRT2
  },
  {
    label: "128 x 64  (R = 128 sqrt(2)) -- CLEAN, very dense",
    fixedRenderHeight: 1024,
    baseOrthoHeight: 4 * Math.SQRT2
  },
  // Equivalence checks: same R = 32 sqrt(2) as the "32 x 16" preset
  // above, but stored as a different (FRH, BOH) pair. Should produce
  // pixel-identical output -- demonstrates that only the ratio matters.
  {
    label: "Equiv 32 x 16 alt-A  (240 / 3.75 sqrt(2))",
    fixedRenderHeight: 240,
    baseOrthoHeight: 3.75 * Math.SQRT2
  },
  {
    label: "Equiv 32 x 16 alt-B  (192 / 3 sqrt(2))",
    fixedRenderHeight: 192,
    baseOrthoHeight: 3 * Math.SQRT2
  }
];

export type ProbeConfig = {
  presetLabel: string;
  fixedRenderHeight: number;
  baseOrthoHeight: number;
  basePixelZoom: number;
  outlines: boolean;
  shadows: boolean;
  showGrid: boolean;
};

// Default to the LOCKED iso contract (now index 0).
const DEFAULT_PRESET_INDEX = 0;
export const DEFAULT_CONFIG: ProbeConfig = {
  presetLabel: PRESETS[DEFAULT_PRESET_INDEX]!.label,
  fixedRenderHeight: PRESETS[DEFAULT_PRESET_INDEX]!.fixedRenderHeight,
  baseOrthoHeight: PRESETS[DEFAULT_PRESET_INDEX]!.baseOrthoHeight,
  basePixelZoom: 4,
  outlines: true,
  shadows: true,
  showGrid: true
};

const STORAGE_KEY = "iso-scale-probe-config-v1";

export function loadConfig(): ProbeConfig {
  try {
    const raw = window.localStorage.getItem(STORAGE_KEY);
    if (!raw) return { ...DEFAULT_CONFIG };
    const parsed = JSON.parse(raw) as Partial<ProbeConfig>;
    return { ...DEFAULT_CONFIG, ...parsed };
  } catch {
    return { ...DEFAULT_CONFIG };
  }
}

export function saveConfig(c: ProbeConfig): void {
  try {
    window.localStorage.setItem(STORAGE_KEY, JSON.stringify(c));
  } catch {
    // localStorage might be disabled - silently ignore.
  }
}

export type Derived = {
  R: number;
  hPerTile: number;
  vPerTile: number;
  hPerHalfTile: number;
  vPerHalfTile: number;
  hPerTwoTile: number;
  vPerTwoTile: number;
  yPerTile: number;
  yPerTwoTile: number;
  cmPerTexelHorizH: number;
  cmPerTexelY: number;
  vIsHalfPixel: boolean;
  vIsInteger: boolean;
};

export function deriveValues(c: ProbeConfig): Derived {
  const R = c.fixedRenderHeight / c.baseOrthoHeight;
  const hPerWorldUnit = R * (Math.SQRT2 / 2);
  const vPerWorldUnit = hPerWorldUnit / 2; // 2:1 iso collapse
  const hPerTile = hPerWorldUnit; // 1 world unit == 1 tile == 1.28 m
  const vPerTile = vPerWorldUnit;
  const hPerHalfTile = hPerTile * 0.5;
  const vPerHalfTile = vPerTile * 0.5;
  const hPerTwoTile = hPerTile * 2;
  const vPerTwoTile = vPerTile * 2;
  // Vertical Y axis (world up) projects to screen-V with cos(pi/6) = sqrt(3)/2.
  const yPerTile = R * (Math.sqrt(3) / 2);
  const yPerTwoTile = yPerTile * 2;
  const cmPerTexelHorizH = 128 / hPerTile;
  const cmPerTexelY = 128 / yPerTile;
  const vRounded = Math.round(vPerTile);
  const vIsInteger = Math.abs(vPerTile - vRounded) < 1e-6;
  const vIsHalfPixel =
    !vIsInteger && Math.abs(vPerTile - (Math.floor(vPerTile) + 0.5)) < 1e-6;
  return {
    R,
    hPerTile,
    vPerTile,
    hPerHalfTile,
    vPerHalfTile,
    hPerTwoTile,
    vPerTwoTile,
    yPerTile,
    yPerTwoTile,
    cmPerTexelHorizH,
    cmPerTexelY,
    vIsHalfPixel,
    vIsInteger
  };
}

export type GuiCallbacks = {
  onScaleChange(): void;
  onZoomChange(): void;
  onTogglesChange(): void;
};

export type GuiHandle = {
  gui: GUI;
  refreshReadout(): void;
  destroy(): void;
};

const fmt = (n: number, dp: number = 3): string => {
  if (!isFinite(n)) return String(n);
  const v = Number(n.toFixed(dp));
  return Object.is(v, -0) ? "0" : String(v);
};

export function buildGui(
  config: ProbeConfig,
  cb: GuiCallbacks,
  parent?: HTMLElement
): GuiHandle {
  const gui = new GUI({ title: "Iso Scale Probe", container: parent });

  // Mutable readout object lil-gui can read. We keep keys short so they
  // line up in the panel column. Edge entries match the on-stage boxes:
  //   Box A (1 wu cube)         -> 1 tile X/Z + 1 tile Y
  //   Box B (1 x 2 x 0.5 wu)    -> 1 tile X + 0.5 tile Z + 2 tile Y
  const readout = {
    R: "",
    "1 px = X world units": "",
    "1 px = X cm (screen)": "",
    "1 px along world-X/Z (cm)": "",
    "1 px along world-Y (cm)": "",
    "1-tile (1.28m) X/Z H": "",
    "1-tile (1.28m) X/Z V": "",
    "0.5-tile (0.64m) X/Z H": "",
    "0.5-tile (0.64m) X/Z V": "",
    "2-tile (2.56m) X/Z H": "",
    "2-tile (2.56m) X/Z V": "",
    "1-tile Y-edge (px)": "",
    "2-tile Y-edge (px)": "",
    verdict: ""
  };

  const refreshReadout = (): void => {
    const d = deriveValues(config);
    readout.R = `${fmt(d.R, 4)}  (= ${fmt(d.R / Math.SQRT2, 4)} * sqrt(2))`;
    // 1 lowpixel covers 1/R world units along the camera image plane
    // (square pixels). World-axis-projected sizes use the projection
    // foreshortening: world-X/Z at 45 degrees -> sqrt(2)/R wu/px;
    // world-Y at pitch=pi/6 -> 2/(R*sqrt(3)) wu/px.
    const wuPerPxScreen = 1 / d.R;
    const cmPerPxScreen = wuPerPxScreen * 128;
    const wuPerPxAlongXZ = Math.SQRT2 / d.R;
    const cmPerPxAlongXZ = wuPerPxAlongXZ * 128;
    const wuPerPxAlongY = 2 / (d.R * Math.sqrt(3));
    const cmPerPxAlongY = wuPerPxAlongY * 128;
    readout["1 px = X world units"] = `${fmt(wuPerPxScreen, 6)} wu (screen-axis)`;
    readout["1 px = X cm (screen)"] = `${fmt(cmPerPxScreen, 4)} cm (screen-axis)`;
    readout["1 px along world-X/Z (cm)"] = `${fmt(cmPerPxAlongXZ, 4)} cm  (= ${fmt(wuPerPxAlongXZ, 6)} wu)`;
    readout["1 px along world-Y (cm)"] = `${fmt(cmPerPxAlongY, 4)} cm  (= ${fmt(wuPerPxAlongY, 6)} wu)`;
    readout["1-tile (1.28m) X/Z H"] = fmt(d.hPerTile);
    readout["1-tile (1.28m) X/Z V"] = fmt(d.vPerTile);
    readout["0.5-tile (0.64m) X/Z H"] = fmt(d.hPerHalfTile);
    readout["0.5-tile (0.64m) X/Z V"] = fmt(d.vPerHalfTile);
    readout["2-tile (2.56m) X/Z H"] = fmt(d.hPerTwoTile);
    readout["2-tile (2.56m) X/Z V"] = fmt(d.vPerTwoTile);
    readout["1-tile Y-edge (px)"] = `${fmt(d.yPerTile)}  (Y-screen length)`;
    readout["2-tile Y-edge (px)"] = `${fmt(d.yPerTwoTile)}  (Y-screen length)`;
    if (d.vIsInteger) {
      readout.verdict = "OK - V per tile is integer (clean staircase)";
    } else if (d.vIsHalfPixel) {
      readout.verdict = "BROKEN - V is half-pixel (staircase splits)";
    } else {
      readout.verdict = "FRACTIONAL - V is non-integer (uneven steps)";
    }
    gui.controllersRecursive().forEach((c) => c.updateDisplay());
  };

  const presetLabels = PRESETS.map((p) => p.label);
  const customLabel = "Custom (manual override below)";

  // Selecting a preset writes its values into config and rebuilds.
  // Editing the manual fields below switches the dropdown to "Custom".
  const presetOptions = [...presetLabels, customLabel];
  const presetState = { presetLabel: config.presetLabel };
  if (!presetOptions.includes(presetState.presetLabel)) {
    presetState.presetLabel = customLabel;
    config.presetLabel = customLabel;
  }

  gui
    .add(presetState, "presetLabel", presetOptions)
    .name("preset")
    .onChange((label: string) => {
      const preset = PRESETS.find((p) => p.label === label);
      if (preset) {
        config.fixedRenderHeight = preset.fixedRenderHeight;
        config.baseOrthoHeight = preset.baseOrthoHeight;
      }
      config.presetLabel = label;
      saveConfig(config);
      cb.onScaleChange();
      refreshReadout();
    });

  const fManual = gui.addFolder("Manual override");
  fManual
    .add(config, "fixedRenderHeight")
    .name("fixedRenderHeight")
    .onFinishChange(() => {
      config.presetLabel = customLabel;
      presetState.presetLabel = customLabel;
      saveConfig(config);
      cb.onScaleChange();
      refreshReadout();
    });
  fManual
    .add(config, "baseOrthoHeight")
    .name("baseOrthoHeight")
    .onFinishChange(() => {
      config.presetLabel = customLabel;
      presetState.presetLabel = customLabel;
      saveConfig(config);
      cb.onScaleChange();
      refreshReadout();
    });
  // Quick-set helpers for common baseOrthoHeight values that show up
  // across the preset table; saves typing irrational decimals.
  const baseOrthoActions = {
    "set 4 sqrt(2)": () => {
      config.baseOrthoHeight = 4 * Math.SQRT2;
      config.presetLabel = customLabel;
      presetState.presetLabel = customLabel;
      saveConfig(config);
      cb.onScaleChange();
      refreshReadout();
    },
    "set 4.8 sqrt(2)": () => {
      config.baseOrthoHeight = 4.8 * Math.SQRT2;
      config.presetLabel = customLabel;
      presetState.presetLabel = customLabel;
      saveConfig(config);
      cb.onScaleChange();
      refreshReadout();
    },
    "set 3.75 sqrt(2)": () => {
      config.baseOrthoHeight = 3.75 * Math.SQRT2;
      config.presetLabel = customLabel;
      presetState.presetLabel = customLabel;
      saveConfig(config);
      cb.onScaleChange();
      refreshReadout();
    }
  };
  fManual.add(baseOrthoActions, "set 4 sqrt(2)").name("BOH := 4 sqrt(2)");
  fManual.add(baseOrthoActions, "set 4.8 sqrt(2)").name("BOH := 4.8 sqrt(2)");
  fManual.add(baseOrthoActions, "set 3.75 sqrt(2)").name("BOH := 3.75 sqrt(2)");

  const fView = gui.addFolder("View");
  fView
    .add(config, "basePixelZoom", 1, 8, 1)
    .name("basePixelZoom")
    .onChange(() => {
      saveConfig(config);
      cb.onZoomChange();
    });
  fView
    .add(config, "outlines")
    .onChange(() => {
      saveConfig(config);
      cb.onTogglesChange();
    });
  fView
    .add(config, "shadows")
    .onChange(() => {
      saveConfig(config);
      cb.onTogglesChange();
    });
  fView
    .add(config, "showGrid")
    .name("show floor grid")
    .onChange(() => {
      saveConfig(config);
      cb.onTogglesChange();
    });

  const fRead = gui.addFolder("Derived (read-only)");
  for (const k of Object.keys(readout) as Array<keyof typeof readout>) {
    fRead.add(readout, k).disable();
  }

  fManual.open();
  fView.open();
  fRead.open();
  refreshReadout();

  return {
    gui,
    refreshReadout,
    destroy(): void {
      gui.destroy();
    }
  };
}
