import * as THREE from "three";
import { IsoGameView } from "@common/render";
import { bindIsoGameViewInput } from "@common/input";
import type { ExperimentModule } from "../runtime/types";
import { PALETTE } from "./palette";
import { createGround } from "./ground";
import { createBuilding, INVISIBLE_LAYER, type BuildingHandles } from "./building";
import { createProps, type LampHandle } from "./props";
import { createLightShafts, type ShaftHandle } from "./light-shafts";
import {
  createDustMotes,
  createSmoke,
  createSteam,
  type ParticleField
} from "./particles";
import {
  buildGui,
  loadConfig,
  type SceneConfig,
  type GuiHandle
} from "./gui";
import { fogHeightUniforms } from "./fog";
import {
  aoFloorUniforms,
  aoGroundUniforms,
  aoBoxEdgeUniforms
} from "./ao-patch";

const CHIMNEY_TOP = new THREE.Vector3(-2.2, 4.2, -0.2);
const PIPE_VENT = new THREE.Vector3(-2.9, 1.4, -0.5);

function hexFromCss(s: string): number {
  return parseInt(s.replace("#", ""), 16);
}

function azElToDirection(azDeg: number, elDeg: number): THREE.Vector3 {
  const az = THREE.MathUtils.degToRad(azDeg);
  const el = THREE.MathUtils.degToRad(elDeg);
  return new THREE.Vector3(
    Math.cos(el) * Math.cos(az),
    Math.sin(el),
    Math.cos(el) * Math.sin(az)
  );
}

