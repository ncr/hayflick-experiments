import type { EditorHud } from "./editor-hud";

export type PromotedEditorToolMode = "draw" | "erase";
export type PromotedEditorBrush =
  | "wall"
  | "window"
  | "door-closed"
  | "door-open"
  | "floor"
  | "grass"
  | "road"
  | "sidewalk";
export type PromotedEditorRectToolMode =
  | "none"
  | "grass-fill"
  | "building-footprint";
export type PromotedEditorDefaultGround = "floor" | "grass";

export type PromotedEditorControls = {
  toolButtons: Map<PromotedEditorToolMode, HTMLButtonElement>;
  brushButtons: Map<PromotedEditorBrush, HTMLButtonElement>;
  rectToolButtons: Map<
    Exclude<PromotedEditorRectToolMode, "none">,
    HTMLButtonElement
  >;
  defaultGroundButtons: Map<PromotedEditorDefaultGround, HTMLButtonElement>;
  rectOffButton: HTMLButtonElement;
  seedInput: HTMLInputElement;
};

export type CreatePromotedEditorControlsOptions = {
  hud: Pick<EditorHud, "createRow" | "createButton" | "hints">;
  initialSeed: number;
  onTool(mode: PromotedEditorToolMode): void;
  onBrush(brush: PromotedEditorBrush): void;
  onRectTool(mode: PromotedEditorRectToolMode): void;
  onDefaultGround(base: PromotedEditorDefaultGround): void;
  onSeed(seed: number): void;
  onRotate(deltaQuarterTurns: -1 | 1): void;
  onResetView(): void;
  onClearStructures(): void;
  onClearGround(): void;
  onBake(): void;
  onExit?(): void;
};

