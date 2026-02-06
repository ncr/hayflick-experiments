#!/usr/bin/env node
import fs from "node:fs";
import path from "node:path";

const rawId = process.argv[2];

if (!rawId) {
  console.error("Usage: pnpm exp:new <experiment-id>");
  process.exit(1);
}

if (!/^[a-z0-9-]+$/.test(rawId)) {
  console.error("Experiment id must contain only lowercase letters, numbers, and hyphens.");
  process.exit(1);
}

const toTitle = (id) =>
  id
    .split("-")
    .filter(Boolean)
    .map((part) => part[0].toUpperCase() + part.slice(1))
    .join(" ");

const toSymbol = (id) => {
  const core = id.replace(/-([a-z0-9])/g, (_, c) => c.toUpperCase());
  if (/^[a-zA-Z_$]/.test(core)) {
    return core;
  }
  return `exp${core[0].toUpperCase()}${core.slice(1)}`;
};

const root = process.cwd();
const experimentDir = path.join(root, "packages/experiments/src", rawId);

if (fs.existsSync(experimentDir)) {
  console.error(`Experiment already exists: ${rawId}`);
  process.exit(1);
}

fs.mkdirSync(path.join(experimentDir, "shaders"), { recursive: true });

const title = toTitle(rawId);
const today = new Date().toISOString().slice(0, 10);

fs.writeFileSync(
  path.join(experimentDir, "meta.ts"),
  `import type { ExperimentMeta } from "../runtime/meta";\n\nexport const meta: ExperimentMeta = {\n  id: "${rawId}",\n  title: "${title}",\n  description: "TODO: describe this experiment.",\n  tags: ["threejs"],\n  status: "draft",\n  updatedAt: "${today}"\n};\n`
);

fs.writeFileSync(
  path.join(experimentDir, "shaders", "vertex.glsl"),
  "varying vec2 vUv;\n\nvoid main() {\n  vUv = uv;\n  gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);\n}\n"
);

fs.writeFileSync(
  path.join(experimentDir, "shaders", "fragment.glsl"),
  "varying vec2 vUv;\nuniform float uTime;\n\nvoid main() {\n  vec3 color = vec3(vUv, 0.5 + 0.5 * sin(uTime));\n  gl_FragColor = vec4(color, 1.0);\n}\n"
);

fs.writeFileSync(
  path.join(experimentDir, "index.ts"),
  `import * as THREE from "three";\nimport { makeRenderer } from "@common/render";\nimport fragmentShader from "./shaders/fragment.glsl";\nimport vertexShader from "./shaders/vertex.glsl";\nimport type { ExperimentModule } from "../runtime/types";\n\nconst experiment: ExperimentModule = {\n  id: "${rawId}",\n  title: "${title}",\n  tags: ["threejs"],\n  init: ({ mount, width, height, dpr }) => {\n    const scene = new THREE.Scene();\n    const camera = new THREE.PerspectiveCamera(45, width / height, 0.1, 100);\n    camera.position.z = 1.3;\n\n    const renderer = makeRenderer(width, height, dpr);\n    mount.appendChild(renderer.domElement);\n\n    const geometry = new THREE.PlaneGeometry(2, 2);\n    const material = new THREE.ShaderMaterial({\n      uniforms: { uTime: { value: 0 } },\n      vertexShader,\n      fragmentShader\n    });\n\n    const mesh = new THREE.Mesh(geometry, material);\n    scene.add(mesh);\n\n    let raf = 0;\n    const start = performance.now();\n\n    const render = () => {\n      material.uniforms.uTime.value = (performance.now() - start) / 1000;\n      renderer.render(scene, camera);\n      raf = requestAnimationFrame(render);\n    };\n\n    render();\n\n    return () => {\n      cancelAnimationFrame(raf);\n      scene.remove(mesh);\n      geometry.dispose();\n      material.dispose();\n      renderer.dispose();\n      renderer.domElement.remove();\n    };\n  }\n};\n\nexport default experiment;\n`
);

fs.writeFileSync(
  path.join(experimentDir, "README.md"),
  `# ${title}\n\n## Goal\nTODO\n\n## Notes\n- Scaffolded with default Three.js shader loop template.\n`
);

const registryPath = path.join(root, "packages/experiments/src/registry.ts");
const registry = fs.readFileSync(registryPath, "utf8");
const symbol = toSymbol(rawId);

const importLine = `import { meta as ${symbol}Meta } from "./${rawId}/meta";`;
const entry = `  {\n    ...${symbol}Meta,\n    load: () => import("./${rawId}/index")\n  },`;

const next = registry
  .replace("// AUTO_IMPORTS_END", `${importLine}\n// AUTO_IMPORTS_END`)
  .replace("// AUTO_ENTRIES_START", `// AUTO_ENTRIES_START\n${entry}`);

fs.writeFileSync(registryPath, next);

console.log(`Created experiment: ${rawId}`);