const experiment: ExperimentModule = {
  id: "fallout-waystation",
  title: "Fallout Waystation",
  tags: ["threejs", "pixel-perfect", "iso", "lighting", "atmosphere"],
  init: async ({ mount, width, height }) => {
    const config = loadConfig();
    const scene = new THREE.Scene();
    scene.background = new THREE.Color(hexFromCss(config.background));

    // Fog: Exp²-like haze. Keeps distant ground readable as a foreground
    // element rather than a hard cut against the background color.
    if (config.fog.enabled) {
      scene.fog = new THREE.FogExp2(
        hexFromCss(config.fog.color),
        config.fog.density
      );
    }

    const view = new IsoGameView({
      mount,
      width,
      height,
      scene,
      basePixelZoom: 2,
      clearColor: hexFromCss(config.background),
      shadows: true,
      lighting: {
        ambient: config.ambient.intensity,
        keyColor: hexFromCss(config.sun.color),
        keyIntensity: config.sun.intensity,
        keyDirection: azElToDirection(
          config.sun.azimuthDeg,
          config.sun.elevationDeg
        ).multiplyScalar(12).toArray() as [number, number, number],
        fillColor: hexFromCss(config.fill.color),
        fillIntensity: config.fill.intensity,
        hemisphere: {
          skyColor: hexFromCss(config.hemisphere.sky),
          groundColor: hexFromCss(config.hemisphere.ground),
          intensity: config.hemisphere.intensity
        },
        shadows: config.sun.shadows
      },
      outlines: {
        // Soften the brighten-on-edges effect so outlines read as a hint
        // rather than a wireframe over fog-shaded fills.
        outlineBrightness: 1.18,
        outlineMix: 0.7
      }
    });

    // Hard pixel-snapped shadows. PCF softens edges in a way that fights
    // the integer upscale; BasicShadowMap keeps shadow boundaries crisp on
    // the low-res grid.
    view.renderer.shadowMap.type = THREE.BasicShadowMap;

    const lighting = view.lighting!;
    const sun = lighting.key;
    sun.castShadow = config.sun.shadows;
    sun.shadow.mapSize.set(1024, 1024);
    sun.shadow.camera.left = -10;
    sun.shadow.camera.right = 10;
    sun.shadow.camera.top = 10;
    sun.shadow.camera.bottom = -10;
    sun.shadow.camera.near = 0.1;
    sun.shadow.camera.far = 40;
    sun.shadow.bias = -0.0005;
    sun.shadow.normalBias = 0.04;
    sun.shadow.camera.updateProjectionMatrix();
    // Enable layer 1 on the sun so invisible walls/roof contribute to the
    // shadow map even though the camera doesn't render them.
    sun.layers.enable(INVISIBLE_LAYER);

    // Ground.
    const ground = createGround();
    scene.add(ground);

    // Building.
    const building: BuildingHandles = createBuilding();
    scene.add(building.group);

    // Props (lamp / chimney / pipe / crates / door).
    const { group: propsGroup, lamp } = createProps();
    scene.add(propsGroup);
    const lampHandle: LampHandle = lamp;

    // Light shafts (additive god-ray geometry). Per-frame `aimAtCamera`
    // keeps each shaft's plane facing the iso camera.
    const shafts: ShaftHandle = createLightShafts(building);
    scene.add(shafts.group);
    shafts.aimAtCamera(view.camera);

    // Particles.
    const dust: ParticleField = createDustMotes();
    scene.add(dust.points);
    const smoke: ParticleField = createSmoke(CHIMNEY_TOP);
    scene.add(smoke.points);
    const steam: ParticleField = createSteam(PIPE_VENT);
    scene.add(steam.points);

    const applyShafts = (): void => {
      const color = new THREE.Color(hexFromCss(config.shafts.color));
      for (const m of shafts.materials) {
        (m.uniforms.uColor.value as THREE.Color).copy(color);
        m.uniforms.uIntensity.value = config.shafts.intensity;
        m.uniforms.uFalloff.value = config.shafts.falloff;
      }
    };
    applyShafts();

    const applySun = (): void => {
      const dir = azElToDirection(
        config.sun.azimuthDeg,
        config.sun.elevationDeg
      ).multiplyScalar(12);
      sun.position.copy(dir);
      sun.lookAt(0, 0, 0);
      sun.intensity = config.sun.intensity;
      sun.color.set(hexFromCss(config.sun.color));
      sun.castShadow = config.sun.shadows;
    };
    applySun();

    const applyAmbient = (): void => {
      lighting.ambient.intensity = config.ambient.intensity;
    };

    const applyHemisphere = (): void => {
      if (lighting.hemisphere) {
        lighting.hemisphere.intensity = config.hemisphere.intensity;
        lighting.hemisphere.color.set(hexFromCss(config.hemisphere.sky));
        lighting.hemisphere.groundColor.set(
          hexFromCss(config.hemisphere.ground)
        );
      }
    };

    const applyFill = (): void => {
      lighting.fill.intensity = config.fill.intensity;
      lighting.fill.color.set(hexFromCss(config.fill.color));
    };

    const applyFog = (): void => {
      if (config.fog.enabled) {
        const color = hexFromCss(config.fog.color);
        if (scene.fog instanceof THREE.FogExp2) {
          scene.fog.color.set(color);
          scene.fog.density = config.fog.density;
        } else {
          scene.fog = new THREE.FogExp2(color, config.fog.density);
        }
      } else {
        scene.fog = null;
      }
      fogHeightUniforms.fogHeightFloor.value = config.fog.heightFloor;
      fogHeightUniforms.fogHeightScale.value = config.fog.heightScale;
    };
    applyFog();

    const applyAO = (): void => {
      aoFloorUniforms.aoStrength.value = config.ao.floorStrength;
      aoFloorUniforms.aoRadius.value = config.ao.floorRadius;
      aoGroundUniforms.aoStrength.value = config.ao.groundStrength;
      aoGroundUniforms.aoRadius.value = config.ao.groundRadius;
      aoBoxEdgeUniforms.boxEdgeStrength.value = config.ao.edgeStrength;
      aoBoxEdgeUniforms.boxEdgeFraction.value = config.ao.edgeFraction;
    };
    applyAO();

    const applyDust = (): void => {
      dust.material.opacity = config.dust.opacity;
      dust.material.size = config.dust.size;
    };

    const applySmoke = (): void => {
      smoke.material.opacity = config.smoke.opacity;
      smoke.material.size = config.smoke.size;
      steam.material.opacity = config.smoke.opacity * 0.8;
      steam.material.size = config.smoke.size * 0.7;
    };

    const applyLamp = (): void => {
      lampHandle.baseEmissive = config.lamp.baseIntensity;
    };

    const applyWindowGlow = (): void => {
      const color = hexFromCss(config.windowGlow.color);
      for (const m of building.windowGlows) {
        const mat = m.material as THREE.MeshBasicMaterial;
        mat.opacity = config.windowGlow.opacity;
        mat.color.set(color);
      }
    };

    const applyBackground = (): void => {
      const color = hexFromCss(config.background);
      (scene.background as THREE.Color).set(color);
    };

    // Wire the GUI.
    const gui: GuiHandle = buildGui(config, {
      onSunChange: applySun,
      onAmbientChange: applyAmbient,
      onHemisphereChange: applyHemisphere,
      onFillChange: applyFill,
      onFogChange: applyFog,
      onShaftChange: applyShafts,
      onAOChange: applyAO,
      onDustChange: applyDust,
      onSmokeChange: applySmoke,
      onLampChange: applyLamp,
      onWindowGlowChange: applyWindowGlow,
      onBackgroundChange: applyBackground,
      onResetDefaults: () => {
        applySun();
        applyAmbient();
        applyHemisphere();
        applyFill();
        applyFog();
        applyShafts();
        applyAO();
        applyDust();
        applySmoke();
        applyLamp();
        applyWindowGlow();
        applyBackground();
      }
    });

    // Apply once so the loaded config is reflected before the first frame.
    applyDust();
    applySmoke();
    applyWindowGlow();

    const unbindInput = bindIsoGameViewInput({ view });

    const observer = new ResizeObserver((entries) => {
      for (const e of entries) {
        if (e.contentRect.width > 0 && e.contentRect.height > 0) {
          view.resize(e.contentRect.width, e.contentRect.height);
        }
      }
    });
    observer.observe(mount);

    let raf = 0;
    let prev = performance.now();
    const tStart = prev;
    const tick = (): void => {
      raf = requestAnimationFrame(tick);
      const now = performance.now();
      const dt = Math.min((now - prev) / 1000, 0.1);
      prev = now;
      const elapsed = (now - tStart) / 1000;

      // Lamp flicker — sin + small chaotic perturbation.
      const f = config.lamp.flickerAmount;
      const hz = config.lamp.flickerHz;
      const wobble =
        Math.sin(elapsed * hz * 2 * Math.PI) * 0.7 +
        Math.sin(elapsed * 23.7) * 0.18 +
        Math.sin(elapsed * 11.3) * 0.12;
      const factor = 1 + wobble * f;
      const intensity = Math.max(0, lampHandle.baseEmissive * factor);
      lampHandle.bulbMaterial.emissiveIntensity = intensity;
      lampHandle.bulbLight.intensity = intensity;

      dust.step(dt);
      smoke.step(dt);
      steam.step(dt);

      shafts.aimAtCamera(view.camera);

      view.frame(now, dt);
    };
    tick();

    // Suppress the no-lights dev warning for our scene; the lighting
    // preset adds them. Use the palette to silence "unused" lints.
    void PALETTE;

    return () => {
      cancelAnimationFrame(raf);
      observer.disconnect();
      unbindInput();
      gui.destroy();
      scene.remove(ground);
      scene.remove(building.group);
      scene.remove(propsGroup);
      scene.remove(shafts.group);
      scene.remove(dust.points);
      scene.remove(smoke.points);
      scene.remove(steam.points);
      view.dispose();
    };
  }
};

export default experiment;
