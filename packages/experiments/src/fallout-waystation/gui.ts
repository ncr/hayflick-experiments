import GUI from "lil-gui";
import { PALETTE } from "./palette";

// Persisted scene config + lil-gui wiring. The config schema is the single
// source of truth — the GUI is just a view onto it. On every change we
// invoke `apply` (so the live scene reflects the new value) and
// `persist` (so a reload picks up where we left off).
//
// LocalStorage-keyed; bump the suffix when the schema changes incompatibly.

const STORAGE_KEY = "fallout-waystation-config-v1";

export type SceneConfig = {
  sun: {
    azimuthDeg: number;
    elevationDeg: number;
    intensity: number;
    color: string;
    shadows: boolean;
  };
  ambient: { intensity: number };
  hemisphere: { intensity: number; sky: string; ground: string };
  fill: { intensity: number; color: string };
  fog: {
    enabled: boolean;
    color: string;
    density: number;
    heightFloor: number;
    heightScale: number;
  };
  shafts: { intensity: number; color: string; falloff: number };
  ao: {
    floorStrength: number;
    floorRadius: number;
    groundStrength: number;
    groundRadius: number;
    edgeStrength: number;
    edgeFraction: number;
  };
  dust: { opacity: number; size: number };
  smoke: { opacity: number; size: number };
  lamp: { baseIntensity: number; flickerAmount: number; flickerHz: number };
  windowGlow: { opacity: number; color: string };
  background: string;
};

const c = (n: number): string =>
  "#" + n.toString(16).padStart(6, "0").toUpperCase();

export const DEFAULT_CONFIG: SceneConfig = {
  sun: {
    azimuthDeg: 55,
    elevationDeg: 36,
    intensity: 1.9,
    color: c(0xffe2b0),
    shadows: true
  },
  ambient: { intensity: 0.5 },
  hemisphere: {
    intensity: 0.7,
    sky: c(0x8aa0b8),
    ground: c(0x6a4e30)
  },
  fill: { intensity: 0.3, color: c(0x9ab2cc) },
  fog: {
    enabled: true,
    color: c(PALETTE.fog),
    density: 0.022,
    heightFloor: 0.0,
    heightScale: 0.7
  },
  shafts: { intensity: 0.7, color: c(PALETTE.shaftColor), falloff: 1.4 },
  ao: {
    floorStrength: 0.65,
    floorRadius: 0.4,
    groundStrength: 0.45,
    groundRadius: 0.5,
    edgeStrength: 0.22,
    edgeFraction: 0.18
  },
  dust: { opacity: 0.55, size: 0.04 },
  smoke: { opacity: 0.5, size: 0.16 },
  lamp: { baseIntensity: 1.4, flickerAmount: 0.3, flickerHz: 7 },
  windowGlow: { opacity: 0.0, color: c(PALETTE.glassWarm) },
  background: c(PALETTE.sky)
};

function deepMerge<T>(base: T, patch: Partial<T>): T {
  if (typeof base !== "object" || base === null) return patch as T;
  const out: Record<string, unknown> = { ...(base as Record<string, unknown>) };
  for (const k of Object.keys(patch ?? {})) {
    const bv = (base as Record<string, unknown>)[k];
    const pv = (patch as Record<string, unknown>)[k];
    if (
      bv &&
      typeof bv === "object" &&
      !Array.isArray(bv) &&
      pv &&
      typeof pv === "object"
    ) {
      out[k] = deepMerge(bv, pv as Partial<typeof bv>);
    } else if (pv !== undefined) {
      out[k] = pv;
    }
  }
  return out as T;
}

export function loadConfig(): SceneConfig {
  try {
    const raw = window.localStorage.getItem(STORAGE_KEY);
    if (!raw) return DEFAULT_CONFIG;
    const parsed = JSON.parse(raw) as Partial<SceneConfig>;
    return deepMerge(DEFAULT_CONFIG, parsed);
  } catch {
    return DEFAULT_CONFIG;
  }
}

export function saveConfig(config: SceneConfig): void {
  try {
    window.localStorage.setItem(STORAGE_KEY, JSON.stringify(config));
  } catch {
    // localStorage might be disabled — silently ignore.
  }
}

export type GuiCallbacks = {
  onSunChange(): void;
  onAmbientChange(): void;
  onHemisphereChange(): void;
  onFillChange(): void;
  onFogChange(): void;
  onShaftChange(): void;
  onAOChange(): void;
  onDustChange(): void;
  onSmokeChange(): void;
  onLampChange(): void;
  onWindowGlowChange(): void;
  onBackgroundChange(): void;
  onResetDefaults(): void;
};

export type GuiHandle = {
  gui: GUI;
  destroy(): void;
};

