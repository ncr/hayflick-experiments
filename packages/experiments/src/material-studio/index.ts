import { createRoot, type Root } from "react-dom/client";
import { createElement } from "react";
import type { ExperimentModule } from "../runtime/types";
import { App } from "./App";
import "./styles/material-studio.css";

const experiment: ExperimentModule = {
  id: "material-studio",
  title: "Material Studio",
  tags: ["editor", "tileset", "pbr", "texture", "ai"],

  async init(ctx) {
    const { mount } = ctx;
    mount.style.position = "relative";
    const host = document.createElement("div");
    host.style.cssText = "position:absolute;inset:0;";
    mount.appendChild(host);

    const root: Root = createRoot(host);
    root.render(createElement(App));

    return () => {
      root.unmount();
      host.remove();
    };
  },
};

export default experiment;
