import * as THREE from "three";
import { GLTFLoader } from "three/examples/jsm/loaders/GLTFLoader.js";
import {
  EDGE_DETECTION_DEBUG_MODES,
  PixelPerfectOutlinedView,
  type EdgeDetectionDebugMode
} from "@common/render";
import { bindPixelPerfectViewInput } from "@common/input";
import type { ExperimentModule } from "../runtime/types";

const KNOWN_TILESETS = new Set(["greek_island_white", "desert_sandstone"]);
const ROOM_TILE_NAMES = [
  "wall",
  "corner",
  "door",
  "floor_tile",
  "window_left",
  "window_middle"
] as const;
type RoomTileName = (typeof ROOM_TILE_NAMES)[number];

async function loadTileTemplate(tileset: string, tileName: string): Promise<THREE.Group> {
  const id = KNOWN_TILESETS.has(tileset) ? tileset : "greek_island_white";
  const path = `tilesets/${id}/artifacts/tiles/${tileName}/${tileName}.glb`;
  const url = `/api/assets/read?path=${encodeURIComponent(path)}`;
  const res = await fetch(url);
  if (!res.ok) throw new Error(`Failed to load ${tileName}: ${res.status}`);
  const buffer = await res.arrayBuffer();
  const loader = new GLTFLoader();
  const gltf = await new Promise<{ scene: THREE.Group }>((resolve, reject) => {
    loader.parse(buffer, "", resolve, reject);
  });
  return gltf.scene;
}

async function loadRoomTemplates(
  tileset: string
): Promise<Partial<Record<RoomTileName, THREE.Group>>> {
  const entries = await Promise.all(
    ROOM_TILE_NAMES.map(async (name): Promise<[RoomTileName, THREE.Group | null]> => {
      try {
        return [name, await loadTileTemplate(tileset, name)];
      } catch (err) {
        console.warn(`[outline-walls] ${tileset}/${name} failed:`, err);
        return [name, null];
      }
    })
  );
  const out: Partial<Record<RoomTileName, THREE.Group>> = {};
  for (const [name, group] of entries) {
    if (group) out[name] = group;
  }
  return out;
}

function setNearestFiltering(group: THREE.Object3D): void {
  group.traverse((obj) => {
    if (!(obj instanceof THREE.Mesh)) return;
    const mats = Array.isArray(obj.material) ? obj.material : [obj.material];
    for (const m of mats) {
      if (!(m instanceof THREE.MeshStandardMaterial)) continue;
      const maps: (THREE.Texture | null | undefined)[] = [
        m.map,
        m.normalMap,
        m.roughnessMap,
        m.metalnessMap,
        m.aoMap
      ];
      for (const t of maps) {
        if (!t) continue;
        t.magFilter = THREE.NearestFilter;
        t.minFilter = THREE.NearestFilter;
        t.generateMipmaps = false;
        t.needsUpdate = true;
      }
    }
  });
}

/**
 * 4 cm glass in iso-2:1 lands on sub-pixel verticals, producing inconsistent
 * rasterisation across yaws. Scaling the thin axis to ≥2 iso rows forces a
 * clean 1-pixel separation between silhouette and crease.
 */
function thickenGlass(root: THREE.Object3D, scale = 4.0): void {
  root.traverse((obj) => {
    if (!(obj instanceof THREE.Mesh)) return;
    const mats = Array.isArray(obj.material) ? obj.material : [obj.material];
    const isGlass = mats.some((m) => (m?.name ?? "") === "blockstudio_accent");
    if (!isGlass) return;
    obj.geometry.computeBoundingBox();
    const bb = obj.geometry.boundingBox;
    if (!bb) return;
    const sx = bb.max.x - bb.min.x;
    const sy = bb.max.y - bb.min.y;
    const sz = bb.max.z - bb.min.z;
    if (sx <= sy && sx <= sz) obj.scale.x = scale;
    else if (sy <= sz) obj.scale.y = scale;
    else obj.scale.z = scale;
  });
}

