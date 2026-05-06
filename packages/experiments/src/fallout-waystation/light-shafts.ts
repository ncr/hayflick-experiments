import * as THREE from "three";
import { PALETTE } from "./palette";
import type { BuildingHandles } from "./building";

// God-ray shafts. We don't have a volumetric post-pass — instead, build
// each shaft as a single tapered quad with an additive shader. The quad is
// re-aimed every frame so its NORMAL points at the camera, which makes the
// shaft read as a soft column rather than a piece of geometry. With a fixed
// iso camera the per-frame cost is negligible (one lookAt per shaft).
//
// The fragment shader fades the shaft from full intensity at the source
// (top of the quad) to nothing at the tip, with a soft horizontal falloff
// so the edges read as gauzy rather than hard pixels.

const VERT = /* glsl */ `
  varying vec2 vUv;
  void main() {
    vUv = uv;
    gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
  }
`;

const FRAG = /* glsl */ `
  precision mediump float;
  varying vec2 vUv;
  uniform vec3 uColor;
  uniform float uIntensity;
  uniform float uFalloff;
  void main() {
    // vUv.x: 0..1 across the quad; soft cosine falloff to the edges.
    float lateralEdge = abs(vUv.x - 0.5) * 2.0;
    float lateral = pow(1.0 - smoothstep(0.0, 1.0, lateralEdge), 1.5);
    // vUv.y: 0 at top (window), 1 at bottom (floor).
    float vertical = pow(1.0 - vUv.y, uFalloff);
    float a = lateral * vertical * uIntensity;
    gl_FragColor = vec4(uColor * a, a);
  }
`;

function createShaftMaterial(
  color: number,
  intensity: number,
  falloff: number
): THREE.ShaderMaterial {
  return new THREE.ShaderMaterial({
    uniforms: {
      uColor: { value: new THREE.Color(color) },
      uIntensity: { value: intensity },
      uFalloff: { value: falloff }
    },
    vertexShader: VERT,
    fragmentShader: FRAG,
    transparent: true,
    blending: THREE.AdditiveBlending,
    depthWrite: false,
    side: THREE.DoubleSide,
    fog: false
  });
}

/**
 * Tapered quad: top edge at y=0 with width `topWidth`, bottom edge at
 * y=-length with width `bottomWidth`. Lies in the local XY plane with
 * normal +Z so `mesh.lookAt(camera.position)` orients the quad to face
 * the camera while the shaft length axis stays roughly downward.
 */
function createShaftGeometry(
  topWidth: number,
  bottomWidth: number,
  length: number
): THREE.BufferGeometry {
  const g = new THREE.BufferGeometry();
  const verts = new Float32Array([
    -topWidth / 2, 0, 0,
    topWidth / 2, 0, 0,
    -bottomWidth / 2, -length, 0,
    bottomWidth / 2, -length, 0
  ]);
  const uvs = new Float32Array([0, 0, 1, 0, 0, 1, 1, 1]);
  g.setAttribute("position", new THREE.BufferAttribute(verts, 3));
  g.setAttribute("uv", new THREE.BufferAttribute(uvs, 2));
  g.setIndex([0, 1, 2, 1, 3, 2]);
  g.computeVertexNormals();
  return g;
}

export type ShaftHandle = {
  group: THREE.Group;
  /** Each shaft mesh — `aimAtCamera()` rotates each one to face the cam. */
  meshes: THREE.Mesh[];
  /** All shaft materials so the GUI can adjust intensity/color uniformly. */
  materials: THREE.ShaderMaterial[];
  /** Call once per frame with the iso camera. */
  aimAtCamera(camera: THREE.Camera): void;
};

export function createLightShafts(
  building: BuildingHandles
): ShaftHandle {
  const group = new THREE.Group();
  group.name = "light-shafts";
  const meshes: THREE.Mesh[] = [];
  const materials: THREE.ShaderMaterial[] = [];

  const placeShaft = (
    origin: THREE.Vector3,
    opts: {
      topWidth: number;
      bottomWidth: number;
      length: number;
      intensity: number;
      falloff: number;
    }
  ): void => {
    const geom = createShaftGeometry(opts.topWidth, opts.bottomWidth, opts.length);
    const mat = createShaftMaterial(PALETTE.shaftColor, opts.intensity, opts.falloff);
    materials.push(mat);
    const mesh = new THREE.Mesh(geom, mat);
    mesh.position.copy(origin);
    mesh.renderOrder = 10;
    meshes.push(mesh);
    group.add(mesh);
  };

  // One shaft per exterior window. The quad's TOP edge sits in the window;
  // gravity-style downward extension reaches the floor, so window-shaped
  // pools of light read as the bottom of each shaft when paired with the
  // shadow-mapped sunlit pool from the layer-1 wall.
  for (const spec of building.windowSpecs) {
    if (!spec.exterior) continue;
    const origin = spec.center
      .clone()
      .addScaledVector(spec.normal, -0.05)
      .add(new THREE.Vector3(0, 0.45, 0));
    const width = Math.max(0.35, spec.width * 0.7);
    placeShaft(origin, {
      topWidth: width,
      bottomWidth: width * 1.6,
      length: 4.5,
      intensity: 0.5,
      falloff: 1.6
    });
  }

  // The roof-hole shaft over Room C — the dramatic centerpiece. Wider, a
  // bit more intense.
  placeShaft(
    building.roofHoleCenter.clone().add(new THREE.Vector3(0, -0.05, 0)),
    {
      topWidth: building.roofHoleSize.width * 0.85,
      bottomWidth: building.roofHoleSize.width * 1.25,
      length: 3.6,
      intensity: 0.7,
      falloff: 1.3
    }
  );

  const aimAtCamera = (camera: THREE.Camera): void => {
    for (const mesh of meshes) {
      mesh.lookAt(camera.position);
    }
  };

  return { group, meshes, materials, aimAtCamera };
}
