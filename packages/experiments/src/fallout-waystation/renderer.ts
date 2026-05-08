import * as THREE from "three";
import { IsoGameView } from "@common/render";
import { bindIsoGameViewInput } from "@common/input";
import { INVISIBLE_LAYER } from "./building";
import type { SceneConfig } from "./gui";

export type RenderableObject = {
  readonly node: THREE.Object3D;
  dispose(): void;
};

export type WaystationRendererOptions = {
  mount: HTMLElement;
  width: number;
  height: number;
  config: SceneConfig;
};

function hexFromCss(value: string): number {
  return parseInt(value.replace("#", ""), 16);
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

function disposeMaterial(material: THREE.Material | THREE.Material[]): void {
  if (Array.isArray(material)) {
    for (const entry of material) {
      entry.dispose();
    }
    return;
  }

  material.dispose();
}

function disposeObject(node: THREE.Object3D): void {
  node.traverse((child) => {
    if (child instanceof THREE.Mesh || child instanceof THREE.Points) {
      child.geometry.dispose();
      disposeMaterial(child.material);
    }
  });
}

export function createRenderableObject(node: THREE.Object3D): RenderableObject {
  return {
    node,
    dispose() {
      disposeObject(node);
    }
  };
}

export class WaystationRenderer {
  private readonly scene: THREE.Scene;
  private readonly view: IsoGameView;
  private readonly lighting: NonNullable<IsoGameView["lighting"]>;

  constructor(options: WaystationRendererOptions) {
    this.scene = new THREE.Scene();
    this.scene.background = new THREE.Color(hexFromCss(options.config.background));

    this.view = new IsoGameView({
      mount: options.mount,
      width: options.width,
      height: options.height,
      scene: this.scene,
      basePixelZoom: 2,
      clearColor: hexFromCss(options.config.background),
      shadows: true,
      lighting: {
        ambient: options.config.ambient.intensity,
        keyColor: hexFromCss(options.config.sun.color),
        keyIntensity: options.config.sun.intensity,
        keyDirection: azElToDirection(
          options.config.sun.azimuthDeg,
          options.config.sun.elevationDeg
        ).multiplyScalar(12).toArray() as [number, number, number],
        fillColor: hexFromCss(options.config.fill.color),
        fillIntensity: options.config.fill.intensity,
        hemisphere: {
          skyColor: hexFromCss(options.config.hemisphere.sky),
          groundColor: hexFromCss(options.config.hemisphere.ground),
          intensity: options.config.hemisphere.intensity
        },
        shadows: options.config.sun.shadows
      },
      outlines: {
        outlineBrightness: 1.18,
        outlineMix: 0.7
      }
    });

    if (!this.view.lighting) {
      throw new Error("Waystation renderer expected IsoGameView lighting to be enabled.");
    }

    this.lighting = this.view.lighting;
    this.configureShadowMap();
    this.applyConfig(options.config);
  }

  addObject(object: RenderableObject): void {
    this.scene.add(object.node);
  }

  removeObject(object: RenderableObject): void {
    this.scene.remove(object.node);
  }

  faceCamera(aim: (camera: THREE.Camera) => void): void {
    aim(this.view.camera);
  }

  bindInput(): () => void {
    return bindIsoGameViewInput({ view: this.view });
  }

  resize(width: number, height: number): void {
    this.view.resize(width, height);
  }

  frame(nowMs: number, deltaSeconds: number): void {
    this.view.frame(nowMs, deltaSeconds);
  }

  applyConfig(config: SceneConfig): void {
    this.applySun(config);
    this.applyAmbient(config);
    this.applyHemisphere(config);
    this.applyFill(config);
    this.applyFog(config);
    this.applyBackground(config);
  }

  dispose(): void {
    this.view.dispose();
  }

  private configureShadowMap(): void {
    this.view.renderer.shadowMap.type = THREE.BasicShadowMap;

    const sun = this.lighting.key;
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
    sun.layers.enable(INVISIBLE_LAYER);
  }

  private applySun(config: SceneConfig): void {
    const sun = this.lighting.key;
    const dir = azElToDirection(config.sun.azimuthDeg, config.sun.elevationDeg).multiplyScalar(12);
    sun.position.copy(dir);
    sun.lookAt(0, 0, 0);
    sun.intensity = config.sun.intensity;
    sun.color.set(hexFromCss(config.sun.color));
    sun.castShadow = config.sun.shadows;
  }

  private applyAmbient(config: SceneConfig): void {
    this.lighting.ambient.intensity = config.ambient.intensity;
  }

  private applyHemisphere(config: SceneConfig): void {
    if (!this.lighting.hemisphere) {
      return;
    }

    this.lighting.hemisphere.intensity = config.hemisphere.intensity;
    this.lighting.hemisphere.color.set(hexFromCss(config.hemisphere.sky));
    this.lighting.hemisphere.groundColor.set(hexFromCss(config.hemisphere.ground));
  }

  private applyFill(config: SceneConfig): void {
    this.lighting.fill.intensity = config.fill.intensity;
    this.lighting.fill.color.set(hexFromCss(config.fill.color));
  }

  private applyFog(config: SceneConfig): void {
    if (config.fog.enabled) {
      const color = hexFromCss(config.fog.color);
      if (this.scene.fog instanceof THREE.FogExp2) {
        this.scene.fog.color.set(color);
        this.scene.fog.density = config.fog.density;
      } else {
        this.scene.fog = new THREE.FogExp2(color, config.fog.density);
      }
    } else {
      this.scene.fog = null;
    }
  }

  private applyBackground(config: SceneConfig): void {
    const color = hexFromCss(config.background);
    if (this.scene.background instanceof THREE.Color) {
      this.scene.background.set(color);
    } else {
      this.scene.background = new THREE.Color(color);
    }
  }
}