function groupKeyForMesh(mesh: THREE.Mesh): string {
  const mats = Array.isArray(mesh.material) ? mesh.material : [mesh.material];
  for (const m of mats) {
    const name = m?.name ?? "";
    if (name === "blockstudio_accent") return "glass";
    if (name === "blockstudio_trim") return "trim";
  }
  return "wall";
}

const experiment: ExperimentModule = {
  id: "outline-walls",
  title: "Outline Walls",
  tags: ["threejs", "pixel-perfect", "outline", "postprocess", "walls"],
  init: async ({ mount, width, height }) => {
    const scene = new THREE.Scene();
    scene.background = new THREE.Color(0x1d2029);

    const ambient = new THREE.AmbientLight(0xffffff, 0.45);
    scene.add(ambient);
    const key = new THREE.DirectionalLight(0xfff6e0, 1.1);
    key.position.set(2, 3, 4);
    scene.add(key);
    const fill = new THREE.DirectionalLight(0x98b0d6, 0.35);
    fill.position.set(-3, 4, -2);
    scene.add(fill);

    // Orbiting point light — washes across the wall face so the normal-map
    // relief and roughness highlights are visibly active.
    const orbitLight = new THREE.PointLight(0xffe7c4, 4.0, 12.0, 1.2);
    const orbitPivot = new THREE.Object3D();
    orbitPivot.position.set(0, 0.2, 0);
    orbitPivot.add(orbitLight);
    orbitLight.position.set(2.2, 0.4, 0.0);
    scene.add(orbitPivot);

    const params = new URLSearchParams(window.location.search);
    const debugMode: EdgeDetectionDebugMode =
      EDGE_DETECTION_DEBUG_MODES[
        Math.max(
          0,
          Math.min(
            EDGE_DETECTION_DEBUG_MODES.length - 1,
            Number(params.get("outlineDebug") ?? "0") | 0
          )
        )
      ] ?? "final";
    const initialZoom = Math.max(
      1,
      Math.min(8, Number(params.get("outlineZoom") ?? "1") | 0)
    );
    const idSuppression = (params.get("outlineMask") ?? "1") !== "0" ? "on" : "off";
    // Switch same-surface suppression between depth-delta ("depth") and
    // world-position-distance ("world-position"). Defaults to "depth" to
    // match current shipped behaviour.
    const suppressMode =
      params.get("outlineSuppress") === "world-position" ? "world-position" : "depth";
    const staggerMiddle = params.get("outlineStagger") === "1";
    const tilesetId = params.get("outlineTileset") ?? "greek_island_white";
    const splitGroups = params.get("outlineGroups") === "split";
    // Expose the post-target to diagnostic scripts when ?outlineReadback=1.
    // Forces a GPU stall per frame; do not enable in production.
    const lowPixelReadback = params.get("outlineReadback") === "1";
    // ?outlineFreezeOrbit=1 locks the orbiting point light at angle 0 so
    // edge-only screenshots are pixel-deterministic across runs (testbed).
    const freezeOrbit = params.get("outlineFreezeOrbit") === "1";
    // ?outlineHideHud=1 skips the HUD overlay so testbed classification is
    // not polluted by white-on-dark text pixels in edges-only screenshots.
    const hideHud = params.get("outlineHideHud") === "1";
    // ?outlineProbe=x,y dumps the depth/normal/id values of the LR pixel at
    // (x,y) and its 4 neighbours to console once the scene settles.
    const probeParam = params.get("outlineProbe");
    const probeCoord = probeParam
      ? probeParam.split(",").map((s) => Number(s.trim()) | 0)
      : null;
    // When the probe is enabled we also expose a window function for direct
    // playwright page.evaluate() calls so multi-probe scripts don't need to
    // round-trip a page navigation per probe.
    if (probeParam) {
      (window as unknown as {
        __outlineProbe__?: (x: number, y: number, stride?: number) => unknown;
      }).__outlineProbe__ = (x, y, stride) => outlined.debugReadAuxSamples(x, y, stride);
    }

    const rawSceneKind = params.get("outlineScene");
    const sceneKind: "strip" | "room" | "grid" =
      rawSceneKind === "room" ? "room" : rawSceneKind === "grid" ? "grid" : "strip";
    const gridSize = Math.max(
      1,
      Math.min(7, Number(params.get("outlineGridSize") ?? "3") | 0)
    );
    const gridAxis = (params.get("outlineGridAxis") ?? "diag") as "x" | "z" | "diag";

    const outlined = new PixelPerfectOutlinedView({
      mount,
      width,
      height,
      scene,
      basePixelZoom: initialZoom,
      // Moderate ease rate + early hand-off (large epsilon) avoids sub-pixel
      // shimmer during the rotation-snap tail on non-quarter-turn yaws.
      rotationAnimationRate: 20,
      rotationAnimationEpsilon: 0.08,
      clearColor: 0x1d2029,
      debugMode
    });
    outlined.setIdSuppression(idSuppression);
    outlined.setSuppressMode(suppressMode);
    const unbindInput = bindPixelPerfectViewInput({ view: outlined.view });

    const wallsGroup = new THREE.Group();
    const WORLD_UNIT = 1.28;

    try {
      if (sceneKind === "strip") {
        const template = await loadTileTemplate(tilesetId, "wall");
        setNearestFiltering(template);
        for (let i = 0; i < 3; i++) {
          const instance = template.clone(true);
          instance.scale.setScalar(WORLD_UNIT);
          const z = staggerMiddle && i === 1 ? 0.08 : 0;
          instance.position.set((i - 1) * WORLD_UNIT, 0, z);
          wallsGroup.add(instance);
          const groupKey = splitGroups ? `wall-${i}` : "wall";
          outlined.assignOutlineGroupsUnder(instance, () => groupKey);
        }
      } else if (sceneKind === "room") {
        const templates = await loadRoomTemplates(tilesetId);
        for (const t of Object.values(templates)) {
          if (t) setNearestFiltering(t);
        }
        const place = (
          name: RoomTileName,
          cellX: number,
          cellZ: number,
          yaw = 0
        ) => {
          const tmpl = templates[name];
          if (!tmpl) return;
          const instance = tmpl.clone(true);
          instance.scale.setScalar(WORLD_UNIT);
          instance.position.set(cellX * WORLD_UNIT, 0, cellZ * WORLD_UNIT);
          instance.rotation.y = yaw;
          thickenGlass(instance);
          wallsGroup.add(instance);
          outlined.assignOutlineGroupsUnder(instance, groupKeyForMesh);
        };

        // Minimal reproducers for the concave-corner V-gap
        // (docs/AGENT_LEARNINGS.md 2026-04-22). `two-corners` is the smallest
        // setup that exhibits a same-group silhouette behind a same-normal
        // front mesh; the others isolate individual tile-tile interactions.
        const onlyCorner = params.get("onlyCorner") === "1";
        const variant = params.get("outlineVariant") ?? "";
        if (variant === "compare") {
          place("corner", -3, 0, 0);
          place("corner", 3, 0, 0);
          place("floor_tile", 3.75, 0);
          place("floor_tile", 3.75, 0.75);
          place("floor_tile", 3, 0.75);
        } else if (variant === "corner-floor") {
          place("corner", 0, 0, 0);
          place("floor_tile", 0.75, 0);
          place("floor_tile", 0.75, 0.75);
          place("floor_tile", 0, 0.75);
        } else if (variant === "two-corners") {
          place("corner", -0.75, 0, 0);
          place("corner", 0.75, 0, Math.PI / 2);
        } else if (variant === "corner-wall") {
          place("corner", 0, 0, 0);
          place("wall", 0, 1.5);
        } else if (onlyCorner) {
          place("corner", 0, 0, 0);
        } else {
          for (let i = -1; i <= 1; i++) {
            for (let j = -1; j <= 1; j++) {
              place("floor_tile", i, j);
            }
          }
          place("wall", 0, -1.5);
          place("door", 0, 1.5);
          place("window_middle", -1.5, 0, Math.PI / 2);
          place("window_middle", 1.5, 0, Math.PI / 2);
          place("corner", -1.5, -1.5, (3 * Math.PI) / 2);
          place("corner", 1.5, -1.5, Math.PI);
          place("corner", 1.5, 1.5, Math.PI / 2);
          place("corner", -1.5, 1.5, 0);
        }
      } else if (sceneKind === "grid") {
        const template = await loadTileTemplate(tilesetId, "window_middle");
        setNearestFiltering(template);
        const offsets: number[] = [];
        if (gridSize === 2) {
          offsets.push(-1.5, 1.5);
        } else {
          const stride = Math.max(1, Number(params.get("outlineGridStride") ?? "1") | 0);
          const half = (gridSize - 1) / 2;
          for (let i = 0; i < gridSize; i++) offsets.push((i - half) * stride);
        }
        for (const off of offsets) {
          const cellX = gridAxis === "z" ? 0 : off;
          const cellZ = gridAxis === "x" ? 0 : off;
          const instance = template.clone(true);
          instance.scale.setScalar(WORLD_UNIT);
          instance.position.set(cellX * WORLD_UNIT, 0, cellZ * WORLD_UNIT);
          instance.rotation.y = Math.PI / 2;
          thickenGlass(instance);
          wallsGroup.add(instance);
          outlined.assignOutlineGroupsUnder(instance, groupKeyForMesh);
        }
      }
    } catch (err) {
      console.error("[outline-walls] scene load failed:", err);
    }

    wallsGroup.position.set(0, -1.4, 0);
    scene.add(wallsGroup);

    const observer = new ResizeObserver((entries) => {
      for (const e of entries) {
        if (e.contentRect.width > 0 && e.contentRect.height > 0) {
          outlined.resize(e.contentRect.width, e.contentRect.height);
        }
      }
    });
    observer.observe(mount);

    const hud = document.createElement("div");
    hud.style.cssText =
      "position:absolute;top:8px;left:8px;padding:4px 8px;background:rgba(0,0,0,0.55);" +
      "color:#eee;font:11px/1.3 monospace;border-radius:3px;pointer-events:none;z-index:10;";
    let currentDebug: EdgeDetectionDebugMode = debugMode;
    const updateHud = () => {
      hud.textContent = `outline-walls — [D] debug: ${currentDebug} — pan: MMB, Q/E rotate, wheel zoom`;
    };
    updateHud();
    mount.style.position = "relative";
    if (!hideHud) mount.appendChild(hud);

    const onKey = (e: KeyboardEvent) => {
      if (e.code === "KeyD" && !e.ctrlKey && !e.metaKey && !e.altKey) {
        currentDebug = outlined.cycleDebugMode();
        updateHud();
        e.preventDefault();
      }
    };
    window.addEventListener("keydown", onKey);

    let raf = 0;
    let prev = performance.now();
    let framesSinceStart = 0;
    let probeDone = false;
    const ORBIT_PERIOD_S = 6.0;
    let readbackBuf: Uint8Array | undefined;
    const tick = () => {
      raf = requestAnimationFrame(tick);
      const now = performance.now();
      const dt = Math.min((now - prev) / 1000, 0.1);
      prev = now;
      const t = (now / 1000) * ((Math.PI * 2) / ORBIT_PERIOD_S);
      orbitPivot.rotation.y = freezeOrbit ? 0 : t;
      outlined.frame(now, dt);
      framesSinceStart++;
      if (probeCoord && !probeDone && framesSinceStart > 60) {
        const [px, py] = probeCoord;
        const sample = outlined.debugReadAuxSamples(px, py);
        console.log("[outline-probe]", JSON.stringify(sample));
        probeDone = true;
      }
      if (lowPixelReadback) {
        const snapshot = outlined.readLowResolutionPixels(readbackBuf);
        readbackBuf = snapshot.pixels;
        (window as unknown as { __outlineLow__?: unknown }).__outlineLow__ = {
          width: snapshot.width,
          height: snapshot.height,
          pixels: Array.from(snapshot.pixels)
        };
      }
    };
    tick();

    return () => {
      cancelAnimationFrame(raf);
      observer.disconnect();
      unbindInput();
      window.removeEventListener("keydown", onKey);
      hud.remove();
      scene.remove(wallsGroup);
      scene.remove(orbitPivot);
      outlined.dispose();
    };
  }
};

export default experiment;
