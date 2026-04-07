import * as THREE from "three";
import { GLTFLoader } from "three/examples/jsm/loaders/GLTFLoader.js";
import { FXAAShader } from "three/examples/jsm/shaders/FXAAShader.js";
import { SMAAPass } from "three/examples/jsm/postprocessing/SMAAPass.js";
import { FullScreenQuad } from "three/examples/jsm/postprocessing/Pass.js";
import { PixelPerfectView } from "@common/render";
import { bindPixelPerfectViewInput } from "@common/input";
import type { ExperimentModule } from "../runtime/types";

/* ------------------------------------------------------------------ */
/* Props                                                               */
/* ------------------------------------------------------------------ */

type PropPlacement = {
  id: string;
  position: [number, number, number];
  rotationY?: number;
};

const PROPS: PropPlacement[] = [
  { id: "braun-inspired-desk", position: [0, 0, 0] },
  { id: "professional-workbench-chair", position: [-1.2, 0, 0.8], rotationY: Math.PI * 0.15 },
  { id: "tall-standing-lamp", position: [1.5, 0, -0.6] },
  { id: "ammo-crate", position: [-1.6, 0, -0.5], rotationY: Math.PI * 0.3 },
  { id: "microscope", position: [0.5, 0, 0.9] },
  { id: "chemical-flask", position: [-0.5, 0, -1.0] },
];

/* ------------------------------------------------------------------ */
/* Asset loading                                                       */
/* ------------------------------------------------------------------ */

async function loadPropGlb(propId: string): Promise<THREE.Group | null> {
  const url = `/api/forge/props/${encodeURIComponent(propId)}/processed-glb`;
  try {
    const res = await fetch(url);
    if (!res.ok) return null;
    const buffer = await res.arrayBuffer();
    const loader = new GLTFLoader();
    const gltf = await new Promise<{ scene: THREE.Group }>((resolve, reject) => {
      loader.parse(buffer, "", (result) => resolve(result), reject);
    });
    return gltf.scene;
  } catch {
    console.warn(`[prop-test-scene] Failed to load: ${propId}`);
    return null;
  }
}

/* ------------------------------------------------------------------ */
/* AA modes                                                            */
/* ------------------------------------------------------------------ */

type AAMode = "none" | "msaa" | "fxaa" | "smaa";
const AA_MODES: AAMode[] = ["none", "msaa", "fxaa", "smaa"];
const AA_LABELS: Record<AAMode, string> = {
  none: "No AA",
  msaa: "MSAA 4x",
  fxaa: "FXAA",
  smaa: "SMAA",
};

/* ------------------------------------------------------------------ */
/* Scene setup                                                         */
/* ------------------------------------------------------------------ */

function createLighting(scene: THREE.Scene): void {
  const ambient = new THREE.AmbientLight(0xffffff, 1.0);
  scene.add(ambient);

  const key = new THREE.DirectionalLight(0xfff4e0, 1.8);
  key.position.set(4, 8, 3);
  key.castShadow = true;
  key.shadow.mapSize.set(1024, 1024);
  key.shadow.camera.near = 0.5;
  key.shadow.camera.far = 30;
  key.shadow.camera.left = -5;
  key.shadow.camera.right = 5;
  key.shadow.camera.top = 5;
  key.shadow.camera.bottom = -5;
  key.shadow.bias = -0.002;
  scene.add(key);

  const fill = new THREE.DirectionalLight(0xb0c4de, 0.65);
  fill.position.set(-3, 4, -2);
  scene.add(fill);

  const hemi = new THREE.HemisphereLight(0xe8edf5, 0x8a8070, 0.6);
  scene.add(hemi);
}

function createGround(scene: THREE.Scene): void {
  const geo = new THREE.PlaneGeometry(12, 12);
  const mat = new THREE.MeshStandardMaterial({
    color: 0xb0ad9e,
    roughness: 0.92,
    metalness: 0.0,
  });
  const ground = new THREE.Mesh(geo, mat);
  ground.rotation.x = -Math.PI / 2;
  ground.receiveShadow = true;
  scene.add(ground);
}

