import * as THREE from "three";
// three-gpu-pathtracer 0.0.23 — pinned because >=0.0.24 peers three>=0.180 and
// this repo is locked to three 0.173 by the pixel-perfect render contract.
import { WebGLPathTracer, GradientEquirectTexture } from "three-gpu-pathtracer";
import type { ExperimentModule, ExperimentContext } from "@experiments/runtime";

import { orbitPosition, spinRotation } from "./scene-motion";

/* ------------------------------------------------------------------ */
/* Config                                                              */
/* ------------------------------------------------------------------ */

// Internal render resolutions. The middle one (~480x270) is a realistic
// internal size for this project's pixel-perfect iso renderer; the others
// bracket it so the cost/resolution curve is visible.
const RESOLUTIONS: ReadonlyArray<{ w: number; h: number; label: string }> = [
  { w: 240, h: 135, label: "240×135" },
  { w: 480, h: 270, label: "480×270" },
  { w: 960, h: 540, label: "960×540" }
];

const OBJECT_COUNTS = [8, 32, 128] as const;

type ProbeStats = {
  ready: boolean;
  paused: boolean;
  resolution: string;
  internalPixels: number;
  bounces: number;
  objectCount: number;
  /** Accumulated samples-per-pixel (resets to ~1 every frame while moving). */
  spp: number;
  /** Smoothed total frame time (ms) — the headline FPS number. */
  frameMs: number;
  fps: number;
  /** Synchronous CPU time spent rebuilding the BVH this frame (ms). */
  bvhMs: number;
  /** Center-pixel luminance 0..255 — used by e2e to prove non-blank output. */
  centerLuma: number;
};

declare global {
  interface Window {
    __pathtraceProbe?: {
      getStats(): ProbeStats;
      setResolution(index: number): void;
      cycleResolution(): void;
      setBounces(n: number): void;
      setObjectCount(n: number): void;
      setPaused(p: boolean): void;
      togglePaused(): void;
    };
  }
}

/* ------------------------------------------------------------------ */
/* Scene                                                               */
/* ------------------------------------------------------------------ */

type Dynamic = { mesh: THREE.Mesh; index: number };

function makeEnvironment(): GradientEquirectTexture {
  const env = new GradientEquirectTexture(2048);
  env.topColor.set(0x99bbff);
  env.bottomColor.set(0x1a1a22);
  env.update();
  return env;
}

function buildScene(count: number): {
  scene: THREE.Scene;
  dynamics: Dynamic[];
} {
  const scene = new THREE.Scene();

  const env = makeEnvironment();
  scene.environment = env;
  scene.background = env;

  // Floor
  const floor = new THREE.Mesh(
    new THREE.BoxGeometry(20, 0.2, 20),
    new THREE.MeshStandardMaterial({ color: 0x6b6b70, roughness: 0.85, metalness: 0.0 })
  );
  floor.position.y = -0.1;
  scene.add(floor);

  // A bright emissive slab acting as an area light (path tracer treats
  // emissive surfaces as light sources).
  const lamp = new THREE.Mesh(
    new THREE.BoxGeometry(4, 0.1, 4),
    new THREE.MeshStandardMaterial({
      color: 0x000000,
      emissive: 0xfff0d0,
      emissiveIntensity: 14
    })
  );
  lamp.position.set(0, 6, 0);
  scene.add(lamp);

  const geos = [
    new THREE.BoxGeometry(0.6, 0.6, 0.6),
    new THREE.IcosahedronGeometry(0.4, 0),
    new THREE.CylinderGeometry(0.3, 0.3, 0.7, 12)
  ];

  const dynamics: Dynamic[] = [];
  for (let i = 0; i < count; i++) {
    const variant = i % 3;
    let material: THREE.MeshStandardMaterial;
    if (variant === 0) {
      material = new THREE.MeshStandardMaterial({
        color: 0xc94f3d,
        roughness: 0.5,
        metalness: 0.0
      });
    } else if (variant === 1) {
      material = new THREE.MeshStandardMaterial({
        color: 0xd9d9e0,
        roughness: 0.12,
        metalness: 1.0
      });
    } else {
      material = new THREE.MeshStandardMaterial({
        color: 0x3d7fc9,
        roughness: 0.3,
        metalness: 0.4
      });
    }
    const mesh = new THREE.Mesh(geos[i % geos.length], material);
    scene.add(mesh);
    dynamics.push({ mesh, index: i });
  }

  return { scene, dynamics };
}

