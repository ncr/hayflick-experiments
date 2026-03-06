import { useEffect, useRef } from "react";
import * as THREE from "three";
import { computeBBox, type BBox } from "../../forge-core/processing/dimensions";
import { resolveForgeMass } from "../../forge-core/processing/physics";
import { deepCloneWithMaterials } from "../model/MeshProcessor";
import type { ColliderParams } from "../../forge-core/processing/colliders";
import type { PropPhysicsSettings } from "../../forge-core/types";
import type { ForgeColliderResultEntry } from "../types";
import type { ForgeRuntimeRefs } from "../state/forge-context";

// ---------------------------------------------------------------------------
// Rapier lazy init
// ---------------------------------------------------------------------------

type RapierLike = {
  init(): Promise<void>;
  World: new (gravity: { x: number; y: number; z: number }) => any;
  RigidBodyDesc: {
    dynamic(): any;
    fixed(): any;
  };
  ColliderDesc: {
    cuboid(hx: number, hy: number, hz: number): any;
    convexHull(vertices: Float32Array): any;
  };
};

let rapier3dPromise: Promise<RapierLike> | null = null;

async function ensureRapier3d(): Promise<RapierLike> {
  if (!rapier3dPromise) {
    rapier3dPromise = (async () => {
      const mod = (await import("@dimforge/rapier3d-compat")) as unknown as {
        default: RapierLike;
      };
      await mod.default.init();
      return mod.default;
    })();
  }
  return rapier3dPromise;
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

type PhysicsPreviewScenario = "floorDrop" | "slope30Drop" | "edgeDrop";
const PHYSICS_SCENARIOS: PhysicsPreviewScenario[] = ["floorDrop", "slope30Drop", "edgeDrop"];
const PHYSICS_SCENARIO_LABELS: Record<PhysicsPreviewScenario, string> = {
  floorDrop: "Floor Drop",
  slope30Drop: "30deg Slope",
  edgeDrop: "Edge Drop",
};

type SimVisualSetup = {
  meshRoot: THREE.Group;
  meshDynamic: THREE.Object3D;
  pixelRoot: THREE.Group;
  spawnPosition: THREE.Vector3;
  spawnQuaternion: THREE.Quaternion;
};

function clamp(value: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, value));
}

// ---------------------------------------------------------------------------
// Scene builders
// ---------------------------------------------------------------------------

function createScenarioVisuals(
  baseModel: THREE.Group,
  scenario: PhysicsPreviewScenario
): SimVisualSetup {
  const sourceBBox = computeBBox(baseModel);
  const meshRoot = new THREE.Group();
  const pixelRoot = new THREE.Group();

  function addEnvironment(root: THREE.Group): void {
    const floor = new THREE.Mesh(
      new THREE.BoxGeometry(14, 0.1, 14),
      new THREE.MeshStandardMaterial({
        color: 0x51667a,
        roughness: 0.95,
        metalness: 0.02,
      })
    );
    floor.position.set(0, -0.05, 0);
    floor.receiveShadow = true;
    root.add(floor);

    const grid = new THREE.GridHelper(12, 12, 0x7ea0bf, 0x44586d);
    grid.position.y = 0.002;
    root.add(grid);

    if (scenario === "slope30Drop") {
      const ramp = new THREE.Mesh(
        new THREE.BoxGeometry(3.2, 0.16, 2.2),
        new THREE.MeshStandardMaterial({
          color: 0xc29362,
          roughness: 0.88,
          metalness: 0.03,
        })
      );
      ramp.position.set(0.8, 0.55, 0);
      ramp.rotation.z = -Math.PI / 6;
      root.add(ramp);
    }

    if (scenario === "edgeDrop") {
      const box = new THREE.Mesh(
        new THREE.BoxGeometry(1, 1, 1),
        new THREE.MeshStandardMaterial({
          color: 0x7ec6a2,
          roughness: 0.84,
          metalness: 0.04,
        })
      );
      box.position.set(0, 0.5, 0);
      root.add(box);
    }
  }

  addEnvironment(meshRoot);
  addEnvironment(pixelRoot);

  const meshProp = deepCloneWithMaterials(baseModel);
  meshProp.name = "sim-body";
  meshRoot.add(meshProp);

  const pixelProp = deepCloneWithMaterials(baseModel);
  pixelProp.name = "sim-body";
  pixelRoot.add(pixelProp);

  const height = Math.max(0.2, sourceBBox.height);
  let spawn = new THREE.Vector3(0, Math.max(1.4, height + 1.1), 0);
  if (scenario === "slope30Drop") {
    spawn = new THREE.Vector3(-0.45, Math.max(1.5, height + 1.2), 0);
  } else if (scenario === "edgeDrop") {
    spawn = new THREE.Vector3(0.55, Math.max(1.8, height + 1.2), 0);
  }

  return {
    meshRoot,
    meshDynamic: meshProp,
    pixelRoot,
    spawnPosition: spawn,
    spawnQuaternion: new THREE.Quaternion(),
  };
}

