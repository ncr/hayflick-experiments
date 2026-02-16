import { describe, expect, it } from "vitest";
import {
  buildEditorSaveV1,
  cellKey,
  edgeKey,
  parseEditorSaveV1,
  parseGameSaveV1,
  SETTLEMENT_EDITOR_SCHEMA_VERSION,
  SETTLEMENT_GAME_SCHEMA_VERSION,
  type SettlementGameSaveV1,
  type SettlementPropPlacement
} from "./schema";

describe("settlement schema", () => {
  it("round-trips editor payload with structures and props", () => {
    const overrides = new Map([[cellKey(2, 3), { base: "floor" as const }]]);
    const structures = new Map([
      [edgeKey(4, 4, 5, 4), { kind: "wall" as const }],
      [edgeKey(5, 4, 5, 5), { kind: "door" as const, state: "closed" as const }]
    ]);
    const props = new Map<string, SettlementPropPlacement>([
      [
        "chair:2,2:1",
        {
          placementId: "chair:2,2:1",
          sourcePropId: "chair",
          cellX: 2,
          cellY: 2,
          offsetX: 0.12,
          offsetZ: -0.08,
          rotQuarterTurns: 1,
          elevation: 0.4,
          collider2d: { width: 0.8, depth: 0.7 }
        }
      ]
    ]);

    const payload = buildEditorSaveV1({
      defaultGround: "grass",
      seed: 123,
      overrides,
      structures,
      props,
      propColliderModes: new Map([
        ["chair", "mesh"],
        ["bench", "defined"]
      ])
    });

    const parsed = parseEditorSaveV1(payload, 30);
    expect(parsed).not.toBeNull();
    if (!parsed) return;

    expect(parsed.defaultGround).toBe("grass");
    expect(parsed.seed).toBe(123);
    expect(parsed.overrides.get(cellKey(2, 3))?.base).toBe("floor");
    expect(parsed.structures.get(edgeKey(4, 4, 5, 4))?.kind).toBe("wall");
    expect(parsed.props.get("chair:2,2:1")?.rotQuarterTurns).toBe(1);
    expect(parsed.props.get("chair:2,2:1")?.elevation).toBe(0.4);
    expect(parsed.props.get("chair:2,2:1")?.offsetX).toBeCloseTo(0.12);
    expect(parsed.props.get("chair:2,2:1")?.offsetZ).toBeCloseTo(-0.08);
    expect(parsed.propColliderModes.get("chair")).toBe("mesh");
    expect(parsed.propColliderModes.get("bench")).toBe("defined");
  });

  it("rejects wrong editor schema version", () => {
    const parsed = parseEditorSaveV1(
      {
        schemaVersion: SETTLEMENT_EDITOR_SCHEMA_VERSION + 1,
        terrain: { defaultGround: "grass", seed: 1, overrides: [] },
        structures: [],
        props: []
      },
      30
    );

    expect(parsed).toBeNull();
  });

  it("parses valid game payload", () => {
    const editor = buildEditorSaveV1({
      defaultGround: "grass",
      seed: 42,
      overrides: new Map(),
      structures: new Map(),
      props: new Map(),
      propColliderModes: new Map()
    });

    const gamePayload: SettlementGameSaveV1 = {
      schemaVersion: SETTLEMENT_GAME_SCHEMA_VERSION,
      editor,
      player: { x: 2.5, y: 3.5 },
      doors: [{ placementId: "door:a", open: true }]
    };

    const parsed = parseGameSaveV1(gamePayload, 30);
    expect(parsed).not.toBeNull();
    if (!parsed) return;

    expect(parsed.player.x).toBe(2.5);
    expect(parsed.editor.schemaVersion).toBe(SETTLEMENT_EDITOR_SCHEMA_VERSION);
    expect(parsed.doors).toHaveLength(1);
  });

  it("defaults missing prop offsets to zero for older saves", () => {
    const parsed = parseEditorSaveV1(
      {
        schemaVersion: SETTLEMENT_EDITOR_SCHEMA_VERSION,
        terrain: { defaultGround: "grass", seed: 1, overrides: [] },
        structures: [],
        props: [
          {
            placementId: "crate:1,1:1",
            sourcePropId: "crate",
            cellX: 1,
            cellY: 1,
            rotQuarterTurns: 0,
            elevation: 0
          }
        ]
      },
      30
    );

    expect(parsed).not.toBeNull();
    if (!parsed) return;
    expect(parsed.props.get("crate:1,1:1")?.offsetX).toBe(0);
    expect(parsed.props.get("crate:1,1:1")?.offsetZ).toBe(0);
    expect(parsed.propColliderModes.size).toBe(0);
  });
});