function applyMotion(dynamics: Dynamic[], count: number, t: number): void {
  for (const d of dynamics) {
    const p = orbitPosition(d.index, count, t);
    d.mesh.position.set(p.x, p.y, p.z);
    const r = spinRotation(d.index, t);
    d.mesh.rotation.set(r.x, r.y, r.z);
    d.mesh.updateMatrixWorld(true);
  }
}

/* ------------------------------------------------------------------ */
/* HUD                                                                 */
/* ------------------------------------------------------------------ */

function buildHud(mount: HTMLElement): {
  el: HTMLDivElement;
  set(text: string): void;
  dispose(): void;
} {
  const el = document.createElement("div");
  el.style.cssText = [
    "position:absolute",
    "top:8px",
    "left:8px",
    "z-index:10",
    "font:12px/1.4 ui-monospace,Menlo,monospace",
    "color:#e6e6e6",
    "background:rgba(0,0,0,0.62)",
    "padding:10px 12px",
    "border-radius:6px",
    "white-space:pre",
    "pointer-events:none",
    "max-width:46ch"
  ].join(";");
  mount.appendChild(el);
  return {
    el,
    set: (text: string) => {
      el.textContent = text;
    },
    dispose: () => el.remove()
  };
}

/* ------------------------------------------------------------------ */
/* Module                                                              */
/* ------------------------------------------------------------------ */