function createStaticBody(
  rapier: RapierLike,
  world: any,
  options: {
    translation: THREE.Vector3;
    halfExtents: THREE.Vector3;
    quaternion?: THREE.Quaternion;
    friction: number;
    restitution: number;
  }
): void {
  const bodyDesc = rapier.RigidBodyDesc.fixed().setTranslation(
    options.translation.x,
    options.translation.y,
    options.translation.z
  );
  if (options.quaternion) {
    bodyDesc.setRotation({
      x: options.quaternion.x,
      y: options.quaternion.y,
      z: options.quaternion.z,
      w: options.quaternion.w,
    });
  }
  const body = world.createRigidBody(bodyDesc);
  const desc = rapier.ColliderDesc.cuboid(
    Math.max(0.001, options.halfExtents.x),
    Math.max(0.001, options.halfExtents.y),
    Math.max(0.001, options.halfExtents.z)
  )
    .setFriction(options.friction)
    .setRestitution(options.restitution);
  world.createCollider(desc, body);
}

function attachDynamicColliderFromParams(
  rapier: RapierLike,
  world: any,
  body: any,
  collider: ColliderParams,
  fallbackBounds: BBox,
  options: { mass: number; friction: number; restitution: number }
): number {
  let created = 0;
  if (collider.type === "compound-convex-hulls") {
    const partsRaw = Array.isArray(collider.params.parts) ? collider.params.parts : [];
    const validParts = partsRaw.filter(
      (part): part is Record<string, unknown> => !!part && typeof part === "object"
    );
    const perPartMass = options.mass / Math.max(1, validParts.length);
    for (const part of validParts) {
      const posRaw = part.position;
      const pointsRaw = Array.isArray(part.points) ? part.points : [];
      if (!Array.isArray(posRaw) || posRaw.length !== 3 || pointsRaw.length < 4) {
        continue;
      }
      const vertices = new Float32Array(pointsRaw.length * 3);
      let write = 0;
      for (let i = 0; i < pointsRaw.length; i += 1) {
        const point = pointsRaw[i];
        if (!Array.isArray(point) || point.length !== 3) {
          continue;
        }
        vertices[write++] = Number(point[0]) || 0;
        vertices[write++] = Number(point[1]) || 0;
        vertices[write++] = Number(point[2]) || 0;
      }
      if (write < 12) {
        continue;
      }
      const hullVertices = write === vertices.length ? vertices : vertices.slice(0, write);
      const desc = rapier.ColliderDesc.convexHull(hullVertices);
      if (!desc) {
        continue;
      }
      desc
        .setTranslation(
          Number(posRaw[0]) || 0,
          Number(posRaw[1]) || 0,
          Number(posRaw[2]) || 0
        )
        .setFriction(options.friction)
        .setRestitution(options.restitution)
        .setMass(perPartMass);
      world.createCollider(desc, body);
      created += 1;
    }
  } else if (collider.type === "box") {
    const hx = Number(collider.params.halfWidth) || fallbackBounds.width * 0.5;
    const hy = Number(collider.params.halfHeight) || fallbackBounds.height * 0.5;
    const hz = Number(collider.params.halfDepth) || fallbackBounds.depth * 0.5;
    const desc = rapier.ColliderDesc.cuboid(
      Math.max(0.001, hx),
      Math.max(0.001, hy),
      Math.max(0.001, hz)
    )
      .setFriction(options.friction)
      .setRestitution(options.restitution)
      .setMass(options.mass);
    world.createCollider(desc, body);
    created += 1;
  }

  if (created <= 0) {
    const desc = rapier.ColliderDesc.cuboid(
      Math.max(0.05, fallbackBounds.width * 0.5),
      Math.max(0.05, fallbackBounds.height * 0.5),
      Math.max(0.05, fallbackBounds.depth * 0.5)
    )
      .setFriction(options.friction)
      .setRestitution(options.restitution)
      .setMass(options.mass);
    world.createCollider(desc, body);
    created = 1;
  }
  return created;
}

