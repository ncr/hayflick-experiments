import * as THREE from "three";

export type EditorStructureDoorState = "open" | "closed";

export type EditorDoorVisual = {
  root: THREE.Group;
  leafPivot: THREE.Group;
};

type EditorStructureMaterials = {
  wall: THREE.MeshToonMaterial;
  accent: THREE.MeshToonMaterial;
  windowGlass: THREE.MeshToonMaterial;
  door: THREE.MeshToonMaterial;
  joint: THREE.MeshToonMaterial;
};

type EditorStructureGeometries = {
  wallCore: THREE.BoxGeometry;
  windowLower: THREE.BoxGeometry;
  windowUpper: THREE.BoxGeometry;
  windowGlass: THREE.PlaneGeometry;
  doorLeaf: THREE.BoxGeometry;
  jointColumn: THREE.BoxGeometry;
};

export type EditorStructureMeshKit = {
  createWallSegment: () => THREE.Group;
  createWallBlock: () => THREE.Group;
  createWindowSegment: () => THREE.Group;
  createDoorVisual: () => EditorDoorVisual;
  createDoorSegment: (state: EditorStructureDoorState) => THREE.Group;
  createJoinPost: (degree: number) => THREE.Group;
  dispose: () => void;
};

const WALL_HEIGHT = 2.8;
const WALL_THICKNESS = 0.18;
const WALL_BLOCK_EDGE_OFFSET = 0.4;
const WALL_BLOCK_CORNER_OFFSET = 0.5;

type StripeSpec = {
  color: number;
  center: number;
  height: number;
  smooth: number;
};

function makeGradientMap(bands: number): THREE.DataTexture {
  const steps = Math.max(2, bands);
  const data = new Uint8Array(steps * 4);

  for (let i = 0; i < steps; i += 1) {
    const t = i / (steps - 1);
    const value = Math.round((0.18 + t * 0.82) * 255);
    const offset = i * 4;
    data[offset] = value;
    data[offset + 1] = value;
    data[offset + 2] = value;
    data[offset + 3] = 255;
  }

  const gradient = new THREE.DataTexture(data, steps, 1, THREE.RGBAFormat);
  gradient.minFilter = THREE.NearestFilter;
  gradient.magFilter = THREE.NearestFilter;
  gradient.generateMipmaps = false;
  gradient.needsUpdate = true;
  return gradient;
}

