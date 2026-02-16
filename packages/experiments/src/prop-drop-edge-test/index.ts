import * as THREE from "three";
import RAPIER3D from "@dimforge/rapier3d-compat";
import { GLTFLoader } from "three/examples/jsm/loaders/GLTFLoader.js";
import { makeRenderer } from "@common/render";
import type { ExperimentModule } from "../runtime/types";

type TrimeshColliderData = {
  vertices: Float32Array;
  indices: Uint32Array;
  minY: number;
};

type TrimeshBounds = {
  min: THREE.Vector3;
  max: THREE.Vector3;
  center: THREE.Vector3;
};

const FIXED_DT = 1 / 60;
const MAX_STEPS_PER_FRAME = 8;
const CRATE_POSITION = new THREE.Vector3(0, 0, 0);
const BOTTLE_DROP_START = new THREE.Vector3(0.5, 1.8, 0);
const MAX_LINEAR_SPEED = 8;
const MAX_ANGULAR_SPEED = 18;

const CRATE_MODEL_URL = new URL(
  "../../../../assets/forge/props/ammo-crate/processed/model.glb",
  import.meta.url
).href;
const CRATE_COLLIDER_URL = new URL(
  "../../../../assets/forge/props/ammo-crate/processed/collider.glb",
  import.meta.url
).href;
const BOTTLE_MODEL_URL = new URL(
  "../../../../assets/forge/props/chemical-flask/processed/model.glb",
  import.meta.url
).href;
const BOTTLE_COLLIDER_URL = new URL(
  "../../../../assets/forge/props/chemical-flask/processed/collider.glb",
  import.meta.url
).href;

let rapierInitPromise: Promise<void> | null = null;

function ensureRapierReady(): Promise<void> {
  if (!rapierInitPromise) {
    rapierInitPromise = RAPIER3D.init();
  }
  return rapierInitPromise;
}

function normalizeTemplate(object: THREE.Object3D): void {
  object.updateMatrixWorld(true);
  const bounds = new THREE.Box3().setFromObject(object);
  if (bounds.isEmpty()) {
    return;
  }
  const center = bounds.getCenter(new THREE.Vector3());
  object.position.x -= center.x;
  object.position.z -= center.z;
  object.position.y -= bounds.min.y;
  object.updateMatrixWorld(true);
}

async function loadTemplate(loader: GLTFLoader, url: string): Promise<THREE.Object3D | null> {
  try {
    const gltf = await loader.loadAsync(url);
    const root = gltf.scene ?? null;
    if (!root) {
      return null;
    }
    normalizeTemplate(root);
    return root;
  } catch {
    return null;
  }
}

function markRenderable(root: THREE.Object3D): void {
  root.traverse((node) => {
    if (!(node instanceof THREE.Mesh)) {
      return;
    }
    node.castShadow = true;
    node.receiveShadow = true;
  });
}

function buildTrimeshData(template: THREE.Object3D): TrimeshColliderData | null {
  const vertices: number[] = [];
  const indices: number[] = [];
  const scratch = new THREE.Vector3();
  let minY = Number.POSITIVE_INFINITY;

  template.updateMatrixWorld(true);
  template.traverse((node) => {
    if (!(node instanceof THREE.Mesh)) {
      return;
    }
    if (!(node.geometry instanceof THREE.BufferGeometry)) {
      return;
    }
    const position = node.geometry.attributes.position;
    if (!position) {
      return;
    }

    const offset = vertices.length / 3;
    for (let i = 0; i < position.count; i += 1) {
      scratch
        .set(position.getX(i), position.getY(i), position.getZ(i))
        .applyMatrix4(node.matrixWorld);
      vertices.push(scratch.x, scratch.y, scratch.z);
      minY = Math.min(minY, scratch.y);
    }

    if (node.geometry.index) {
      const index = node.geometry.index;
      for (let i = 0; i + 2 < index.count; i += 3) {
        indices.push(
          offset + index.getX(i),
          offset + index.getX(i + 1),
          offset + index.getX(i + 2)
        );
      }
      return;
    }

    for (let i = 0; i + 2 < position.count; i += 3) {
      indices.push(offset + i, offset + i + 1, offset + i + 2);
    }
  });

  if (!Number.isFinite(minY) || vertices.length < 9 || indices.length < 3) {
    return null;
  }

  return {
    vertices: new Float32Array(vertices),
    indices: new Uint32Array(indices),
    minY
  };
}

