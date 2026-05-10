// Drives a step callback once per requestAnimationFrame.
// Clamps dt to maxDt so large gaps (tab returning to foreground) don't
// produce a single huge step. Returns a cancel function.
export function startRafLoop(
  step: (dt: number) => void,
  opts: { maxDt?: number } = {}
): () => void {
  const maxDt = opts.maxDt ?? 0.1;
  let raf = 0;
  let prevTime = performance.now();
  let stopped = false;

  const tick = () => {
    if (stopped) {
      return;
    }
    raf = requestAnimationFrame(tick);
    const now = performance.now();
    const dt = Math.min((now - prevTime) / 1000, maxDt);
    prevTime = now;
    step(dt);
  };

  raf = requestAnimationFrame(tick);

  return () => {
    stopped = true;
    cancelAnimationFrame(raf);
  };
}
