import * as THREE from "three";
import { GLTFLoader } from "three/examples/jsm/loaders/GLTFLoader.js";
import { OrbitControls } from "three/examples/jsm/controls/OrbitControls.js";
import { makeRenderer } from "@common/render";
import type { ExperimentModule } from "../runtime/types";
import {
  simplifyMeshPlaneAware,
  type PlaneAwareSimplifyOptions,
  type PlaneAwareSimplifyResult
} from "./plane-aware-simplify";
import { loadSavedPropBinary } from "../settlement-builder-ecs/prop-library";

const LAB_PROP_ID = "commodore-pet-inspired-computer";
const LAB_PROP_LABEL = "Commodore PET Inspired Computer";

const DEFAULT_OPTIONS: Required<PlaneAwareSimplifyOptions> = {
  vertexMerge: 0.006,
  creaseProtect: 0.65,
  planeSensitivity: 0.58
};

async function loadPropModel(
  loader: GLTFLoader,
  propId: string
): Promise<THREE.Group | null> {
  const binary = await loadSavedPropBinary(propId);
  if (!binary) {
    return null;
  }

  return await new Promise<THREE.Group>((resolve, reject) => {
    loader.parse(
      binary,
      "",
      (gltf) => resolve((gltf.scene ?? new THREE.Group()) as THREE.Group),
      (error) => reject(error)
    );
  });
}

function createFallbackProp(): THREE.Group {
  const group = new THREE.Group();
  const material = new THREE.MeshStandardMaterial({
    color: 0x7f8a96,
    roughness: 0.84,
    metalness: 0.06
  });
  const mesh = new THREE.Mesh(new THREE.BoxGeometry(0.8, 0.8, 0.8), material);
  mesh.position.y = 0.4;
  mesh.castShadow = true;
  mesh.receiveShadow = true;
  group.add(mesh);
  return group;
}

function markRenderable(root: THREE.Object3D): void {
  root.traverse((node) => {
    if (!(node instanceof THREE.Mesh)) {
      return;
    }
    if (!node.geometry.attributes.normal) {
      node.geometry.computeVertexNormals();
    }
    node.castShadow = true;
    node.receiveShadow = true;
  });
}

function createSimplifiedOverlay(geometry: THREE.BufferGeometry): THREE.Group {
  const group = new THREE.Group();

  const fill = new THREE.MeshStandardMaterial({
    color: 0x8fd4ff,
    roughness: 0.8,
    metalness: 0.04,
    transparent: true,
    opacity: 0.34,
    side: THREE.DoubleSide
  });

  const wire = new THREE.LineBasicMaterial({
    color: 0xc7e8ff,
    transparent: true,
    opacity: 0.8
  });

  const fillMesh = new THREE.Mesh(geometry, fill);
  fillMesh.renderOrder = 310;
  fillMesh.castShadow = false;
  fillMesh.receiveShadow = false;

  const wireframe = new THREE.LineSegments(
    new THREE.WireframeGeometry(geometry),
    wire
  );
  wireframe.renderOrder = 311;

  group.add(fillMesh, wireframe);
  return group;
}

function disposeRenderable(root: THREE.Object3D): void {
  root.traverse((node) => {
    if (
      !(
        node instanceof THREE.Mesh ||
        node instanceof THREE.Line ||
        node instanceof THREE.LineSegments
      )
    ) {
      return;
    }

    node.geometry.dispose();
    const material = node.material;
    if (Array.isArray(material)) {
      for (const entry of material) {
        entry.dispose();
      }
    } else {
      material.dispose();
    }
  });
}