function applyRetroDither(
  material: THREE.MeshToonMaterial,
  bands: number,
  strength: number,
  specularStrength: number,
  specularShininess: number,
  specularBands: number,
  specularDitherStrength: number,
  stripe?: StripeSpec
): void {
  material.dithering = false;
  material.onBeforeCompile = (shader) => {
    shader.uniforms.uToonDitherBands = { value: Math.max(2.0, bands) };
    shader.uniforms.uToonDitherStrength = { value: strength };
    shader.uniforms.uToonDitherPixelSize = { value: 4.0 };
    shader.uniforms.uSpecularStrength = { value: specularStrength };
    shader.uniforms.uSpecularShininess = { value: specularShininess };
    shader.uniforms.uSpecularBands = { value: Math.max(2.0, specularBands) };
    shader.uniforms.uSpecularDitherStrength = { value: specularDitherStrength };

    shader.fragmentShader = shader.fragmentShader.replace(
      "#include <gradientmap_pars_fragment>",
      `
      #ifdef USE_GRADIENTMAP
      uniform sampler2D gradientMap;
      #endif

      uniform float uToonDitherBands;
      uniform float uToonDitherStrength;
      uniform float uToonDitherPixelSize;
      uniform float uSpecularStrength;
      uniform float uSpecularShininess;
      uniform float uSpecularBands;
      uniform float uSpecularDitherStrength;

      float toonBayer4x4(vec2 p) {
        vec2 q = mod(floor(p), 4.0);
        float x = q.x;
        float y = q.y;
        if (y < 1.0) {
          if (x < 1.0) return 0.0;
          if (x < 2.0) return 8.0;
          if (x < 3.0) return 2.0;
          return 10.0;
        }
        if (y < 2.0) {
          if (x < 1.0) return 12.0;
          if (x < 2.0) return 4.0;
          if (x < 3.0) return 14.0;
          return 6.0;
        }
        if (y < 3.0) {
          if (x < 1.0) return 3.0;
          if (x < 2.0) return 11.0;
          if (x < 3.0) return 1.0;
          return 9.0;
        }
        if (x < 1.0) return 15.0;
        if (x < 2.0) return 7.0;
        if (x < 3.0) return 13.0;
        return 5.0;
      }

      vec3 getGradientIrradiance(vec3 normal, vec3 lightDirection) {
        float dotNL = clamp(dot(normal, lightDirection) * 0.5 + 0.5, 0.0, 1.0);
        float levels = max(2.0, uToonDitherBands);
        vec2 ditherCell = floor(gl_FragCoord.xy / max(1.0, uToonDitherPixelSize));
        float bayer = (toonBayer4x4(ditherCell) + 0.5) / 16.0 - 0.5;
        float dithered = clamp(dotNL + bayer * uToonDitherStrength, 0.0, 1.0);
        float quantized = floor(dithered * (levels - 1.0) + 0.5) / (levels - 1.0);

        #ifdef USE_GRADIENTMAP
          return vec3(texture2D(gradientMap, vec2(quantized, 0.0)).r);
        #else
          return vec3(quantized);
        #endif
      }
      `
    );

    shader.fragmentShader = shader.fragmentShader.replace(
      "#include <lights_toon_pars_fragment>",
      `
      varying vec3 vViewPosition;

      struct ToonMaterial {
        vec3 diffuseColor;
      };

      void RE_Direct_Toon( const in IncidentLight directLight, const in vec3 geometryPosition, const in vec3 geometryNormal, const in vec3 geometryViewDir, const in vec3 geometryClearcoatNormal, const in ToonMaterial material, inout ReflectedLight reflectedLight ) {
        vec3 irradiance = getGradientIrradiance( geometryNormal, directLight.direction ) * directLight.color;
        reflectedLight.directDiffuse += irradiance * BRDF_Lambert( material.diffuseColor );

        float ndl = max( dot( geometryNormal, directLight.direction ), 0.0 );
        vec3 halfDir = normalize( directLight.direction + geometryViewDir );
        float ndh = max( dot( geometryNormal, halfDir ), 0.0 );
        float specRaw = pow( ndh, max( 1.0, uSpecularShininess ) ) * ndl * uSpecularStrength;

        vec2 ditherCell = floor( gl_FragCoord.xy / max( 1.0, uToonDitherPixelSize ) );
        float bayer = ( toonBayer4x4( ditherCell ) + 0.5 ) / 16.0 - 0.5;
        float dithered = clamp( specRaw + bayer * uSpecularDitherStrength, 0.0, 1.0 );
        float levels = max( 2.0, uSpecularBands );
        float quantizedSpec = floor( dithered * ( levels - 1.0 ) + 0.5 ) / ( levels - 1.0 );

        vec3 specColor = mix( vec3( 1.0 ), material.diffuseColor, 0.2 );
        reflectedLight.directDiffuse += quantizedSpec * directLight.color * specColor;
      }

      void RE_IndirectDiffuse_Toon( const in vec3 irradiance, const in vec3 geometryPosition, const in vec3 geometryNormal, const in vec3 geometryViewDir, const in vec3 geometryClearcoatNormal, const in ToonMaterial material, inout ReflectedLight reflectedLight ) {
        reflectedLight.indirectDiffuse += irradiance * BRDF_Lambert( material.diffuseColor );
      }

      #define RE_Direct RE_Direct_Toon
      #define RE_IndirectDiffuse RE_IndirectDiffuse_Toon
      `
    );

    if (stripe) {
      shader.uniforms.uStripeColor = { value: new THREE.Color(stripe.color) };
      shader.uniforms.uStripeCenter = { value: stripe.center };
      shader.uniforms.uStripeHeight = { value: stripe.height };
      shader.uniforms.uStripeSmooth = { value: stripe.smooth };

      shader.vertexShader = shader.vertexShader.replace(
        "#include <common>",
        `#include <common>\nvarying vec3 vWorldPosition;`
      );
      shader.vertexShader = shader.vertexShader.replace(
        "#include <worldpos_vertex>",
        `#include <worldpos_vertex>\nvWorldPosition = worldPosition.xyz;`
      );
      shader.fragmentShader = shader.fragmentShader.replace(
        "#include <common>",
        `#include <common>\nuniform vec3 uStripeColor;\nuniform float uStripeCenter;\nuniform float uStripeHeight;\nuniform float uStripeSmooth;\nvarying vec3 vWorldPosition;`
      );
      shader.fragmentShader = shader.fragmentShader.replace(
        "vec4 diffuseColor = vec4( diffuse, opacity );",
        `vec4 diffuseColor = vec4( diffuse, opacity );\nfloat stripeLo = uStripeCenter - uStripeHeight * 0.5;\nfloat stripeHi = uStripeCenter + uStripeHeight * 0.5;\nfloat stripeMask = smoothstep(stripeLo - uStripeSmooth, stripeLo, vWorldPosition.y) * (1.0 - smoothstep(stripeHi, stripeHi + uStripeSmooth, vWorldPosition.y));\ndiffuseColor.rgb = mix(diffuseColor.rgb, uStripeColor, stripeMask);`
      );
    }
  };
  material.customProgramCacheKey = () =>
    `retroDither_b${bands.toFixed(2)}_s${strength.toFixed(3)}_spec${specularStrength.toFixed(3)}_sh${specularShininess.toFixed(2)}_sb${specularBands.toFixed(2)}_sd${specularDitherStrength.toFixed(3)}_${stripe ? `stripe_${stripe.center.toFixed(2)}_${stripe.height.toFixed(2)}` : "noStripe"}`;
  material.needsUpdate = true;
}