/* ------------------------------------------------------------------ */
/* HUD overlay                                                         */
/* ------------------------------------------------------------------ */

function createHud(mount: HTMLElement): { el: HTMLDivElement; update: (mode: AAMode) => void } {
  const el = document.createElement("div");
  el.style.cssText =
    "position:absolute;top:8px;left:8px;padding:6px 10px;background:rgba(0,0,0,0.6);" +
    "color:#eee;font:12px/1.4 monospace;border-radius:4px;pointer-events:none;z-index:10;";
  mount.style.position = "relative";
  mount.appendChild(el);
  const update = (mode: AAMode) => {
    el.textContent = `AA: ${AA_LABELS[mode]}  [A] cycle`;
  };
  return { el, update };
}

/* ------------------------------------------------------------------ */
/* Experiment                                                          */
/* ------------------------------------------------------------------ */

const experiment: ExperimentModule = {
  id: "prop-test-scene",
  title: "Antialiasing Test",
  tags: ["threejs", "pixel-perfect", "isometric", "props"],
  init: ({ mount, width, height }) => {
    const scene = new THREE.Scene();
    scene.background = new THREE.Color(0x2a2e38);

    createLighting(scene);
    createGround(scene);

    const view = new PixelPerfectView({
      mount,
      width,
      height,
      scene,
      fixedRenderHeight: 240,
      baseOrthoHeight: 3.0,
      cameraDistance: 20,
      cameraPitch: "iso-2to1",
      cameraYaw: Math.PI / 4,
      basePixelZoom: 1,
      zoomMin: 1,
      zoomMax: 8,
      zoomStep: 1,
      zoomAnimationRate: 12,
      zoomAnimationBurstRate: 24,
      zoomAnimationEpsilon: 0.01,
      rotationAnimationRate: 12,
      rotationAnimationEpsilon: 0.005,
      zoomBurstIdleMs: 300,
      outputOverscanLowPixels: 2,
      clearColor: 0x2a2e38,
    });

    view.renderer.shadowMap.enabled = true;
    view.renderer.shadowMap.type = THREE.PCFSoftShadowMap;
    view.renderer.toneMapping = THREE.ACESFilmicToneMapping;
    view.renderer.toneMappingExposure = 1.25;

    const unbindInput = bindPixelPerfectViewInput({ view });

    // Resize
    const resizeObserver = new ResizeObserver((entries) => {
      for (const entry of entries) {
        const { width: w, height: h } = entry.contentRect;
        if (w > 0 && h > 0) view.resize(w, h);
      }
    });
    resizeObserver.observe(mount);

    // --- AA infrastructure ---

    // FXAA: single full-screen pass
    const fxaaMaterial = new THREE.ShaderMaterial({
      uniforms: THREE.UniformsUtils.clone(FXAAShader.uniforms),
      vertexShader: FXAAShader.vertexShader,
      fragmentShader: FXAAShader.fragmentShader,
    });
    const fxaaQuad = new FullScreenQuad(fxaaMaterial);

    // FXAA output target (sized lazily)
    let fxaaTarget: THREE.WebGLRenderTarget | null = null;

    // SMAA: 3-pass setup with lookup textures (reuse Three.js SMAAPass)
    let smaaPass: SMAAPass | null = null;
    let smaaOutputTarget: THREE.WebGLRenderTarget | null = null;

    let currentMode: AAMode = "msaa";

    function ensureAATargets(w: number, h: number) {
      // FXAA target
      if (!fxaaTarget || fxaaTarget.width !== w || fxaaTarget.height !== h) {
        fxaaTarget?.dispose();
        fxaaTarget = new THREE.WebGLRenderTarget(w, h, {
          minFilter: THREE.NearestFilter,
          magFilter: THREE.NearestFilter,
          format: THREE.RGBAFormat,
          stencilBuffer: false,
        });
        fxaaTarget.texture.generateMipmaps = false;
      }

      // SMAA targets + pass
      if (!smaaPass || !smaaOutputTarget || smaaOutputTarget.width !== w || smaaOutputTarget.height !== h) {
        (smaaPass as SMAAPass | null)?.dispose?.();
        smaaOutputTarget?.dispose();
        smaaPass = new SMAAPass(w, h);
        smaaOutputTarget = new THREE.WebGLRenderTarget(w, h, {
          minFilter: THREE.NearestFilter,
          magFilter: THREE.NearestFilter,
          format: THREE.RGBAFormat,
          stencilBuffer: false,
        });
        smaaOutputTarget.texture.generateMipmaps = false;
      }
    }

    function ensureLowTargetSamples(samples: number) {
      const lt = view.getLowTarget();
      if ((lt as { samples?: number }).samples === samples) return;
      const fresh = new THREE.WebGLRenderTarget(lt.width, lt.height, {
        minFilter: THREE.NearestFilter,
        magFilter: THREE.NearestFilter,
        format: THREE.RGBAFormat,
        stencilBuffer: false,
        ...(samples > 0 ? { samples } : {}),
      });
      fresh.texture.generateMipmaps = false;
      view.setLowTarget(fresh);
    }

    function activateMode(mode: AAMode) {
      currentMode = mode;

      // MSAA needs samples on the lowTarget; other modes need a plain target
      ensureLowTargetSamples(mode === "msaa" ? 4 : 0);

      if (mode === "fxaa") {
        view.afterSceneRender = (renderer, lowTarget) => {
          const w = lowTarget.width;
          const h = lowTarget.height;
          ensureAATargets(w, h);

          fxaaMaterial.uniforms["tDiffuse"].value = lowTarget.texture;
          fxaaMaterial.uniforms["resolution"].value.set(1 / w, 1 / h);

          renderer.setRenderTarget(fxaaTarget);
          fxaaQuad.render(renderer);

          view.setOutputSourceTexture(fxaaTarget!.texture);
        };
      } else if (mode === "smaa") {
        view.afterSceneRender = (renderer, lowTarget) => {
          const w = lowTarget.width;
          const h = lowTarget.height;
          ensureAATargets(w, h);

          smaaPass!.render(renderer, smaaOutputTarget!, lowTarget, 0, false);

          view.setOutputSourceTexture(smaaOutputTarget!.texture);
        };
      } else {
        // "none" or "msaa" — no post-process needed
        view.afterSceneRender = null;
        view.setOutputSourceTexture(null);
      }
    }

    // HUD
    const hud = createHud(mount);
    hud.update(currentMode);

    // Keyboard: A cycles AA mode
    const onKeyDown = (e: KeyboardEvent) => {
      if (e.code === "KeyA" && !e.ctrlKey && !e.metaKey && !e.altKey) {
        const idx = AA_MODES.indexOf(currentMode);
        const next = AA_MODES[(idx + 1) % AA_MODES.length];
        activateMode(next);
        hud.update(next);
        e.preventDefault();
      }
    };
    window.addEventListener("keydown", onKeyDown);

    // Load props
    const loadedGroups: THREE.Group[] = [];
    void Promise.all(
      PROPS.map(async (placement) => {
        const group = await loadPropGlb(placement.id);
        if (!group) return;
        group.position.set(...placement.position);
        if (placement.rotationY) group.rotation.y = placement.rotationY;
        group.traverse((child) => {
          if (child instanceof THREE.Mesh) {
            child.castShadow = true;
            child.receiveShadow = true;
          }
        });
        scene.add(group);
        loadedGroups.push(group);
      })
    );

    // Animation loop
    let raf = 0;
    let prevTime = performance.now();
    const animate = () => {
      raf = requestAnimationFrame(animate);
      const now = performance.now();
      const dt = Math.min((now - prevTime) / 1000, 0.1);
      prevTime = now;
      view.frame(now, dt);
    };
    animate();

    return () => {
      cancelAnimationFrame(raf);
      resizeObserver.disconnect();
      unbindInput();
      window.removeEventListener("keydown", onKeyDown);
      hud.el.remove();
      for (const group of loadedGroups) scene.remove(group);
      fxaaTarget?.dispose();
      fxaaQuad.dispose();
      fxaaMaterial.dispose();
      smaaOutputTarget?.dispose();
      (smaaPass as SMAAPass | null)?.dispose?.();
      view.dispose();
    };
  },
};

export default experiment;