// ---------------------------------------------------------------------------
// Hook
// ---------------------------------------------------------------------------

export function usePhysicsSimulation(options: {
  refs: ForgeRuntimeRefs;
  physicsSelectedPropId: string | null;
  physicsSelectedColliderPresetId: string | null;
  physicsColliderResults: ForgeColliderResultEntry[];
  physicsSettings: PropPhysicsSettings;
  physicsBBox: BBox | null;
  physicsModelRevision: number;
  setSimPixelModels: React.Dispatch<
    React.SetStateAction<Record<PhysicsPreviewScenario, THREE.Group | null>>
  >;
  setSimStatus: (scenario: PhysicsPreviewScenario, text: string) => void;
}): void {
  const {
    refs,
    physicsSelectedPropId,
    physicsSelectedColliderPresetId,
    physicsColliderResults,
    physicsSettings,
    physicsBBox,
    physicsModelRevision,
    setSimPixelModels,
    setSimStatus,
  } = options;

  // Use a ref for physicsBBox so the simulation doesn't restart when only
  // the model changes (SET_PHYSICS_BBOX). The sim only needs the bbox for
  // mass calculation which reads the latest value via the ref.
  const physicsBBoxRef = useRef(physicsBBox);
  physicsBBoxRef.current = physicsBBox;

  useEffect(() => {
    const sourceModel = refs.physicsSimSourceModel.current;
    if (!physicsSelectedPropId || !sourceModel) {
      for (const scenario of PHYSICS_SCENARIOS) {
        setSimStatus(scenario, "Load a prop to preview physics scenarios.");
      }
      return;
    }

    const selectedCollider = physicsColliderResults.find(
      (e) => e.presetId === physicsSelectedColliderPresetId
    );
    if (!selectedCollider) {
      for (const scenario of PHYSICS_SCENARIOS) {
        setSimStatus(scenario, "Compute/select a collider preset to run the drop tests.");
      }
      return;
    }

    let disposed = false;
    const worldsForCleanup: any[] = [];

    void (async () => {
      try {
        const rapier = await ensureRapier3d();
        if (disposed) return;

        const fallbackBounds = computeBBox(sourceModel);
        const mass = resolveForgeMass(physicsSettings, physicsBBoxRef.current);
        const friction = clamp(physicsSettings.friction, 0, 2);
        const restitution = clamp(physicsSettings.restitution, 0, 1);
        // Seed sim cameras: on first setup clone the mesh viewport's full
        // view state (distance, target, yaw, pitch) so they look the same.
        // On subsequent restarts preserve whatever the user set per-scenario.
        const isFirstSetup = !refs.physicsSimMeshViewState.current;
        if (isFirstSetup) {
          const meshVs = refs.physicsMeshViewport.current?.getViewState() ??
            refs.physicsViewState.current;
          if (meshVs) {
            refs.physicsSimMeshViewState.current = { ...meshVs };
          }
          // Shift target up so the ground plane (y=0) sits at ~1/3 from the
          // bottom of the viewport on first load.
          if (refs.physicsSimMeshViewState.current) {
            const vs = refs.physicsSimMeshViewState.current;
            const d = vs.distance;
            // visibleHeight = 2 * d * tan(fov/2); fov=45° → tan(22.5°)
            // shift = visibleHeight * (1/2 - 1/3) = visibleHeight / 6
            const yShift = (2 * d * Math.tan(Math.PI / 8)) / 6;
            vs.target = [vs.target[0], yShift, vs.target[2]];
          }
        }

        for (const scenario of PHYSICS_SCENARIOS) {
          // On first setup use the shifted seed; on restarts preserve the
          // user's current sim camera (captured before setModel resets it).
          const prevViewState = isFirstSetup
            ? null
            : refs.physicsSimMeshViewports.current[scenario]?.getViewState();

          const simVisual = createScenarioVisuals(
            deepCloneWithMaterials(sourceModel),
            scenario
          );
          refs.physicsSimDynamicMeshes.current[scenario] = simVisual.meshDynamic;

          refs.physicsSimMeshViewports.current[scenario]?.setModel(simVisual.meshRoot);
          const restoreState = prevViewState ?? refs.physicsSimMeshViewState.current;
          if (restoreState) {
            refs.physicsSimMeshViewports.current[scenario]?.setViewState(restoreState);
          }

          setSimPixelModels((prev) => ({ ...prev, [scenario]: simVisual.pixelRoot }));

          const world = new rapier.World({ x: 0, y: -9.81, z: 0 });
          worldsForCleanup.push(world);

          // Floor
          createStaticBody(rapier, world, {
            translation: new THREE.Vector3(0, -0.05, 0),
            halfExtents: new THREE.Vector3(7, 0.05, 7),
            friction,
            restitution,
          });

          // Scenario-specific geometry
          if (scenario === "slope30Drop") {
            createStaticBody(rapier, world, {
              translation: new THREE.Vector3(0.8, 0.55, 0),
              halfExtents: new THREE.Vector3(1.6, 0.08, 1.1),
              quaternion: new THREE.Quaternion().setFromEuler(
                new THREE.Euler(0, 0, -Math.PI / 6)
              ),
              friction,
              restitution,
            });
          } else if (scenario === "edgeDrop") {
            createStaticBody(rapier, world, {
              translation: new THREE.Vector3(0, 0.5, 0),
              halfExtents: new THREE.Vector3(0.5, 0.5, 0.5),
              friction,
              restitution,
            });
          }

          // Dynamic body
          const bodyDesc = rapier.RigidBodyDesc.dynamic().setTranslation(
            simVisual.spawnPosition.x,
            simVisual.spawnPosition.y,
            simVisual.spawnPosition.z
          );
          bodyDesc.setRotation({
            x: simVisual.spawnQuaternion.x,
            y: simVisual.spawnQuaternion.y,
            z: simVisual.spawnQuaternion.z,
            w: simVisual.spawnQuaternion.w,
          });
          const body = world.createRigidBody(bodyDesc);
          body.setLinearDamping(physicsSettings.linearDamping);
          body.setAngularDamping(physicsSettings.angularDamping);
          body.enableCcd(true);

          attachDynamicColliderFromParams(
            rapier,
            world,
            body,
            selectedCollider.collider,
            fallbackBounds,
            { mass, friction, restitution }
          );

          // Simulation loop state
          let accumulator = 0;
          let lastTime = performance.now();
          let elapsed = 0;
          let maxLinearSpeed = 0;
          let maxAngularSpeed = 0;
          let settledFor = 0;
          let autoReplayCount = 0;

          const resetBody = (reason: string) => {
            body.setTranslation(
              {
                x: simVisual.spawnPosition.x,
                y: simVisual.spawnPosition.y,
                z: simVisual.spawnPosition.z,
              },
              true
            );
            body.setRotation(
              {
                x: simVisual.spawnQuaternion.x,
                y: simVisual.spawnQuaternion.y,
                z: simVisual.spawnQuaternion.z,
                w: simVisual.spawnQuaternion.w,
              },
              true
            );
            body.setLinvel({ x: 0, y: 0, z: 0 }, true);
            body.setAngvel({ x: 0, y: 0, z: 0 }, true);
            body.resetForces(true);
            body.resetTorques(true);

            refs.physicsSimMetrics.current[scenario] = {
              durationSeconds: elapsed,
              maxLinearSpeed,
              maxAngularSpeed,
              settled: settledFor > 0.4,
            };

            elapsed = 0;
            maxLinearSpeed = 0;
            maxAngularSpeed = 0;
            settledFor = 0;
            autoReplayCount += 1;
            setSimStatus(
              scenario,
              `${PHYSICS_SCENARIO_LABELS[scenario]} auto-replay #${autoReplayCount} (${reason}) · collider: ${selectedCollider.presetName}`
            );
          };

          const updateVisuals = () => {
            const t = body.translation();
            const r = body.rotation();
            const dynMesh = refs.physicsSimDynamicMeshes.current[scenario];
            if (dynMesh) {
              dynMesh.position.set(t.x, t.y, t.z);
              dynMesh.quaternion.set(r.x, r.y, r.z, r.w);
              dynMesh.updateMatrixWorld(true);
            }
            refs.physicsSimPixelQuads.current[scenario]?.setNamedObjectTransform(
              "sim-body",
              {
                position: [t.x, t.y, t.z],
                quaternion: [r.x, r.y, r.z, r.w],
              }
            );
          };

          updateVisuals();
          setSimStatus(
            scenario,
            `${PHYSICS_SCENARIO_LABELS[scenario]} running · auto-replay enabled · collider: ${selectedCollider.presetName}`
          );

          const FIXED_DT = 1 / 60;
          const MAX_STEPS = 8;
          const AUTO_REPLAY_SECONDS = 3.2;

          const frame = (now: number) => {
            if (disposed) return;

            let dt = (now - lastTime) / 1000;
            lastTime = now;
            if (!Number.isFinite(dt) || dt < 0) dt = 0;
            dt = Math.min(dt, 0.1);
            accumulator += dt;

            let steps = 0;
            while (accumulator >= FIXED_DT && steps < MAX_STEPS) {
              world.step();
              accumulator -= FIXED_DT;
              elapsed += FIXED_DT;
              steps += 1;

              const lv = body.linvel();
              const av = body.angvel();
              const linSpeed = Math.hypot(lv.x, lv.y, lv.z);
              const angSpeed = Math.hypot(av.x, av.y, av.z);
              if (linSpeed > maxLinearSpeed) maxLinearSpeed = linSpeed;
              if (angSpeed > maxAngularSpeed) maxAngularSpeed = angSpeed;

              if (linSpeed < 0.05 && angSpeed < 0.08 && elapsed > 0.4) {
                settledFor += FIXED_DT;
              } else {
                settledFor = 0;
              }
            }

            updateVisuals();

            const t = body.translation();
            const shouldReplay =
              elapsed >= AUTO_REPLAY_SECONDS ||
              settledFor >= 0.5 ||
              t.y < -3;
            if (shouldReplay) {
              resetBody(
                t.y < -3
                  ? "fell below floor"
                  : settledFor >= 0.5
                    ? "settled"
                    : "timeout"
              );
              updateVisuals();
            }

            refs.physicsSimLoopRafs.current[scenario] = requestAnimationFrame(frame);
          };

          refs.physicsSimLoopRafs.current[scenario] = requestAnimationFrame(frame);
        }
      } catch (err) {
        if (!disposed) {
          const message = `Physics preview failed: ${err instanceof Error ? err.message : "unknown error"}`;
          for (const scenario of PHYSICS_SCENARIOS) {
            setSimStatus(scenario, message);
          }
        }
      }
    })();

    return () => {
      disposed = true;
      for (const scenario of PHYSICS_SCENARIOS) {
        cancelAnimationFrame(refs.physicsSimLoopRafs.current[scenario]);
        refs.physicsSimLoopRafs.current[scenario] = 0;
        refs.physicsSimDynamicMeshes.current[scenario] = null;
      }
      for (const world of worldsForCleanup) {
        if (world && typeof world.free === "function") {
          world.free();
        }
      }
    };
    // physicsBBox intentionally omitted — read via ref so model changes don't
    // restart the simulation. physicsModelRevision is included so the sim
    // restarts when mesh settings change (debounced from the controller).
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [
    physicsColliderResults,
    physicsModelRevision,
    physicsSelectedPropId,
    physicsSelectedColliderPresetId,
    physicsSettings,
  ]);
}