export function buildGui(
  config: SceneConfig,
  cb: GuiCallbacks,
  parent?: HTMLElement
): GuiHandle {
  const gui = new GUI({ title: "Waystation Atmosphere", container: parent });

  const onAny = (notify: () => void): (() => void) => () => {
    notify();
    saveConfig(config);
  };

  const fSun = gui.addFolder("Sun");
  fSun.add(config.sun, "azimuthDeg", 0, 360, 1).name("azimuth °").onChange(onAny(cb.onSunChange));
  fSun.add(config.sun, "elevationDeg", 5, 85, 1).name("elevation °").onChange(onAny(cb.onSunChange));
  fSun.add(config.sun, "intensity", 0, 4, 0.05).onChange(onAny(cb.onSunChange));
  fSun.addColor(config.sun, "color").onChange(onAny(cb.onSunChange));
  fSun.add(config.sun, "shadows").onChange(onAny(cb.onSunChange));

  const fAmb = gui.addFolder("Ambient");
  fAmb.add(config.ambient, "intensity", 0, 2, 0.02).onChange(onAny(cb.onAmbientChange));

  const fHemi = gui.addFolder("Hemisphere");
  fHemi.add(config.hemisphere, "intensity", 0, 2, 0.02).onChange(onAny(cb.onHemisphereChange));
  fHemi.addColor(config.hemisphere, "sky").onChange(onAny(cb.onHemisphereChange));
  fHemi.addColor(config.hemisphere, "ground").onChange(onAny(cb.onHemisphereChange));

  const fFill = gui.addFolder("Fill light");
  fFill.add(config.fill, "intensity", 0, 1.5, 0.02).onChange(onAny(cb.onFillChange));
  fFill.addColor(config.fill, "color").onChange(onAny(cb.onFillChange));

  const fFog = gui.addFolder("Fog (height-falloff)");
  fFog.add(config.fog, "enabled").onChange(onAny(cb.onFogChange));
  fFog.addColor(config.fog, "color").onChange(onAny(cb.onFogChange));
  fFog.add(config.fog, "density", 0, 0.3, 0.002).onChange(onAny(cb.onFogChange));
  fFog.add(config.fog, "heightFloor", -2, 4, 0.05).name("floor Y").onChange(onAny(cb.onFogChange));
  fFog.add(config.fog, "heightScale", 0, 3, 0.02).name("Y falloff").onChange(onAny(cb.onFogChange));

  const fShafts = gui.addFolder("God rays");
  fShafts.add(config.shafts, "intensity", 0, 2, 0.02).onChange(onAny(cb.onShaftChange));
  fShafts.addColor(config.shafts, "color").onChange(onAny(cb.onShaftChange));
  fShafts.add(config.shafts, "falloff", 0.3, 3, 0.05).onChange(onAny(cb.onShaftChange));

  const fAO = gui.addFolder("Ambient occlusion");
  fAO.add(config.ao, "floorStrength", 0, 1, 0.02).name("floor strength").onChange(onAny(cb.onAOChange));
  fAO.add(config.ao, "floorRadius", 0.05, 1.5, 0.02).name("floor radius").onChange(onAny(cb.onAOChange));
  fAO.add(config.ao, "groundStrength", 0, 1, 0.02).name("ground strength").onChange(onAny(cb.onAOChange));
  fAO.add(config.ao, "groundRadius", 0.05, 1.5, 0.02).name("ground radius").onChange(onAny(cb.onAOChange));
  fAO.add(config.ao, "edgeStrength", 0, 0.6, 0.01).name("box edge strength").onChange(onAny(cb.onAOChange));
  fAO.add(config.ao, "edgeFraction", 0.02, 0.5, 0.01).name("box edge fraction").onChange(onAny(cb.onAOChange));

  const fDust = gui.addFolder("Dust");
  fDust.add(config.dust, "opacity", 0, 1, 0.02).onChange(onAny(cb.onDustChange));
  fDust.add(config.dust, "size", 0.005, 0.2, 0.005).onChange(onAny(cb.onDustChange));

  const fSmoke = gui.addFolder("Smoke / Steam");
  fSmoke.add(config.smoke, "opacity", 0, 1, 0.02).onChange(onAny(cb.onSmokeChange));
  fSmoke.add(config.smoke, "size", 0.02, 0.5, 0.01).onChange(onAny(cb.onSmokeChange));

  const fLamp = gui.addFolder("Lamp");
  fLamp.add(config.lamp, "baseIntensity", 0, 4, 0.05).onChange(onAny(cb.onLampChange));
  fLamp.add(config.lamp, "flickerAmount", 0, 1, 0.02).onChange(onAny(cb.onLampChange));
  fLamp.add(config.lamp, "flickerHz", 0, 30, 0.5).onChange(onAny(cb.onLampChange));

  const fWindow = gui.addFolder("Window glow");
  fWindow.add(config.windowGlow, "opacity", 0, 1, 0.02).onChange(onAny(cb.onWindowGlowChange));
  fWindow.addColor(config.windowGlow, "color").onChange(onAny(cb.onWindowGlowChange));

  const fScene = gui.addFolder("Scene");
  fScene.addColor(config, "background").onChange(onAny(cb.onBackgroundChange));

  const actions = {
    reset: () => {
      const fresh = JSON.parse(JSON.stringify(DEFAULT_CONFIG)) as SceneConfig;
      Object.assign(config.sun, fresh.sun);
      Object.assign(config.ambient, fresh.ambient);
      Object.assign(config.hemisphere, fresh.hemisphere);
      Object.assign(config.fill, fresh.fill);
      Object.assign(config.fog, fresh.fog);
      Object.assign(config.shafts, fresh.shafts);
      Object.assign(config.ao, fresh.ao);
      Object.assign(config.dust, fresh.dust);
      Object.assign(config.smoke, fresh.smoke);
      Object.assign(config.lamp, fresh.lamp);
      Object.assign(config.windowGlow, fresh.windowGlow);
      config.background = fresh.background;
      gui.controllersRecursive().forEach((c) => c.updateDisplay());
      cb.onResetDefaults();
      saveConfig(config);
    }
  };
  gui.add(actions, "reset").name("Reset to defaults");

  fSun.open();
  fFog.open();
  fShafts.close();
  fDust.close();
  fSmoke.close();
  fLamp.close();
  fWindow.close();
  fAmb.close();
  fHemi.close();
  fFill.close();
  fScene.close();

  return {
    gui,
    destroy(): void {
      gui.destroy();
    }
  };
}
