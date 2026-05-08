import type { ExperimentModule } from "../runtime/types";
import { buildGui, loadConfig, type GuiCallbacks, type GuiHandle } from "./gui";
import { createWaystationLevel } from "./level";
import { WaystationRenderer } from "./renderer";
import { exampleWaystationLevel } from "./example-level";

const experiment: ExperimentModule = {
  id: "fallout-waystation",
  title: "Fallout Waystation",
  tags: ["threejs", "pixel-perfect", "iso", "lighting", "atmosphere"],
  init: async ({ mount, width, height }) => {
    const config = loadConfig();
    const renderer = new WaystationRenderer({ mount, width, height, config });
    const level = createWaystationLevel({
      renderer,
      config,
      definition: exampleWaystationLevel
    });

    const applyConfig = (): void => {
      renderer.applyConfig(config);
      level.applyConfig(config);
    };
    applyConfig();

    const guiCallbacks: GuiCallbacks = {
      onSunChange: applyConfig,
      onAmbientChange: applyConfig,
      onHemisphereChange: applyConfig,
      onFillChange: applyConfig,
      onFogChange: applyConfig,
      onShaftChange: applyConfig,
      onAOChange: applyConfig,
      onDustChange: applyConfig,
      onSmokeChange: applyConfig,
      onLampChange: applyConfig,
      onWindowGlowChange: applyConfig,
      onBackgroundChange: applyConfig,
      onResetDefaults: applyConfig
    };

    const gui: GuiHandle = buildGui(config, guiCallbacks);
    const unbindInput = renderer.bindInput();

    const observer = new ResizeObserver((entries) => {
      for (const entry of entries) {
        if (entry.contentRect.width > 0 && entry.contentRect.height > 0) {
          renderer.resize(entry.contentRect.width, entry.contentRect.height);
        }
      }
    });
    observer.observe(mount);

    let raf = 0;
    let prev = performance.now();
    const tick = (): void => {
      raf = requestAnimationFrame(tick);
      const now = performance.now();
      const dt = Math.min((now - prev) / 1000, 0.1);
      prev = now;

      level.step(dt);
      renderer.frame(now, dt);
    };
    tick();

    return () => {
      cancelAnimationFrame(raf);
      observer.disconnect();
      unbindInput();
      gui.destroy();
      level.dispose();
      renderer.dispose();
    };
  }
};

export default experiment;