function createMaterials(): { materials: EditorStructureMaterials; gradients: THREE.DataTexture[] } {
  const gradients: THREE.DataTexture[] = [];
  const stripe: StripeSpec = {
    color: 0xc45a12,
    center: 1.2,
    height: 0.1,
    smooth: 0.02
  };

  const makeToon = (
    color: number,
    bands: number,
    ditherStrength: number,
    specularStrength: number,
    specularShininess: number,
    stripeSpec?: StripeSpec
  ) => {
    const gradientMap = makeGradientMap(bands);
    gradients.push(gradientMap);
    const material = new THREE.MeshToonMaterial({
      color,
      gradientMap,
      toneMapped: true
    });
    applyRetroDither(
      material,
      bands,
      ditherStrength,
      specularStrength,
      specularShininess,
      4,
      0.08,
      stripeSpec
    );
    return material;
  };

  const wallMaterial = makeToon(0xf5f7fb, 5, 0.06, 0.45, 64, stripe);
  const accentMaterial = makeToon(0xe8edf3, 5, 0.05, 0.35, 58, stripe);
  const doorMaterial = makeToon(0xf5f7fb, 5, 0.06, 0.48, 68, stripe);
  const jointMaterial = makeToon(0xf2f4f7, 5, 0.05, 0.4, 60, stripe);
  const glassGradient = makeGradientMap(4);
  gradients.push(glassGradient);
  const glassMaterial = new THREE.MeshToonMaterial({
    color: 0x92c8ff,
    gradientMap: glassGradient,
    transparent: true,
    opacity: 0.4,
    toneMapped: true
  });
  applyRetroDither(glassMaterial, 4, 0.04, 0.08, 18, 3, 0.04);

  return {
    materials: {
      wall: wallMaterial,
      accent: accentMaterial,
      windowGlass: glassMaterial,
      door: doorMaterial,
      joint: jointMaterial
    },
    gradients
  };
}

function createGeometries(): EditorStructureGeometries {
  return {
    wallCore: new THREE.BoxGeometry(1, WALL_HEIGHT, WALL_THICKNESS),
    windowLower: new THREE.BoxGeometry(1, 0.92, WALL_THICKNESS),
    windowUpper: new THREE.BoxGeometry(1, 0.92, WALL_THICKNESS),
    windowGlass: new THREE.PlaneGeometry(0.86, 0.86),
    doorLeaf: new THREE.BoxGeometry(0.88, 2.2, 0.08),
    jointColumn: new THREE.BoxGeometry(WALL_THICKNESS, WALL_HEIGHT, WALL_THICKNESS)
  };
}

