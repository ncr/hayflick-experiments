import * as THREE from "three";
import type { RenderableAsset } from "./asset-contract";
import { createRenderableObject } from "./renderer";
import { createGround } from "./ground";
import { createBuilding, type BuildingHandles } from "./building";
import { createProps } from "./props";
import { createLightShafts } from "./light-shafts";
import { createDustMotes, createSmoke, createSteam } from "./particles";

const CHIMNEY_TOP = new THREE.Vector3(-2.2, 4.2, -0.2);
const PIPE_VENT = new THREE.Vector3(-2.9, 1.4, -0.5);

function hexFromCss(value: string): number {
  return parseInt(value.replace("#", ""), 16);
}

function stringOption(
  options: Record<string, unknown>,
  key: string,
  fallback: string
): string {
  const value = options[key];
  if (value === undefined) {
    return fallback;
  }

  if (typeof value !== "string" || value.trim().length === 0) {
    throw new Error(`Asset option "${key}" must be a non-empty string.`);
  }

  return value;
}

export const waystationAssets: readonly RenderableAsset[] = [
  {
    metadata: {
      id: "waystation.ground",
      label: "Roadside ground plane",
      kind: "scenery",
      creates: "object3d"
    },
    create() {
      return {
        renderable: createRenderableObject(createGround())
      };
    }
  },
  {
    metadata: {
      id: "waystation.building",
      label: "Cutaway waystation building",
      kind: "structure",
      creates: "object3d"
    },
    create() {
      const building = createBuilding();

      return {
        renderable: createRenderableObject(building.group),
        handle: building,
        configure(config) {
          const color = hexFromCss(config.windowGlow.color);
          for (const mesh of building.windowGlows) {
            const material = mesh.material as THREE.MeshBasicMaterial;
            material.opacity = config.windowGlow.opacity;
            material.color.set(color);
          }
        }
      };
    }
  },
  {
    metadata: {
      id: "waystation.props",
      label: "Waystation props",
      kind: "prop-set",
      creates: "object3d"
    },
    create({ config }) {
      const props = createProps();
      const lamp = props.lamp;
      let currentConfig = config;
      lamp.baseEmissive = config.lamp.baseIntensity;

      return {
        renderable: createRenderableObject(props.group),
        handle: props,
        configure(nextConfig) {
          currentConfig = nextConfig;
          lamp.baseEmissive = nextConfig.lamp.baseIntensity;
        },
        systems: [
          (world) => {
            const flickerAmount = currentConfig.lamp.flickerAmount;
            const hz = currentConfig.lamp.flickerHz;
            const elapsed = world.time.t;
            const wobble =
              Math.sin(elapsed * hz * 2 * Math.PI) * 0.7 +
              Math.sin(elapsed * 23.7) * 0.18 +
              Math.sin(elapsed * 11.3) * 0.12;
            const factor = 1 + wobble * flickerAmount;
            const intensity = Math.max(0, lamp.baseEmissive * factor);
            lamp.bulbMaterial.emissiveIntensity = intensity;
            lamp.bulbLight.intensity = intensity;
          }
        ]
      };
    }
  },
  {
    metadata: {
      id: "waystation.light-shafts",
      label: "Window and roof light shafts",
      kind: "effect",
      creates: "object3d",
      defaults: { building: "building" },
      requires: ["building"]
    },
    create({ options, renderer, requireHandle }) {
      const buildingId = stringOption(options, "building", "building");
      const building = requireHandle<BuildingHandles>(buildingId);
      const shafts = createLightShafts(building);

      return {
        renderable: createRenderableObject(shafts.group),
        handle: shafts,
        configure(config) {
          const color = new THREE.Color(hexFromCss(config.shafts.color));
          for (const material of shafts.materials) {
            material.uniforms.uColor.value.copy(color);
            material.uniforms.uIntensity.value = config.shafts.intensity;
            material.uniforms.uFalloff.value = config.shafts.falloff;
          }
        },
        systems: [
          () => {
            renderer.faceCamera((camera) => shafts.aimAtCamera(camera));
          }
        ]
      };
    }
  },
  {
    metadata: {
      id: "waystation.dust",
      label: "Interior dust motes",
      kind: "effect",
      creates: "object3d"
    },
    create({ config }) {
      const dust = createDustMotes();
      dust.material.opacity = config.dust.opacity;
      dust.material.size = config.dust.size;

      return {
        renderable: createRenderableObject(dust.points),
        handle: dust,
        configure(nextConfig) {
          dust.material.opacity = nextConfig.dust.opacity;
          dust.material.size = nextConfig.dust.size;
        },
        systems: [(world) => dust.step(world.time.dt)]
      };
    }
  },
  {
    metadata: {
      id: "waystation.smoke",
      label: "Chimney smoke",
      kind: "effect",
      creates: "object3d"
    },
    create({ config }) {
      const smoke = createSmoke(CHIMNEY_TOP);
      smoke.material.opacity = config.smoke.opacity;
      smoke.material.size = config.smoke.size;

      return {
        renderable: createRenderableObject(smoke.points),
        handle: smoke,
        configure(nextConfig) {
          smoke.material.opacity = nextConfig.smoke.opacity;
          smoke.material.size = nextConfig.smoke.size;
        },
        systems: [(world) => smoke.step(world.time.dt)]
      };
    }
  },
  {
    metadata: {
      id: "waystation.steam",
      label: "Broken pipe steam",
      kind: "effect",
      creates: "object3d"
    },
    create({ config }) {
      const steam = createSteam(PIPE_VENT);
      steam.material.opacity = config.smoke.opacity * 0.8;
      steam.material.size = config.smoke.size * 0.7;

      return {
        renderable: createRenderableObject(steam.points),
        handle: steam,
        configure(nextConfig) {
          steam.material.opacity = nextConfig.smoke.opacity * 0.8;
          steam.material.size = nextConfig.smoke.size * 0.7;
        },
        systems: [(world) => steam.step(world.time.dt)]
      };
    }
  }
];