const probe: ExperimentModule = {
  id: "pathtrace-probe",
  title: "Path-Trace Probe",
  tags: ["path-tracing", "spike"],

  init(ctx: ExperimentContext): () => void {
    const { mount } = ctx;
    mount.style.position = "relative";
    mount.style.background = "#0a0a0c";

    const canvas = document.createElement("canvas");
    canvas.style.cssText = [
      "position:absolute",
      "inset:0",
      "width:100%",
      "height:100%",
      "image-rendering:pixelated",
      "display:block"
    ].join(";");
    mount.appendChild(canvas);

    const renderer = new THREE.WebGLRenderer({ canvas, antialias: false });
    renderer.setPixelRatio(1);

    const camera = new THREE.PerspectiveCamera(45, 1, 0.05, 100);
    // Roughly the iso vantage: looking down at the floor from a corner.
    camera.position.set(6.5, 6.5, 6.5);
    camera.lookAt(0, 0.8, 0);

    let resolutionIndex = 1;
    let bounces = 3;
    let objectCount: number = OBJECT_COUNTS[1];
    let paused = false;

    let built = buildScene(objectCount);
    const pathTracer = new WebGLPathTracer(renderer);
    pathTracer.bounces = bounces;
    pathTracer.renderScale = 1;
    pathTracer.tiles.set(1, 1);

    const hud = buildHud(mount);

    const stats: ProbeStats = {
      ready: false,
      paused: false,
      resolution: RESOLUTIONS[resolutionIndex].label,
      internalPixels: 0,
      bounces,
      objectCount,
      spp: 0,
      frameMs: 0,
      fps: 0,
      bvhMs: 0,
      centerLuma: 0
    };

    function applyResolution(): void {
      const { w, h } = RESOLUTIONS[resolutionIndex];
      renderer.setSize(w, h, false); // false: leave CSS size (canvas stretches via style)
      camera.aspect = w / h;
      camera.updateProjectionMatrix();
      stats.resolution = RESOLUTIONS[resolutionIndex].label;
      stats.internalPixels = w * h;
    }
    applyResolution();

    // Initial (synchronous) scene build.
    function rebuild(measure: boolean): void {
      const t0 = measure ? performance.now() : 0;
      pathTracer.setScene(built.scene, camera);
      if (measure) stats.bvhMs = performance.now() - t0;
    }
    rebuild(false);
    pathTracer.bounces = bounces;

    function rebuildSceneGraph(): void {
      // dispose old, build new with new object count
      built.scene.traverse((o) => {
        const m = o as THREE.Mesh;
        if (m.isMesh) {
          m.geometry.dispose?.();
          const mat = m.material as THREE.Material | THREE.Material[];
          if (Array.isArray(mat)) mat.forEach((x) => x.dispose());
          else mat.dispose?.();
        }
      });
      built = buildScene(objectCount);
      rebuild(false);
    }

    // ---- public control surface (HUD keys + e2e) ----
    window.__pathtraceProbe = {
      getStats: () => ({ ...stats }),
      setResolution: (index: number) => {
        resolutionIndex = Math.max(0, Math.min(RESOLUTIONS.length - 1, index));
        applyResolution();
        rebuild(false);
      },
      cycleResolution: () => {
        resolutionIndex = (resolutionIndex + 1) % RESOLUTIONS.length;
        applyResolution();
        rebuild(false);
      },
      setBounces: (n: number) => {
        bounces = Math.max(1, Math.min(12, Math.round(n)));
        pathTracer.bounces = bounces;
        stats.bounces = bounces;
      },
      setObjectCount: (n: number) => {
        objectCount = n;
        stats.objectCount = n;
        rebuildSceneGraph();
      },
      setPaused: (p: boolean) => {
        paused = p;
        stats.paused = p;
      },
      togglePaused: () => {
        paused = !paused;
        stats.paused = paused;
      }
    };

    function onKey(e: KeyboardEvent): void {
      if (e.key === "r") window.__pathtraceProbe!.cycleResolution();
      else if (e.key === " ") {
        e.preventDefault();
        window.__pathtraceProbe!.togglePaused();
      } else if (e.key === "ArrowUp") window.__pathtraceProbe!.setBounces(bounces + 1);
      else if (e.key === "ArrowDown") window.__pathtraceProbe!.setBounces(bounces - 1);
      else if (e.key === "o") {
        const idx = OBJECT_COUNTS.indexOf(objectCount as (typeof OBJECT_COUNTS)[number]);
        window.__pathtraceProbe!.setObjectCount(
          OBJECT_COUNTS[(idx + 1) % OBJECT_COUNTS.length]
        );
      }
    }
    window.addEventListener("keydown", onKey);

    // ---- center-pixel luma probe (proves non-blank without preserveDrawingBuffer) ----
    const gl = renderer.getContext();
    const lumaBuf = new Uint8Array(4);
    function sampleCenterLuma(): void {
      const { w, h } = RESOLUTIONS[resolutionIndex];
      try {
        gl.readPixels(
          (w / 2) | 0,
          (h / 2) | 0,
          1,
          1,
          gl.RGBA,
          gl.UNSIGNED_BYTE,
          lumaBuf
        );
        stats.centerLuma = Math.round(
          0.2126 * lumaBuf[0] + 0.7152 * lumaBuf[1] + 0.0722 * lumaBuf[2]
        );
      } catch {
        /* readPixels can throw mid-resize; ignore one frame */
      }
    }

    // ---- frame loop ----
    let raf = 0;
    let startTime = 0;
    let lastFrame = 0;
    let frameMsAvg = 0;

    function frame(now: number): void {
      if (startTime === 0) {
        startTime = now;
        lastFrame = now;
      }
      const dt = now - lastFrame;
      lastFrame = now;
      if (dt > 0) {
        // exponential moving average for a stable readout
        frameMsAvg = frameMsAvg === 0 ? dt : frameMsAvg * 0.9 + dt * 0.1;
        stats.frameMs = Math.round(frameMsAvg * 100) / 100;
        stats.fps = Math.round(1000 / frameMsAvg);
      }

      const t = (now - startTime) / 1000;

      if (!paused) {
        applyMotion(built.dynamics, objectCount, t);
        rebuild(true); // rebuild BVH every frame — the dynamic-geometry reality
      }

      pathTracer.renderSample();
      stats.spp = Math.round((pathTracer.samples ?? 0) * 10) / 10;
      sampleCenterLuma();
      stats.ready = true;

      hud.set(
        [
          `PATH-TRACE PROBE  (dynamic ${paused ? "PAUSED — accumulating" : "MOVING"})`,
          ``,
          `fps        ${stats.fps}   (${stats.frameMs} ms/frame)`,
          `bvh build  ${stats.bvhMs.toFixed(2)} ms/frame  ${
            stats.bvhMs > stats.frameMs * 0.5 ? "  <-- CPU-BOUND" : ""
          }`,
          `spp acc    ${stats.spp}`,
          ``,
          `res        ${stats.resolution}  (${stats.internalPixels.toLocaleString()} px)`,
          `bounces    ${stats.bounces}`,
          `objects    ${stats.objectCount}`,
          ``,
          `[r] res   [↑/↓] bounces   [o] objects   [space] pause→accumulate`
        ].join("\n")
      );

      raf = requestAnimationFrame(frame);
    }
    raf = requestAnimationFrame(frame);

    return () => {
      cancelAnimationFrame(raf);
      window.removeEventListener("keydown", onKey);
      delete window.__pathtraceProbe;
      hud.dispose();
      built.scene.traverse((o) => {
        const m = o as THREE.Mesh;
        if (m.isMesh) {
          m.geometry.dispose?.();
          const mat = m.material as THREE.Material | THREE.Material[];
          if (Array.isArray(mat)) mat.forEach((x) => x.dispose());
          else mat.dispose?.();
        }
      });
      pathTracer.dispose?.();
      renderer.dispose();
      canvas.remove();
    };
  }
};

export default probe;