export function setDoorVisualOpen(door: EditorDoorVisual, open: boolean): void {
  door.leafPivot.rotation.y = open ? -Math.PI * 0.5 : 0;
}

export function createEditorStructureMeshKit(): EditorStructureMeshKit {
  const { materials, gradients } = createMaterials();
  const geometries = createGeometries();

  const createWallSegment = (): THREE.Group => {
    const group = new THREE.Group();

    const core = new THREE.Mesh(geometries.wallCore, materials.wall);
    core.position.y = WALL_HEIGHT * 0.5;
    group.add(core);

    return group;
  };

  const createWindowSegment = (): THREE.Group => {
    const group = new THREE.Group();

    const lower = new THREE.Mesh(geometries.windowLower, materials.wall);
    lower.position.y = 0.46;
    group.add(lower);

    const upper = new THREE.Mesh(geometries.windowUpper, materials.wall);
    upper.position.y = WALL_HEIGHT - 0.46;
    group.add(upper);

    const glass = new THREE.Mesh(geometries.windowGlass, materials.windowGlass);
    glass.position.set(0, WALL_HEIGHT * 0.5, WALL_THICKNESS * 0.52);
    group.add(glass);

    return group;
  };

  const createDoorVisual = (): EditorDoorVisual => {
    const root = new THREE.Group();

    const leafPivot = new THREE.Group();
    leafPivot.position.set(-0.44, 0, 0);

    const leaf = new THREE.Mesh(geometries.doorLeaf, materials.door);
    leaf.position.set(0.44, 1.1, 0);
    leafPivot.add(leaf);

    root.add(leafPivot);

    return { root, leafPivot };
  };

  const createDoorSegment = (state: EditorStructureDoorState): THREE.Group => {
    const door = createDoorVisual();
    setDoorVisualOpen(door, state === "open");
    return door.root;
  };

  const createJoinPost = (degree: number): THREE.Group => {
    const group = new THREE.Group();

    const column = new THREE.Mesh(geometries.jointColumn, materials.joint);
    const scale = 1.02 + degree * 0.06;
    column.scale.x = scale;
    column.scale.z = scale;
    column.position.y = WALL_HEIGHT * 0.5;
    group.add(column);

    return group;
  };

  const createWallBlock = (): THREE.Group => {
    const group = new THREE.Group();

    const north = createWallSegment();
    north.position.z = -WALL_BLOCK_EDGE_OFFSET;
    group.add(north);

    const south = createWallSegment();
    south.position.z = WALL_BLOCK_EDGE_OFFSET;
    group.add(south);

    const east = createWallSegment();
    east.position.x = WALL_BLOCK_EDGE_OFFSET;
    east.rotation.y = Math.PI * 0.5;
    group.add(east);

    const west = createWallSegment();
    west.position.x = -WALL_BLOCK_EDGE_OFFSET;
    west.rotation.y = Math.PI * 0.5;
    group.add(west);

    const corners: Array<[number, number]> = [
      [-WALL_BLOCK_CORNER_OFFSET, -WALL_BLOCK_CORNER_OFFSET],
      [WALL_BLOCK_CORNER_OFFSET, -WALL_BLOCK_CORNER_OFFSET],
      [WALL_BLOCK_CORNER_OFFSET, WALL_BLOCK_CORNER_OFFSET],
      [-WALL_BLOCK_CORNER_OFFSET, WALL_BLOCK_CORNER_OFFSET]
    ];

    for (const [x, z] of corners) {
      const post = createJoinPost(2);
      post.position.set(x, 0, z);
      group.add(post);
    }

    return group;
  };

  const dispose = (): void => {
    Object.values(geometries).forEach((geometry) => geometry.dispose());
    Object.values(materials).forEach((material) => material.dispose());
    gradients.forEach((gradient) => gradient.dispose());
  };

  return {
    createWallSegment,
    createWallBlock,
    createWindowSegment,
    createDoorVisual,
    createDoorSegment,
    createJoinPost,
    dispose
  };
}