function computeTrimeshBounds(data: TrimeshColliderData): TrimeshBounds {
  const min = new THREE.Vector3(
    Number.POSITIVE_INFINITY,
    Number.POSITIVE_INFINITY,
    Number.POSITIVE_INFINITY
  );
  const max = new THREE.Vector3(
    Number.NEGATIVE_INFINITY,
    Number.NEGATIVE_INFINITY,
    Number.NEGATIVE_INFINITY
  );
  const { vertices } = data;
  for (let i = 0; i + 2 < vertices.length; i += 3) {
    const x = vertices[i];
    const y = vertices[i + 1];
    const z = vertices[i + 2];
    if (x < min.x) min.x = x;
    if (y < min.y) min.y = y;
    if (z < min.z) min.z = z;
    if (x > max.x) max.x = x;
    if (y > max.y) max.y = y;
    if (z > max.z) max.z = z;
  }
  return {
    min,
    max,
    center: new THREE.Vector3(
      (min.x + max.x) * 0.5,
      (min.y + max.y) * 0.5,
      (min.z + max.z) * 0.5
    )
  };
}

function centerTrimeshData(data: TrimeshColliderData): {
  centered: TrimeshColliderData;
  rootOffset: THREE.Vector3;
} {
  const bounds = computeTrimeshBounds(data);
  const centeredVertices = new Float32Array(data.vertices.length);
  for (let i = 0; i + 2 < data.vertices.length; i += 3) {
    centeredVertices[i] = data.vertices[i] - bounds.center.x;
    centeredVertices[i + 1] = data.vertices[i + 1] - bounds.center.y;
    centeredVertices[i + 2] = data.vertices[i + 2] - bounds.center.z;
  }
  return {
    centered: {
      vertices: centeredVertices,
      indices: data.indices,
      minY: bounds.min.y - bounds.center.y
    },
    rootOffset: bounds.center.clone().multiplyScalar(-1)
  };
}

function clampBodyVelocity(body: RAPIER3D.RigidBody): void {
  const linear = body.linvel();
  const linearSpeed = Math.hypot(linear.x, linear.y, linear.z);
  if (linearSpeed > MAX_LINEAR_SPEED && linearSpeed > 0) {
    const scale = MAX_LINEAR_SPEED / linearSpeed;
    body.setLinvel(
      {
        x: linear.x * scale,
        y: linear.y * scale,
        z: linear.z * scale
      },
      true
    );
  }

  const angular = body.angvel();
  const angularSpeed = Math.hypot(angular.x, angular.y, angular.z);
  if (angularSpeed > MAX_ANGULAR_SPEED && angularSpeed > 0) {
    const scale = MAX_ANGULAR_SPEED / angularSpeed;
    body.setAngvel(
      {
        x: angular.x * scale,
        y: angular.y * scale,
        z: angular.z * scale
      },
      true
    );
  }
}

function createPlaceholder(size: THREE.Vector3, color: number): THREE.Mesh {
  const mesh = new THREE.Mesh(
    new THREE.BoxGeometry(size.x, size.y, size.z),
    new THREE.MeshStandardMaterial({
      color,
      roughness: 0.75,
      metalness: 0.08
    })
  );
  mesh.position.y = size.y * 0.5;
  mesh.castShadow = true;
  mesh.receiveShadow = true;
  return mesh;
}