const experiment: ExperimentModule = {
  id: "compound-collider-lab",
  title: "Mesh Simplification Lab",
  tags: ["colliders", "mesh", "simplification", "debug"],
  init: async ({ mount, width, height, dpr }) => {
    mount.style.position = "relative";
    mount.style.background = "#0b1218";

    const renderer = makeRenderer(width, height, dpr);
    renderer.setClearColor(0x0b1218, 1);
    renderer.shadowMap.enabled = true;
    renderer.shadowMap.type = THREE.PCFSoftShadowMap;
    mount.appendChild(renderer.domElement);

    const scene = new THREE.Scene();
    scene.fog = new THREE.Fog(0x0b1218, 14, 44);

    const camera = new THREE.PerspectiveCamera(48, width / height, 0.05, 120);
    camera.position.set(9.2, 7.4, 9.2);
    camera.lookAt(0, 0.8, 0);

    const controls = new OrbitControls(camera, renderer.domElement);
    controls.enableDamping = true;
    controls.dampingFactor = 0.08;
    controls.target.set(0, 0.9, 0);
    controls.minDistance = 4;
    controls.maxDistance = 40;
    controls.maxPolarAngle = Math.PI * 0.49;

    scene.add(new THREE.HemisphereLight(0xd8eaff, 0x1f2f38, 0.58));

    const sun = new THREE.DirectionalLight(0xffffff, 1.2);
    sun.position.set(9, 12, 5);
    sun.castShadow = true;
    sun.shadow.mapSize.set(3072, 3072);
    sun.shadow.camera.near = 0.2;
    sun.shadow.camera.far = 60;
    sun.shadow.camera.left = -18;
    sun.shadow.camera.right = 18;
    sun.shadow.camera.top = 18;
    sun.shadow.camera.bottom = -18;
    scene.add(sun);

    const floor = new THREE.Mesh(
      new THREE.PlaneGeometry(80, 80),
      new THREE.MeshStandardMaterial({
        color: 0x22313b,
        roughness: 0.97,
        metalness: 0.02
      })
    );
    floor.rotation.x = -Math.PI * 0.5;
    floor.position.y = -0.002;
    floor.receiveShadow = true;
    scene.add(floor);

    const grid = new THREE.GridHelper(40, 80, 0x35556d, 0x213543);
    grid.position.y = 0.001;
    scene.add(grid);

    const hud = document.createElement("div");
    hud.style.position = "absolute";
    hud.style.left = "12px";
    hud.style.top = "12px";
    hud.style.width = "350px";
    hud.style.maxWidth = "calc(100% - 24px)";
    hud.style.padding = "10px 12px";
    hud.style.borderRadius = "12px";
    hud.style.background = "rgba(8,14,20,0.86)";
    hud.style.border = "1px solid rgba(118,177,220,0.45)";
    hud.style.color = "#d3e8fa";
    hud.style.font = '12px/1.35 "IBM Plex Sans", "Segoe UI", sans-serif';
    hud.style.backdropFilter = "blur(6px)";
    hud.style.pointerEvents = "auto";
    hud.style.zIndex = "5";
    mount.appendChild(hud);

    hud.innerHTML = [
      "<div style='font-size:13px;font-weight:600;letter-spacing:0.02em;margin-bottom:8px'>Mesh Simplification Lab</div>",
      "<div style='font-size:11px;opacity:0.88;margin-bottom:8px'>Clean testbed: one mesh simplifier, three knobs only.</div>",
      "<div style='display:flex;gap:10px;flex-wrap:wrap;margin:9px 0'>",
      "<label style='display:flex;align-items:center;gap:5px'><input data-id='show-original' type='checkbox' checked>Original</label>",
      "<label style='display:flex;align-items:center;gap:5px'><input data-id='show-simplified' type='checkbox' checked>Simplified</label>",
      "</div>",
      "<div style='margin:8px 0;padding:8px;border-radius:8px;background:rgba(10,18,25,0.55);border:1px solid rgba(118,177,220,0.25)'>",
      "<label style='display:block;margin:6px 0'>",
      "<div style='display:flex;justify-content:space-between;gap:8px;font-size:11px;opacity:0.92'><span>Vertex Merge</span><span data-id='value-merge'></span></div>",
      "<input data-id='knob-merge' type='range' min='0.0001' max='0.05' step='0.0001' value='0.006' style='width:100%'>",
      "</label>",
      "<label style='display:block;margin:6px 0'>",
      "<div style='display:flex;justify-content:space-between;gap:8px;font-size:11px;opacity:0.92'><span>Crease Protect</span><span data-id='value-crease'></span></div>",
      "<input data-id='knob-crease' type='range' min='0' max='100' step='1' value='65' style='width:100%'>",
      "</label>",
      "<label style='display:block;margin:6px 0'>",
      "<div style='display:flex;justify-content:space-between;gap:8px;font-size:11px;opacity:0.92'><span>Plane Sensitivity</span><span data-id='value-plane'></span></div>",
      "<input data-id='knob-plane' type='range' min='0' max='100' step='1' value='58' style='width:100%'>",
      "</label>",
      "</div>",
      "<pre data-id='stats' style='margin:9px 0 0;padding:7px;border-radius:8px;background:rgba(5,10,15,0.6);white-space:pre-wrap;font:11px/1.35 ui-monospace, SFMono-Regular, Menlo, Consolas, monospace'></pre>"
    ].join("");

    const showOriginal = hud.querySelector<HTMLInputElement>("[data-id='show-original']");
    const showSimplified = hud.querySelector<HTMLInputElement>("[data-id='show-simplified']");
    const knobMerge = hud.querySelector<HTMLInputElement>("[data-id='knob-merge']");
    const knobCrease = hud.querySelector<HTMLInputElement>("[data-id='knob-crease']");
    const knobPlane = hud.querySelector<HTMLInputElement>("[data-id='knob-plane']");
    const valueMerge = hud.querySelector<HTMLSpanElement>("[data-id='value-merge']");
    const valueCrease = hud.querySelector<HTMLSpanElement>("[data-id='value-crease']");
    const valuePlane = hud.querySelector<HTMLSpanElement>("[data-id='value-plane']");
    const statsPre = hud.querySelector<HTMLPreElement>("[data-id='stats']");

    if (
      !showOriginal ||
      !showSimplified ||
      !knobMerge ||
      !knobCrease ||
      !knobPlane ||
      !valueMerge ||
      !valueCrease ||
      !valuePlane ||
      !statsPre
    ) {
      throw new Error("Failed to initialize simplification lab controls.");
    }

    const loader = new GLTFLoader();
    const loaded = await loadPropModel(loader, LAB_PROP_ID);
    const model = loaded ?? createFallbackProp();
    markRenderable(model);

    const modelRoot = new THREE.Group();
    modelRoot.add(model);
    scene.add(modelRoot);

    const options: Required<PlaneAwareSimplifyOptions> = {
      ...DEFAULT_OPTIONS
    };

    const updateLabels = (): void => {
      valueMerge.textContent = `${options.vertexMerge.toFixed(4)} m`;
      valueCrease.textContent = `${Math.round(options.creaseProtect * 100)}%`;
      valuePlane.textContent = `${Math.round(options.planeSensitivity * 100)}%`;
    };

    let simplifyResult: PlaneAwareSimplifyResult = simplifyMeshPlaneAware(model, options);
    let simplifiedOverlay = createSimplifiedOverlay(simplifyResult.geometry);
    modelRoot.add(simplifiedOverlay);

    const syncVisibility = (): void => {
      model.visible = showOriginal.checked;
      simplifiedOverlay.visible = showSimplified.checked;
    };

    const renderStats = (): void => {
      const reduction =
        100 *
        (1 - simplifyResult.simplifiedFaces / Math.max(1, simplifyResult.originalFaces));

      statsPre.textContent = [
        `Loaded prop: ${LAB_PROP_ID}`,
        `Label: ${LAB_PROP_LABEL}`,
        `Fallback mesh: ${loaded ? "no" : "yes"}`,
        `Faces: ${simplifyResult.simplifiedFaces} / ${simplifyResult.originalFaces} (${reduction.toFixed(1)}% reduction)`,
        `Watertight: ${simplifyResult.watertight ? "yes" : "no"} (boundary edges: ${simplifyResult.boundaryEdges})`,
        `Plane clusters: ${simplifyResult.clusterCount}`,
        `Protected vertices: ${simplifyResult.protectedVertices}`,
        `Fallback used: ${simplifyResult.fallbackUsed ? "yes" : "no"}`
      ].join("\n");
    };

    updateLabels();
    syncVisibility();
    renderStats();

    let rebuildTimer = 0;
    const rebuildSimplified = (): void => {
      const next = simplifyMeshPlaneAware(model, options);
      modelRoot.remove(simplifiedOverlay);
      disposeRenderable(simplifiedOverlay);
      simplifyResult = next;
      simplifiedOverlay = createSimplifiedOverlay(simplifyResult.geometry);
      modelRoot.add(simplifiedOverlay);
      syncVisibility();
      renderStats();
    };

    const scheduleRebuild = (): void => {
      if (rebuildTimer !== 0) {
        window.clearTimeout(rebuildTimer);
      }
      rebuildTimer = window.setTimeout(() => {
        rebuildTimer = 0;
        rebuildSimplified();
      }, 90);
    };

    const onMergeInput = (): void => {
      const value = Number(knobMerge.value);
      if (!Number.isFinite(value)) {
        return;
      }
      options.vertexMerge = value;
      updateLabels();
      scheduleRebuild();
    };

    const onCreaseInput = (): void => {
      const value = Number(knobCrease.value);
      if (!Number.isFinite(value)) {
        return;
      }
      options.creaseProtect = value / 100;
      updateLabels();
      scheduleRebuild();
    };

    const onPlaneInput = (): void => {
      const value = Number(knobPlane.value);
      if (!Number.isFinite(value)) {
        return;
      }
      options.planeSensitivity = value / 100;
      updateLabels();
      scheduleRebuild();
    };

    showOriginal.addEventListener("change", syncVisibility);
    showSimplified.addEventListener("change", syncVisibility);
    knobMerge.addEventListener("input", onMergeInput);
    knobMerge.addEventListener("change", onMergeInput);
    knobCrease.addEventListener("input", onCreaseInput);
    knobCrease.addEventListener("change", onCreaseInput);
    knobPlane.addEventListener("input", onPlaneInput);
    knobPlane.addEventListener("change", onPlaneInput);

    const onResize = (): void => {
      const rect = mount.getBoundingClientRect();
      const nextWidth = Math.max(1, Math.floor(rect.width));
      const nextHeight = Math.max(1, Math.floor(rect.height));
      camera.aspect = nextWidth / nextHeight;
      camera.updateProjectionMatrix();
      renderer.setSize(nextWidth, nextHeight, true);
    };

    const resizeObserver = new ResizeObserver(() => {
      onResize();
    });
    resizeObserver.observe(mount);

    let raf = 0;
    const tick = (): void => {
      raf = requestAnimationFrame(tick);
      controls.update();
      renderer.render(scene, camera);
    };
    tick();

    return () => {
      cancelAnimationFrame(raf);
      resizeObserver.disconnect();
      if (rebuildTimer !== 0) {
        window.clearTimeout(rebuildTimer);
      }

      showOriginal.removeEventListener("change", syncVisibility);
      showSimplified.removeEventListener("change", syncVisibility);
      knobMerge.removeEventListener("input", onMergeInput);
      knobMerge.removeEventListener("change", onMergeInput);
      knobCrease.removeEventListener("input", onCreaseInput);
      knobCrease.removeEventListener("change", onCreaseInput);
      knobPlane.removeEventListener("input", onPlaneInput);
      knobPlane.removeEventListener("change", onPlaneInput);

      controls.dispose();
      renderer.dispose();

      scene.traverse((node) => {
        if (
          !(
            node instanceof THREE.Mesh ||
            node instanceof THREE.Line ||
            node instanceof THREE.LineSegments
          )
        ) {
          return;
        }

        node.geometry.dispose();
        const material = node.material;
        if (Array.isArray(material)) {
          for (const entry of material) {
            entry.dispose();
          }
        } else {
          material.dispose();
        }
      });

      hud.remove();
      renderer.domElement.remove();
    };
  }
};

export default experiment;
