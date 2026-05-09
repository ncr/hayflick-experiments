export type PhysicsVector3 = {
  x: number;
  y: number;
  z: number;
};

export type PhysicsQuaternion = {
  x: number;
  y: number;
  z: number;
  w: number;
};

export type RootOffset = {
  x: number;
  y: number;
  z: number;
};

export function rotateVectorByQuaternion(
  x: number,
  y: number,
  z: number,
  rotation: PhysicsQuaternion
): PhysicsVector3 {
  const qx = rotation.x;
  const qy = rotation.y;
  const qz = rotation.z;
  const qw = rotation.w;

  const ix = qw * x + qy * z - qz * y;
  const iy = qw * y + qz * x - qx * z;
  const iz = qw * z + qx * y - qy * x;
  const iw = -qx * x - qy * y - qz * z;

  return {
    x: ix * qw + iw * -qx + iy * -qz - iz * -qy,
    y: iy * qw + iw * -qy + iz * -qx - ix * -qz,
    z: iz * qw + iw * -qz + ix * -qy - iy * -qx
  };
}

export function yawQuaternionForQuarterTurns(
  rotQuarterTurns: 0 | 1 | 2 | 3
): PhysicsQuaternion {
  const yaw = rotQuarterTurns * (Math.PI * 0.5);
  const halfYaw = yaw * 0.5;
  return {
    x: 0,
    y: Math.sin(halfYaw),
    z: 0,
    w: Math.cos(halfYaw)
  };
}

export function quaternionDelta(a: PhysicsQuaternion, b: PhysicsQuaternion): number {
  const dot = Math.abs(a.x * b.x + a.y * b.y + a.z * b.z + a.w * b.w);
  return 1 - Math.min(1, dot);
}

export function bodyTranslationFromRootPose(
  worldX: number,
  worldY: number,
  worldZ: number,
  rootOffsetLocal: RootOffset,
  rotation: PhysicsQuaternion
): PhysicsVector3 {
  const rootOffsetWorld = rotateVectorByQuaternion(
    rootOffsetLocal.x,
    rootOffsetLocal.y,
    rootOffsetLocal.z,
    rotation
  );
  return {
    x: worldX - rootOffsetWorld.x,
    y: worldY - rootOffsetWorld.y,
    z: worldZ - rootOffsetWorld.z
  };
}

export function rootPoseFromBodyPose(
  bodyTranslation: PhysicsVector3,
  rootOffsetLocal: RootOffset,
  rotation: PhysicsQuaternion
): { worldX: number; worldY: number; worldZ: number } {
  const rootOffsetWorld = rotateVectorByQuaternion(
    rootOffsetLocal.x,
    rootOffsetLocal.y,
    rootOffsetLocal.z,
    rotation
  );
  return {
    worldX: bodyTranslation.x + rootOffsetWorld.x,
    worldY: bodyTranslation.y + rootOffsetWorld.y,
    worldZ: bodyTranslation.z + rootOffsetWorld.z
  };
}
