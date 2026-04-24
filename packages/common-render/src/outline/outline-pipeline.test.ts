import * as THREE from "three";
import { describe, expect, it, vi } from "vitest";
import { OutlinePipeline } from "./outline-pipeline";

function makeHost() {
  let lowTarget = new THREE.WebGLRenderTarget(16, 16);
  const originalLowTarget = lowTarget;
  const host = {
    camera: new THREE.OrthographicCamera(-1, 1, 1, -1, 0.1, 100),
    renderer: {
      readRenderTargetPixels: vi.fn()
    } as unknown as THREE.WebGLRenderer,
    beforeSceneRender: null as
      | ((renderer: THREE.WebGLRenderer, lowTarget: THREE.WebGLRenderTarget) => void)
      | null,
    afterSceneRender: null as
      | ((renderer: THREE.WebGLRenderer, lowTarget: THREE.WebGLRenderTarget) => void)
      | null,
    getLowTarget: vi.fn(() => lowTarget),
    setLowTarget: vi.fn(
      (
        target: THREE.WebGLRenderTarget,
        _options?: { disposePrevious?: boolean }
      ) => {
        lowTarget = target;
      }
    ),
    setOutputSourceTexture: vi.fn((_texture: THREE.Texture | null) => {})
  };
  return {
    host,
    get lowTarget() {
      return lowTarget;
    },
    originalLowTarget
  };
}

function makeRenderer(options: { throwOnRenderCall?: number } = {}) {
  let renderCalls = 0;
  return {
    toneMapping: THREE.NoToneMapping,
    setRenderTarget: vi.fn(),
    setClearColor: vi.fn(),
    clear: vi.fn(),
    render: vi.fn(() => {
      renderCalls += 1;
      if (renderCalls === options.throwOnRenderCall) {
        throw new Error(`render ${renderCalls}`);
      }
    })
  } as unknown as THREE.WebGLRenderer;
}

describe("OutlinePipeline", () => {
  it("restores the original low target on dispose", () => {
    const scene = new THREE.Scene();
    const { host, originalLowTarget, lowTarget: initialLowTarget } = makeHost();
    const disposeSpy = vi.spyOn(originalLowTarget, "dispose");

    const pipeline = new OutlinePipeline({
      view: host as any,
      scene,
      clearColor: 0x000000,
      clearAlpha: 1
    });

    expect(host.setLowTarget.mock.calls[0]?.[0]).not.toBe(initialLowTarget);
    expect(host.setLowTarget.mock.calls[0]?.[1]).toEqual({ disposePrevious: false });
    expect(disposeSpy).not.toHaveBeenCalled();

    pipeline.dispose();

    expect(host.setLowTarget).toHaveBeenLastCalledWith(originalLowTarget, {
      disposePrevious: false
    });
    expect(host.getLowTarget()).toBe(originalLowTarget);
  });

  it("restores mesh materials and renderer tone mapping if an auxiliary pass throws", () => {
    const scene = new THREE.Scene();
    const originalMaterial = new THREE.MeshBasicMaterial({ color: 0xff0000 });
    const mesh = new THREE.Mesh(new THREE.BoxGeometry(1, 1, 1), originalMaterial);
    scene.add(mesh);

    const { host, lowTarget } = makeHost();
    const pipeline = new OutlinePipeline({
      view: host as any,
      scene,
      clearColor: 0x000000,
      clearAlpha: 1
    });
    pipeline.assignOutlineGroup(mesh, "wall");

    const renderer = makeRenderer({ throwOnRenderCall: 4 });
    host.beforeSceneRender?.(renderer, lowTarget);

    expect(() => host.afterSceneRender?.(renderer, lowTarget)).toThrow("render 4");

    expect(mesh.material).toBe(originalMaterial);
    expect(renderer.toneMapping).toBe(THREE.NoToneMapping);

    pipeline.dispose();
    originalMaterial.dispose();
    mesh.geometry.dispose();
  });
});
