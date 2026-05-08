export type Viewport3dViewState = {
  target: [number, number, number];
  distance: number;
  yaw: number;
  pitch: number;
};

export type PixelViewportViewState = {
  target: [number, number, number];
  yawTurns: number;
  zoom: number;
};
