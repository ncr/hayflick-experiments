import { describe, expect, it } from "vitest";
import {
  bodyTranslationFromRootPose,
  quaternionDelta,
  rootPoseFromBodyPose,
  rotateVectorByQuaternion,
  yawQuaternionForQuarterTurns
} from "./prop-physics-math";

describe("prop-physics-math", () => {
  it("builds expected quarter-turn yaw quaternions", () => {
    const q = yawQuaternionForQuarterTurns(1);
    expect(q.x).toBe(0);
    expect(q.z).toBe(0);
    expect(q.y).toBeCloseTo(Math.SQRT1_2, 8);
    expect(q.w).toBeCloseTo(Math.SQRT1_2, 8);
  });

  it("rotates vector around yaw", () => {
    const rotation = yawQuaternionForQuarterTurns(1);
    const rotated = rotateVectorByQuaternion(1, 0, 0, rotation);
    expect(rotated.x).toBeCloseTo(0, 8);
    expect(rotated.y).toBeCloseTo(0, 8);
    expect(rotated.z).toBeCloseTo(-1, 8);
  });

  it("converts between root pose and body pose round-trip", () => {
    const root = { x: 3.4, y: 1.2, z: -0.8 };
    const offset = { x: 0.2, y: -0.4, z: 0.15 };
    const rotation = yawQuaternionForQuarterTurns(3);

    const body = bodyTranslationFromRootPose(
      root.x,
      root.y,
      root.z,
      offset,
      rotation
    );
    const restoredRoot = rootPoseFromBodyPose(body, offset, rotation);

    expect(restoredRoot.worldX).toBeCloseTo(root.x, 8);
    expect(restoredRoot.worldY).toBeCloseTo(root.y, 8);
    expect(restoredRoot.worldZ).toBeCloseTo(root.z, 8);
  });

  it("treats equal quaternions as zero delta", () => {
    const a = yawQuaternionForQuarterTurns(2);
    const b = { x: -a.x, y: -a.y, z: -a.z, w: -a.w };
    expect(quaternionDelta(a, a)).toBeCloseTo(0, 8);
    expect(quaternionDelta(a, b)).toBeCloseTo(0, 8);
  });
});
