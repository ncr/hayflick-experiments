export type PanPhaseState = {
  carryX: number;
  carryY: number;
  remainderX: number;
  remainderY: number;
};

export type PanPhaseStep = {
  cameraStepX: number;
  cameraStepY: number;
  state: PanPhaseState;
};

export function createPanPhaseState(): PanPhaseState {
  return {
    carryX: 0,
    carryY: 0,
    remainderX: 0,
    remainderY: 0
  };
}

export function stepPanPhase(
  state: PanPhaseState,
  rawDeltaX: number,
  rawDeltaY: number,
  renderScale: number
): PanPhaseStep {
  const safeScale = Math.max(1, Math.trunc(renderScale));

  const carryX = state.carryX + rawDeltaX;
  const carryY = state.carryY + rawDeltaY;
  const wholeDeltaX = Math.trunc(carryX);
  const wholeDeltaY = Math.trunc(carryY);

  const nextCarryX = carryX - wholeDeltaX;
  const nextCarryY = carryY - wholeDeltaY;

  const accumulatedX = state.remainderX + wholeDeltaX;
  const accumulatedY = state.remainderY + wholeDeltaY;

  const cameraStepX = Math.trunc(accumulatedX / safeScale);
  const cameraStepY = Math.trunc(accumulatedY / safeScale);

  const remainderX = accumulatedX - cameraStepX * safeScale;
  const remainderY = accumulatedY - cameraStepY * safeScale;

  return {
    cameraStepX,
    cameraStepY,
    state: {
      carryX: nextCarryX,
      carryY: nextCarryY,
      remainderX,
      remainderY
    }
  };
}

export function rescalePanPhaseRemainder(
  remainder: number,
  previousScale: number,
  nextScale: number
): number {
  const safePrevious = Math.max(1, Math.trunc(previousScale));
  const safeNext = Math.max(1, Math.trunc(nextScale));
  return Math.trunc((remainder / safePrevious) * safeNext);
}