const experiment: ExperimentModule = {
  id: "prop-drop-edge-test",
  title: "Prop Drop Edge Test",
  tags: ["physics", "rapier3d", "props", "debug"],
  init: async ({ mount, width, height, dpr }) => {
    await ensureRapierReady();

    mount.style.position = "relative";

    const renderer = makeRenderer(width, height, dpr);
    renderer.shadowMap.enabled = true;
    renderer.shadowMap.type = THREE.PCFSoftShadowMap;
    renderer.setClearColor(0x101821, 1);
    mount.appendChild(renderer.domElement);

    const scene = new THREE.Scene();
    scene.fog = new THREE.Fog(0x101821, 8, 26);

    const camera = new THREE.PerspectiveCamera(48, width / height, 0.1, 60);
    camera.position.set(3.2, 2.9, 3.6);
    camera.lookAt(0, 0.8, 0);

    const hemi = new THREE.HemisphereLight(0xddefff, 0x31402c, 0.56);
    scene.add(hemi);

    const sun = new THREE.DirectionalLight(0xffffff, 1.25);
    sun.position.set(4.5, 7.5, 2.8);
    sun.castShadow = true;
    sun.shadow.mapSize.set(2048, 2048);
    sun.shadow.camera.near = 0.1;
    sun.shadow.camera.far = 20;
    sun.shadow.camera.left = -5;
    sun.shadow.camera.right = 5;
    sun.shadow.camera.top = 5;
    sun.shadow.camera.bottom = -5;
    scene.add(sun);
    const sunTarget = new THREE.Object3D();
    sunTarget.position.set(0, 0.55, 0);
    sun.target = sunTarget;
    scene.add(sunTarget);

    const floor = new THREE.Mesh(
      new THREE.PlaneGeometry(12, 12),
      new THREE.MeshStandardMaterial({
        color: 0x303844,
        roughness: 0.95,
        metalness: 0.02
      })
    );
    floor.rotation.x = -Math.PI * 0.5;
    floor.position.y = -0.002;
    floor.receiveShadow = true;
    scene.add(floor);

    const hud = document.createElement("div");
    hud.style.position = "absolute";
    hud.style.left = "12px";
    hud.style.top = "12px";
    hud.style.padding = "10px 12px";
    hud.style.borderRadius = "10px";
    hud.style.background = "rgba(7, 13, 18, 0.84)";
    hud.style.border = "1px solid rgba(139, 189, 222, 0.45)";
    hud.style.font = "12px/1.4 ui-monospace, SFMono-Regular, Menlo, Consolas, monospace";
    hud.style.color = "#d4e9fb";
    hud.style.whiteSpace = "pre-line";
    hud.style.pointerEvents = "none";
    hud.textContent = "Loading crate+bottle...";
    mount.appendChild(hud);

    const loader = new GLTFLoader();
    const crateModelTemplate =
      (await loadTemplate(loader, CRATE_MODEL_URL)) ??
      createPlaceholder(new THREE.Vector3(1, 0.95, 1), 0x687486);
    const bottleModelTemplate =
      (await loadTemplate(loader, BOTTLE_MODEL_URL)) ??
      createPlaceholder(new THREE.Vector3(0.34, 0.42, 0.34), 0x90d2ff);
    markRenderable(crateModelTemplate);
    markRenderable(bottleModelTemplate);

    const crateColliderTemplate =
      (await loadTemplate(loader, CRATE_COLLIDER_URL)) ?? crateModelTemplate.clone(true);
    const bottleColliderTemplate =
      (await loadTemplate(loader, BOTTLE_COLLIDER_URL)) ?? bottleModelTemplate.clone(true);

    const crateTrimesh = buildTrimeshData(crateColliderTemplate);
    const bottleTrimeshRaw = buildTrimeshData(bottleColliderTemplate);
    const bottleCentered = bottleTrimeshRaw ? centerTrimeshData(bottleTrimeshRaw) : null;
    const bottleTrimesh = bottleCentered?.centered ?? null;
    const bottleVisualRootOffset = bottleCentered?.rootOffset ?? new THREE.Vector3(0, 0, 0);
    const bottleVisualOffsetScratch = new THREE.Vector3();

    const crateVisual = crateModelTemplate.clone(true);
    crateVisual.position.copy(CRATE_POSITION);
    crateVisual.updateMatrixWorld(true);
    scene.add(crateVisual);

    const bottleVisual = bottleModelTemplate.clone(true);
    bottleVisual.position.set(BOTTLE_DROP_START.x, BOTTLE_DROP_START.y, BOTTLE_DROP_START.z);
    bottleVisual.updateMatrixWorld(true);
    scene.add(bottleVisual);

    const status = {
      world: new RAPIER3D.World({ x: 0, y: -9.81, z: 0 }),
      bottleBody: null as RAPIER3D.RigidBody | null
    };
    let accumulator = 0;
    let timePrev = performance.now();

    const resetBottleDrop = (): void => {
      status.world.free();
      status.world = new RAPIER3D.World({ x: 0, y: -9.81, z: 0 });
      status.world.integrationParameters.dt = FIXED_DT;
      status.world.integrationParameters.numSolverIterations = 8;
      status.world.integrationParameters.numInternalPgsIterations = 3;
      status.world.integrationParameters.maxCcdSubsteps = 4;

      const floorBody = status.world.createRigidBody(
        RAPIER3D.RigidBodyDesc.fixed().setTranslation(0, -0.05, 0)
      );
      status.world.createCollider(
        RAPIER3D.ColliderDesc.cuboid(40, 0.05, 40),
        floorBody
      );

      const crateBody = status.world.createRigidBody(
        RAPIER3D.RigidBodyDesc.fixed().setTranslation(
          CRATE_POSITION.x,
          crateTrimesh ? CRATE_POSITION.y - crateTrimesh.minY : CRATE_POSITION.y + 0.48,
          CRATE_POSITION.z
        )
      );
      if (crateTrimesh) {
        status.world.createCollider(
          RAPIER3D.ColliderDesc.trimesh(crateTrimesh.vertices, crateTrimesh.indices)
            .setFriction(0.9)
            .setRestitution(0),
          crateBody
        );
      } else {
        status.world.createCollider(
          RAPIER3D.ColliderDesc.cuboid(0.5, 0.48, 0.5)
            .setFriction(0.9)
            .setRestitution(0),
          crateBody
        );
      }

      const bottleBody = status.world.createRigidBody(
        RAPIER3D.RigidBodyDesc.dynamic()
          .setTranslation(
            BOTTLE_DROP_START.x,
            bottleTrimesh
              ? BOTTLE_DROP_START.y - bottleTrimesh.minY
              : BOTTLE_DROP_START.y + 0.2,
            BOTTLE_DROP_START.z
          )
          .setAdditionalSolverIterations(4)
      );
      bottleBody.setLinvel({ x: 0, y: 0, z: 0 }, true);
      bottleBody.setAngvel({ x: 0, y: 0, z: 0 }, true);
      bottleBody.setLinearDamping(0.3);
      bottleBody.setAngularDamping(0.4);
      bottleBody.enableCcd(true);

      if (bottleTrimesh) {
        const hullDesc = RAPIER3D.ColliderDesc.convexHull(bottleTrimesh.vertices);
        if (hullDesc) {
          status.world.createCollider(
            hullDesc.setFriction(0.78).setRestitution(0).setMass(0.9),
            bottleBody
          );
        } else {
          status.world.createCollider(
            RAPIER3D.ColliderDesc.cuboid(0.17, 0.2, 0.17)
              .setFriction(0.78)
              .setRestitution(0)
              .setMass(0.9),
            bottleBody
          );
        }
      } else {
        status.world.createCollider(
          RAPIER3D.ColliderDesc.cuboid(0.17, 0.2, 0.17)
            .setFriction(0.78)
            .setRestitution(0)
            .setMass(0.9),
          bottleBody
        );
      }

      status.bottleBody = bottleBody;
      accumulator = 0;
    };

    resetBottleDrop();

    const onKeyDown = (event: KeyboardEvent): void => {
      if (event.code === "Space" || event.code === "KeyR") {
        event.preventDefault();
        resetBottleDrop();
      }
    };
    window.addEventListener("keydown", onKeyDown);

    let raf = 0;
    const animate = (): void => {
      raf = requestAnimationFrame(animate);
      const timeNow = performance.now();
      const dt = Math.min(0.05, (timeNow - timePrev) / 1000);
      timePrev = timeNow;
      accumulator += dt;

      let steps = 0;
      while (accumulator >= FIXED_DT && steps < MAX_STEPS_PER_FRAME) {
        status.world.step();
        if (status.bottleBody) {
          clampBodyVelocity(status.bottleBody);
        }
        accumulator -= FIXED_DT;
        steps += 1;
      }

      const body = status.bottleBody;
      if (body) {
        const t = body.translation();
        const r = body.rotation();
        bottleVisual.quaternion.set(r.x, r.y, r.z, r.w);
        bottleVisualOffsetScratch
          .copy(bottleVisualRootOffset)
          .applyQuaternion(bottleVisual.quaternion);
        bottleVisual.position.set(
          t.x + bottleVisualOffsetScratch.x,
          t.y + bottleVisualOffsetScratch.y,
          t.z + bottleVisualOffsetScratch.z
        );
      }

      const bodyText = body
        ? (() => {
            const t = body.translation();
            const v = body.linvel();
            const speed = Math.sqrt(v.x * v.x + v.y * v.y + v.z * v.z);
            const onGround = t.y <= 0.03;
            return [
              "Prop Drop Edge Test",
              "Bottle starts over crate edge at x=0.50",
              "Expected: falls off crate to floor",
              "Reset: Space or R",
              "",
              `Bottle pos: x=${t.x.toFixed(3)} y=${t.y.toFixed(3)} z=${t.z.toFixed(3)}`,
              `Bottle speed: ${speed.toFixed(3)} m/s`,
              `State: ${onGround ? "on floor" : "falling/on crate"}`
            ].join("\n");
          })()
        : "No bottle body";
      hud.textContent = bodyText;

      renderer.render(scene, camera);
    };
    animate();

    return () => {
      cancelAnimationFrame(raf);
      window.removeEventListener("keydown", onKeyDown);
      status.world.free();
      renderer.dispose();
      scene.traverse((node) => {
        if (node instanceof THREE.Mesh) {
          node.geometry.dispose();
          if (Array.isArray(node.material)) {
            node.material.forEach((mat) => mat.dispose());
          } else {
            node.material.dispose();
          }
        }
      });
      hud.remove();
      renderer.domElement.remove();
    };
  }
};

export default experiment;
