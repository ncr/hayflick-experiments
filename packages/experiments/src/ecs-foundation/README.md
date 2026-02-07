# ECS Foundation

## Goal
Provide a minimal, clarity-first ECS baseline for browser games in TypeScript.

## Frame Order
1. Update `world.time` (`dt`, `t`, `frame`).
2. `InputSystem` writes `world.input`.
3. `PlayerInputSystem` writes `Velocity` for player entities.
4. `MovementSystem` applies movement and emits events.
5. `EventSystem` drains events and logs/debugs output.

## Save Format (v1)
```ts
{
  schemaVersion: 1,
  level: { id: string, version: number },
  time: { t: number },
  entities: [
    {
      components: {
        Transform?: { x: number; y: number },
        Velocity?: { vx: number; vy: number },
        PlayerTag?: true,
        Persistent?: { kind: string }
      }
    }
  ]
}
```

## Notes
- EIDs are runtime-only and never serialized.
- Load always clears the world, recreates entities, and restores components.
- Level collision in the demo blocks when `x > 5`.