export function createPromotedEditorControls(
  options: CreatePromotedEditorControlsOptions
): PromotedEditorControls {
  const makeRow = options.hud.createRow;
  const makeButton = options.hud.createButton;

  const toolButtons = new Map<PromotedEditorToolMode, HTMLButtonElement>();
  const brushButtons = new Map<PromotedEditorBrush, HTMLButtonElement>();
  const rectToolButtons = new Map<
    Exclude<PromotedEditorRectToolMode, "none">,
    HTMLButtonElement
  >();
  const defaultGroundButtons = new Map<
    PromotedEditorDefaultGround,
    HTMLButtonElement
  >();

  const modeRow = makeRow("Mode");
  const exitButton = makeButton("EXIT (F5)", () => {
    options.onExit?.();
  });
  modeRow.append(exitButton);

  const toolRow = makeRow("Tool");
  const drawButton = makeButton("Draw (D)", () => {
    options.onTool("draw");
  });
  const eraseButton = makeButton("Erase (X)", () => {
    options.onTool("erase");
  });
  toolButtons.set("draw", drawButton);
  toolButtons.set("erase", eraseButton);
  toolRow.append(drawButton, eraseButton);

  const brushRow = makeRow("Brush");
  const wallBrushButton = makeButton("Wall (1)", () => {
    options.onBrush("wall");
  });
  const windowBrushButton = makeButton("Window (2)", () => {
    options.onBrush("window");
  });
  const doorClosedBrushButton = makeButton("Door Closed (3)", () => {
    options.onBrush("door-closed");
  });
  const doorOpenBrushButton = makeButton("Door Open (6)", () => {
    options.onBrush("door-open");
  });
  const floorBrushButton = makeButton("Floor (4)", () => {
    options.onBrush("floor");
  });
  const grassBrushButton = makeButton("Grass (5)", () => {
    options.onBrush("grass");
  });
  const roadBrushButton = makeButton("Road (7)", () => {
    options.onBrush("road");
  });
  const sidewalkBrushButton = makeButton("Sidewalk (8)", () => {
    options.onBrush("sidewalk");
  });

  brushButtons.set("wall", wallBrushButton);
  brushButtons.set("window", windowBrushButton);
  brushButtons.set("door-closed", doorClosedBrushButton);
  brushButtons.set("door-open", doorOpenBrushButton);
  brushButtons.set("floor", floorBrushButton);
  brushButtons.set("grass", grassBrushButton);
  brushButtons.set("road", roadBrushButton);
  brushButtons.set("sidewalk", sidewalkBrushButton);

  brushRow.append(
    wallBrushButton,
    windowBrushButton,
    doorClosedBrushButton,
    doorOpenBrushButton,
    floorBrushButton,
    grassBrushButton,
    roadBrushButton,
    sidewalkBrushButton
  );

  const rectRow = makeRow("Rect");
  const rectOffButton = makeButton("Rect Off", () => {
    options.onRectTool("none");
  });
  const grassRectButton = makeButton("Grass Fill (G)", () => {
    options.onRectTool("grass-fill");
  });
  const buildingRectButton = makeButton("Footprint (9)", () => {
    options.onRectTool("building-footprint");
  });
  rectToolButtons.set("grass-fill", grassRectButton);
  rectToolButtons.set("building-footprint", buildingRectButton);
  rectRow.append(rectOffButton, grassRectButton, buildingRectButton);

  const terrainRow = makeRow("Terrain");
  const defaultFloorButton = makeButton("Default Floor", () => {
    options.onDefaultGround("floor");
  });
  const defaultGrassButton = makeButton("Default Grass", () => {
    options.onDefaultGround("grass");
  });
  defaultGroundButtons.set("floor", defaultFloorButton);
  defaultGroundButtons.set("grass", defaultGrassButton);

  const seedWrap = document.createElement("label");
  seedWrap.style.display = "inline-flex";
  seedWrap.style.alignItems = "center";
  seedWrap.style.gap = "4px";
  seedWrap.style.fontSize = "12px";
  seedWrap.style.padding = "0 2px";
  seedWrap.textContent = "Seed";

  const seedInput = document.createElement("input");
  seedInput.type = "number";
  seedInput.value = String(options.initialSeed);
  seedInput.step = "1";
  seedInput.style.width = "84px";
  seedInput.style.border = "1px solid rgba(124, 155, 178, 0.62)";
  seedInput.style.background = "rgba(20, 35, 49, 0.92)";
  seedInput.style.color = "#d8e8f4";
  seedInput.style.borderRadius = "6px";
  seedInput.style.padding = "3px 6px";
  seedInput.style.fontSize = "12px";
  seedInput.addEventListener("change", () => {
    const parsed = Number(seedInput.value);
    const normalized = Number.isFinite(parsed) ? Math.floor(parsed) : 1337;
    seedInput.value = String(normalized);
    options.onSeed(normalized);
  });
  seedWrap.appendChild(seedInput);
  terrainRow.append(defaultFloorButton, defaultGrassButton, seedWrap);

  const cameraRow = makeRow("Camera");
  const rotateLeftButton = makeButton("Rotate -90 (Q)", () => {
    options.onRotate(-1);
  });
  const rotateRightButton = makeButton("Rotate +90 (E)", () => {
    options.onRotate(1);
  });
  const resetViewButton = makeButton("Reset View", () => {
    options.onResetView();
  });
  cameraRow.append(rotateLeftButton, rotateRightButton, resetViewButton);

  const utilityRow = makeRow("Scene");
  const clearStructuresButton = makeButton("Clear Walls (C)", () => {
    options.onClearStructures();
  });
  const clearGroundButton = makeButton("Clear Ground (V)", () => {
    options.onClearGround();
  });
  utilityRow.append(clearStructuresButton, clearGroundButton);

  const bakeRow = makeRow("Bake");
  const bakeButton = makeButton("Bake ECS JSON (B)", () => {
    options.onBake();
  });
  bakeRow.append(bakeButton);

  options.hud.hints.textContent =
    "LMB drag: paint  •  Shift+drag: grass fill rect  •  G: grass rect  •  9: footprint rect  •  7/8: road/sidewalk  •  B: bake  •  EXIT (F5): game mode";

  return {
    toolButtons,
    brushButtons,
    rectToolButtons,
    defaultGroundButtons,
    rectOffButton,
    seedInput
  };
}
