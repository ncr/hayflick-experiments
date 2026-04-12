import { deepClone } from "./utils.js";

// Scene plans are the geometry source of truth.
// The Blender bridge renders these plans but should not reinterpret kit rules.
export const CATALOG_ROOT_NAME = "blockstudio_kit_catalog";
export const ROOM_ROOT_NAME = "blockstudio_example_room";

export function buildWallKitCatalogScene({ kit, showFootprintGuides = false } = {}) {
  const spec = requireWallKitSpec(kit);
  const manifestParts = [];
  const root = createGroupNode({
    name: CATALOG_ROOT_NAME,
    origin: [0, 0, 0],
    isOpen: true
  });
  const catalogWindow = resolveCatalogWindowSource(spec);
  const partGap = showFootprintGuides
    ? Math.max(160, Math.round(spec.authoringUnitsPerBaseUnit * 2.25))
    : Math.max(8, Math.round(spec.authoringUnitsPerBaseUnit * 0.75));

  let cursorX = 0;

  if (spec.includeFloorTile) {
    const floorAnchorX = cursorX;
    root.children.push(
      buildFloorTileGroupPlan({
        name: "floor_tile",
        x: floorAnchorX,
        z: 0,
        spec,
        includeGuide: showFootprintGuides,
        manifestPartName: "floor_tile"
      }).group
    );
    manifestParts.push(createManifestPart(spec, "floor_tile", { sceneAnchor: [floorAnchorX, 0, 0] }));
    cursorX = floorAnchorX + spec.baseUnit + partGap;
  }

  const wallAnchorX = cursorX;
  root.children.push(
    buildStraightWallGroupPlan({
      name: "wall",
      bodyName: "wall_body",
      x: wallAnchorX,
      z: 0,
      spec,
      width: spec.wallSpan,
      anchorLeadWidth: spec.baseUnit,
      includeGuide: showFootprintGuides,
      manifestPartName: "wall"
    }).group
  );
  manifestParts.push(createManifestPart(spec, "wall", { sceneAnchor: [wallAnchorX, 0, 0] }));
  cursorX = wallAnchorX + spec.wallSpan + partGap;

  const doorAnchorX = cursorX;
  const doorPlan = buildDoorWallGroupPlan({
    name: "door",
    x: doorAnchorX,
    z: 0,
    spec,
    includeGuide: showFootprintGuides,
    manifestPartName: "door"
  });
  root.children.push(doorPlan.group);
  manifestParts.push(
    createManifestPart(spec, "door", {
      sceneAnchor: [doorAnchorX, 0, 0],
      articulationPivot: doorPlan.articulationPivot
    })
  );
  cursorX = doorAnchorX + spec.wallSpan + partGap;

  if (catalogWindow) {
    const { family, variant } = catalogWindow;

    const leftAnchorX = cursorX;
    const leftPlan = buildWindowTileGroupPlan({
      name: "window_left",
      x: leftAnchorX,
      z: 0,
      spec,
      family,
      variant: { articulation: { type: "fixed", hingeSide: "left" } },
      role: "window_left",
      includeGuide: showFootprintGuides,
      manifestPartName: "window_left"
    });
    root.children.push(leftPlan.group);
    manifestParts.push(createManifestPart(spec, "window_left", { sceneAnchor: [leftAnchorX, 0, 0] }));

    const middleAnchorX = leftAnchorX + spec.wallSpan + partGap;
    const middlePlan = buildWindowTileGroupPlan({
      name: "window_middle",
      x: middleAnchorX,
      z: 0,
      spec,
      family,
      variant,
      role: "window_middle",
      includeGuide: showFootprintGuides,
      manifestPartName: "window_middle"
    });
    root.children.push(middlePlan.group);
    manifestParts.push(
      createManifestPart(spec, "window_middle", {
        sceneAnchor: [middleAnchorX, 0, 0],
        articulationPivot: middlePlan.articulationPivot,
        articulationType: variant?.articulation?.type || null,
        hingeSide: variant?.articulation?.hingeSide || null
      })
    );

    if (spec.includeWindowRight) {
      const rightAnchorX = middleAnchorX + spec.wallSpan + partGap;
      const rightPlan = buildWindowTileGroupPlan({
        name: "window_right",
        x: rightAnchorX,
        z: 0,
        spec,
        family,
        variant: { articulation: { type: "fixed", hingeSide: "left" } },
        role: "window_right",
        includeGuide: showFootprintGuides,
        manifestPartName: "window_right"
      });
      root.children.push(rightPlan.group);
      manifestParts.push(createManifestPart(spec, "window_right", { sceneAnchor: [rightAnchorX, 0, 0] }));
      cursorX = rightAnchorX + spec.wallSpan + partGap;
    } else {
      cursorX = middleAnchorX + spec.wallSpan + partGap;
    }
  }

  if (spec.includeCorners) {
    const cornerAnchorX = cursorX;
    root.children.push(
      buildCornerGroupPlan({
        name: "corner",
        x: cornerAnchorX,
        z: 0,
        spec,
        includeGuide: showFootprintGuides,
        manifestPartName: "corner"
      }).group
    );
    manifestParts.push(createManifestPart(spec, "corner", { sceneAnchor: [cornerAnchorX, 0, 0] }));
    cursorX = cornerAnchorX + spec.baseUnit + partGap;
  }

  if (spec.includeEndCaps) {
    const endCapAnchorX = cursorX;
    root.children.push(
      buildEndCapGroupPlan({
        name: "end_cap",
        x: endCapAnchorX,
        z: 0,
        spec,
        manifestPartName: "end_cap"
      }).group
    );
    manifestParts.push(createManifestPart(spec, "end_cap", { sceneAnchor: [endCapAnchorX, 0, 0] }));
  }

  return {
    scenePlan: {
      schema: "blockstudio/scene-plan@1",
      framePreview: "exploded",
      root
    },
    manifest: createManifestSeed(kit, manifestParts)
  };
}

export function buildGroundKitCatalogScene({ kit } = {}) {
  const spec = kit?.spec;
  if (!spec || spec.kind !== "ground") {
    throw new Error("buildGroundKitCatalogScene requires a ground kit.");
  }

  const manifestParts = [];
  const root = createGroupNode({
    name: CATALOG_ROOT_NAME,
    origin: [0, 0, 0],
    isOpen: true
  });

  const partGap = Math.max(8, Math.round(spec.authoringUnitsPerBaseUnit * 0.75));
  let cursorX = 0;

  for (const tile of spec.tiles) {
    const anchorX = cursorX;
    root.children.push(
      buildFloorTileGroupPlan({
        name: tile.name,
        bodyName: `${tile.name}_body`,
        x: anchorX,
        z: 0,
        spec,
        textureRole: tile.name,
        manifestPartName: tile.name
      }).group
    );
    manifestParts.push(createManifestPart(spec, tile.name, { sceneAnchor: [anchorX, 0, 0] }));
    cursorX = anchorX + spec.baseUnit + partGap;
  }

  return {
    scenePlan: {
      schema: "blockstudio/scene-plan@1",
      framePreview: "exploded",
      root
    },
    manifest: createManifestSeed(kit, manifestParts)
  };
}

export function buildWallExampleRoomScene({ kit, styleProfile, layout = {} } = {}) {
  const spec = requireWallKitSpec(kit);
  const family = spec.windowFamilies[0];
  const variant = family?.variants?.[0];
  if (!family || !variant) {
    throw new Error("The wall kit must define at least one window family and variant.");
  }

  const widthInTiles = Math.max(4, Math.round(positiveNumber(layout.widthInTiles, 5)));
  const depthInTiles = Math.max(3, Math.round(positiveNumber(layout.depthInTiles, 4)));
  const windowRepeatCount = Math.max(
    1,
    Math.round(positiveNumber(layout.windowRepeatCount, variant.repeatableMiddlePanels || 1))
  );
  const styleText = styleProfileToText(styleProfile);
  const monolithStyle =
    hasStyleToken(styleText, ["modern", "desert", "stone", "white"]) &&
    hasStyleToken(styleText, ["tecta", "monolith", "vertical", "black", "tinted"]);

  const root = createGroupNode({
    name: ROOM_ROOT_NAME,
    origin: [0, 0, spec.wallSpan * 3]
  });
  const roomBaseZ = spec.wallSpan * 3;
  const frontSegments = buildRoomFrontSegments({
    spec,
    layout,
    widthInTiles,
    defaultFamily: family,
    defaultVariant: variant,
    defaultWindowRepeatCount: windowRepeatCount,
    monolithStyle
  });
  const roomWidth = frontSegments.reduce((sum, entry) => sum + entry.width, 0);
  const roomDepth = depthInTiles * spec.wallSpan;
  const roomBackZ = roomBaseZ + roomDepth;
  const roofThickness = Math.max(2, Math.round(spec.authoringUnitsPerBaseUnit / 6));
  const parapetHeight = Math.max(
    2,
    Math.round(
      positiveNumber(
        layout.parapetHeight,
        monolithStyle ? spec.authoringUnitsPerBaseUnit / 4 : spec.authoringUnitsPerBaseUnit / 5
      )
    )
  );
  const roofOverhang = Math.max(
    0,
    Math.round(positiveNumber(layout.roofOverhang, monolithStyle ? spec.wallThickness / 2 : 0))
  );

  let cursorX = 0;
  frontSegments.forEach((segment) => {
    const segmentAnchorX = cursorX + spec.baseUnit / 2;
    if (segment.type === "wall") {
      root.children.push(
        buildStraightWallGroupPlan({
          name: "room_wall_x",
          bodyName: "room_wall_x",
          x: segmentAnchorX,
          z: roomBaseZ,
          spec,
          width: segment.width,
          anchorLeadWidth: spec.baseUnit
        }).group
      );
    } else if (segment.type === "door") {
      root.children.push(
        buildDoorWallGroupPlan({
          name: "room_door",
          x: segmentAnchorX,
          z: roomBaseZ,
          spec
        }).group
      );
    } else if (segment.type === "window") {
      root.children.push(
        buildWindowAssemblyGroupPlan({
          name: "room_window_assembly",
          x: segmentAnchorX,
          z: roomBaseZ,
          spec,
          family: segment.family,
          variant: segment.variant,
          repeatCount: segment.repeatCount,
          prefix: "room"
        }).group
      );
    } else if (segment.type === "portal") {
      root.children.push(
        ...buildPortalSegmentNodes({
          x: cursorX,
          z: roomBaseZ,
          spec,
          width: segment.width,
          depth: segment.depth,
          roofThickness
        })
      );
    }
    cursorX += segment.width;
  });

  for (let index = 0; index < depthInTiles; index += 1) {
    const anchorZ = roomBaseZ + spec.baseUnit / 2 + index * spec.baseUnit;
    const runBounds = getRunBounds({
      anchorX: anchorZ,
      logicalWidth: spec.baseUnit,
      anchorLeadWidth: spec.baseUnit
    });
    root.children.push(
      createCubeNode({
        name: "room_wall_z",
        from: [-spec.wallThickness / 2, 0, runBounds.start],
        to: [spec.wallThickness / 2, spec.wallHeight, runBounds.end],
        origin: [0, 0, anchorZ]
      }),
      createCubeNode({
        name: "room_wall_z",
        from: [roomWidth - spec.wallThickness / 2, 0, runBounds.start],
        to: [roomWidth + spec.wallThickness / 2, spec.wallHeight, runBounds.end],
        origin: [roomWidth, 0, anchorZ]
      })
    );
  }

  root.children.push(
    createCubeNode({
      name: "room_wall_x",
      from: [0, 0, roomBackZ - spec.wallThickness / 2],
      to: [roomWidth, spec.wallHeight, roomBackZ + spec.wallThickness / 2],
      origin: [roomWidth / 2, 0, roomBackZ]
    }),
    createCubeNode({
      name: "room_roof",
      from: [-roofOverhang, spec.wallHeight - roofThickness, roomBaseZ - roofOverhang],
      to: [roomWidth + roofOverhang, spec.wallHeight, roomBackZ + roofOverhang],
      origin: [roomWidth / 2, spec.wallHeight - roofThickness, roomBaseZ + roomDepth / 2]
    }),
    createCubeNode({
      name: "room_parapet_front",
      from: [0, spec.wallHeight - parapetHeight, roomBaseZ - spec.wallThickness / 2],
      to: [roomWidth, spec.wallHeight + 0.5, roomBaseZ + spec.wallThickness / 2],
      origin: [roomWidth / 2, spec.wallHeight - parapetHeight, roomBaseZ]
    }),
    createCubeNode({
      name: "room_parapet_back",
      from: [0, spec.wallHeight - parapetHeight, roomBackZ - spec.wallThickness / 2],
      to: [roomWidth, spec.wallHeight + 0.5, roomBackZ + spec.wallThickness / 2],
      origin: [roomWidth / 2, spec.wallHeight - parapetHeight, roomBackZ]
    }),
    createCubeNode({
      name: "room_parapet_left",
      from: [-spec.wallThickness / 2, spec.wallHeight - parapetHeight, roomBaseZ],
      to: [spec.wallThickness / 2, spec.wallHeight + 0.5, roomBackZ],
      origin: [0, spec.wallHeight - parapetHeight, roomBaseZ + roomDepth / 2]
    }),
    createCubeNode({
      name: "room_parapet_right",
      from: [roomWidth - spec.wallThickness / 2, spec.wallHeight - parapetHeight, roomBaseZ],
      to: [roomWidth + spec.wallThickness / 2, spec.wallHeight + 0.5, roomBackZ],
      origin: [roomWidth, spec.wallHeight - parapetHeight, roomBaseZ + roomDepth / 2]
    })
  );

  return {
    scenePlan: {
      schema: "blockstudio/scene-plan@1",
      framePreview: "isometric",
      root
    },
    exampleRoom: {
      layout: {
        widthInTiles,
        depthInTiles,
        windowRepeatCount
      },
      bounds: {
        width: roomWidth,
        depth: roomDepth,
        height: spec.wallHeight
      }
    }
  };
}

function requireWallKitSpec(kit) {
  if (!kit || !kit.spec) {
    throw new Error("Missing wall kit definition.");
  }
  return kit.spec;
}

function createManifestSeed(kit, parts) {
  return {
    kitId: kit.id || null,
    name: kit.name || null,
    styleProfileId: kit.styleProfileId || null,
    parts: deepClone(parts),
    exampleRoom: null,
    textures: []
  };
}

function createManifestPart(spec, name, overrides = {}) {
  const catalogPart = Array.isArray(spec.parts) ? spec.parts.find((part) => part.name === name) : null;
  if (!catalogPart) {
    throw new Error(`Missing part catalog entry "${name}".`);
  }

  return {
    name: catalogPart.name,
    kind: catalogPart.kind,
    role: catalogPart.role || null,
    groupUuid: null,
    anchorClass: catalogPart.anchor?.class || null,
    anchorPolicy: catalogPart.anchor?.policy || null,
    anchorLocal: [0, 0, 0],
    sceneAnchor: deepClone(overrides.sceneAnchor || null),
    logicalFootprint: deepClone(catalogPart.logicalFootprint || null),
    meshEnvelope: deepClone(catalogPart.meshEnvelope || null),
    articulationPivot: deepClone(overrides.articulationPivot || null),
    articulationType:
      overrides.articulationType !== undefined
        ? overrides.articulationType
        : catalogPart.articulation?.type || null,
    hingeSide:
      overrides.hingeSide !== undefined
        ? overrides.hingeSide
        : catalogPart.articulation?.hingeSide || null,
    dimensions: deepClone(catalogPart.dimensions || null)
  };
}

function buildStraightWallGroupPlan({
  name,
  bodyName,
  x,
  z,
  spec,
  width,
  anchorLeadWidth,
  includeGuide = false,
  manifestPartName = null
}) {
  const wallWidth = positiveNumber(width, spec.wallSpan);
  const depthBounds = getCenteredDepthBounds(z, spec.wallThickness);
  const runBounds = getRunBounds({
    anchorX: x,
    logicalWidth: wallWidth,
    anchorLeadWidth: positiveNumber(anchorLeadWidth, spec.baseUnit)
  });
  const group = createGroupNode({
    name,
    origin: [x, 0, z],
    manifestPartName
  });

  group.children.push(
    createCubeNode({
      name: bodyName,
      from: [runBounds.start, 0, depthBounds.start],
      to: [runBounds.end, spec.wallHeight, depthBounds.end],
      origin: [x, 0, z]
    })
  );

  if (includeGuide) {
    group.children.push(
      buildLinearGuideNode({
        name: `${name}_guide`,
        x,
        z,
        width: wallWidth,
        depth: spec.wallThickness,
        y: -6
      })
    );
  }

  return { group };
}

function buildFloorTileGroupPlan({ name, bodyName, x, z, spec, textureRole, includeGuide = false, manifestPartName = null }) {
  const group = createGroupNode({
    name,
    origin: [x, 0, z],
    manifestPartName
  });

  group.children.push(
    createCubeNode({
      name: bodyName || "floor_tile_body",
      from: [x - spec.baseUnit / 2, 0, z - spec.baseUnit / 2],
      to: [x + spec.baseUnit / 2, spec.floorThickness, z + spec.baseUnit / 2],
      origin: [x, 0, z],
      textureRole: textureRole || null
    })
  );

  if (includeGuide) {
    group.children.push(buildFloorGuideNode({ x, z, spec }));
  }

  return { group };
}

function buildDoorWallGroupPlan({ name, x, z, spec, includeGuide = false, manifestPartName = null }) {
  const runBounds = getRunBounds({
    anchorX: x,
    logicalWidth: spec.wallSpan,
    anchorLeadWidth: spec.baseUnit
  });
  const depthBounds = getCenteredDepthBounds(z, spec.wallThickness);
  const openingStart = x - spec.wallSpan / 2 + (spec.wallSpan - spec.door.width) / 2;
  const openingEnd = openingStart + spec.door.width;
  const leftEnd = Math.min(runBounds.end, openingStart);
  const rightStart = Math.max(runBounds.start, openingEnd);
  const headerStart = Math.max(runBounds.start, openingStart);
  const headerEnd = Math.min(runBounds.end, openingEnd);
  const hingeX = spec.door.hingeSide === "right" ? openingEnd : openingStart;
  const leafDepth = resolveMountedElementDepthBounds({
    front: depthBounds.start,
    back: depthBounds.end,
    thickness: spec.door.thickness,
    inset: spec.door.frameProtrusion
  });
  const articulationPivot = [round(hingeX - x, 3), 0, round(leafDepth.center - z, 3)];
  const articulationPivotWorld = [hingeX, 0, leafDepth.center];
  const group = createGroupNode({
    name,
    origin: [x, 0, z],
    manifestPartName
  });

  if (includeGuide) {
    group.children.push(
      buildLinearGuideNode({
        name: `${name}_guide`,
        x,
        z,
        width: spec.wallSpan,
        depth: spec.wallThickness,
        y: -6
      })
    );
  }

  if (leftEnd > runBounds.start) {
    const leftFrom = [runBounds.start, 0, depthBounds.start];
    const leftTo = [leftEnd, spec.wallHeight, depthBounds.end];
    group.children.push(
      createCubeNode({
        name: `${name}_left`,
        from: leftFrom,
        to: leftTo,
        origin: resolveElementOrigin(leftFrom, leftTo)
      })
    );
  }

  if (rightStart < runBounds.end) {
    const rightFrom = [rightStart, 0, depthBounds.start];
    const rightTo = [runBounds.end, spec.wallHeight, depthBounds.end];
    group.children.push(
      createCubeNode({
        name: `${name}_right`,
        from: rightFrom,
        to: rightTo,
        origin: resolveElementOrigin(rightFrom, rightTo)
      })
    );
  }

  if (spec.door.height < spec.wallHeight) {
    const headerFrom = [headerStart, spec.door.height, depthBounds.start];
    const headerTo = [headerEnd, spec.wallHeight, depthBounds.end];
    group.children.push(
      createCubeNode({
        name: `${name}_header`,
        from: headerFrom,
        to: headerTo,
        origin: resolveElementOrigin(headerFrom, headerTo)
      })
    );
  }

  const leafGroup = createGroupNode({
    name: `${name}_leaf`,
    origin: articulationPivotWorld
  });
  leafGroup.children.push(
    createCubeNode({
      name: "door_leaf_body",
      from: [openingStart, 0, leafDepth.start],
      to: [openingEnd, spec.door.height, leafDepth.end],
      origin: articulationPivotWorld
    })
  );
  group.children.push(leafGroup);

  return {
    group,
    articulationPivot
  };
}

function buildWindowTileGroupPlan({
  name,
  x,
  z,
  spec,
  family,
  variant,
  role,
  includeGuide = false,
  manifestPartName = null
}) {
  const depthBounds = getCenteredDepthBounds(z, spec.wallThickness);
  const layout = resolveWindowTileLayout({ x, spec, family, role });
  const group = createGroupNode({
    name,
    origin: [x, 0, z],
    manifestPartName
  });

  if (includeGuide) {
    group.children.push(
      buildLinearGuideNode({
        name: `${name}_guide`,
        x,
        z,
        width: spec.wallSpan,
        depth: spec.wallThickness,
        y: -6
      })
    );
  }

  layout.wallSegments.forEach((segment) => {
    if (segment.end <= segment.start) {
      return;
    }
    const wallFrom = [segment.start, 0, depthBounds.start];
    const wallTo = [segment.end, spec.wallHeight, depthBounds.end];
    group.children.push(
      createCubeNode({
        name: `${role}_${segment.name}`,
        from: wallFrom,
        to: wallTo,
        origin: resolveElementOrigin(wallFrom, wallTo)
      })
    );
  });

  if (layout.openingBottom > 0 && layout.glassEnd > layout.glassStart) {
    const sillFrom = [layout.glassStart, 0, depthBounds.start];
    const sillTo = [layout.glassEnd, layout.openingBottom, depthBounds.end];
    group.children.push(
      createCubeNode({
        name: `${role}_sill`,
        from: sillFrom,
        to: sillTo,
        origin: resolveElementOrigin(sillFrom, sillTo)
      })
    );
  }

  if (layout.openingTop < spec.wallHeight && layout.glassEnd > layout.glassStart) {
    const headerFrom = [layout.glassStart, layout.openingTop, depthBounds.start];
    const headerTo = [layout.glassEnd, spec.wallHeight, depthBounds.end];
    group.children.push(
      createCubeNode({
        name: `${role}_header`,
        from: headerFrom,
        to: headerTo,
        origin: resolveElementOrigin(headerFrom, headerTo)
      })
    );
  }

  const glassPlan =
    layout.glassEnd > layout.glassStart
      ? createWindowLeafOrGlassPlan({
          runStart: layout.glassStart,
          runEnd: layout.glassEnd,
          anchorX: x,
          anchorZ: z,
          openingBottom: layout.openingBottom,
          openingTop: layout.openingTop,
          front: depthBounds.start,
          back: depthBounds.end,
          glassThickness: family.glassThickness,
          articulation: variant?.articulation || { type: "fixed" },
          partAnchorX: x
        })
      : { nodes: [], articulationPivot: null };
  group.children.push(...glassPlan.nodes);

  return {
    group,
    articulationPivot: glassPlan.articulationPivot
  };
}

function buildWindowAssemblyGroupPlan({
  name,
  x,
  z,
  spec,
  family,
  variant,
  repeatCount,
  prefix
}) {
  const group = createGroupNode({
    name,
    origin: [x, 0, z]
  });
  const tileCount = Math.max(0, Math.round(positiveNumber(repeatCount, 1))) + 2;
  let cursorX = round(x - ((tileCount - 1) * spec.wallSpan) / 2, 3);

  group.children.push(
    buildWindowTileGroupPlan({
      name: `${prefix}_window_left`,
      x: cursorX,
      z,
      spec,
      family,
      variant: { articulation: { type: "fixed", hingeSide: "left" } },
      role: "window_left"
    }).group
  );
  cursorX += spec.wallSpan;

  for (let index = 0; index < tileCount - 2; index += 1) {
    group.children.push(
      buildWindowTileGroupPlan({
        name: `${prefix}_window_middle_${index + 1}`,
        x: cursorX,
        z,
        spec,
        family,
        variant,
        role: "window_middle"
      }).group
    );
    cursorX += spec.wallSpan;
  }

  group.children.push(
    buildWindowTileGroupPlan({
      name: `${prefix}_window_right`,
      x: cursorX,
      z,
      spec,
      family,
      variant: { articulation: { type: "fixed", hingeSide: "left" } },
      role: "window_right"
    }).group
  );

  return { group };
}

function buildCornerGroupPlan({ name, x, z, spec, includeGuide = false, manifestPartName = null }) {
  const group = createGroupNode({
    name,
    origin: [x, 0, z],
    manifestPartName
  });

  if (includeGuide) {
    group.children.push(...buildCornerGuideNodes({ x, z, spec }));
  }

  group.children.push(
    createPolygonPrismNode({
      name: "corner_body",
      origin: [x, 0, z],
      bottomY: 0,
      topY: spec.wallHeight,
      contour: buildCornerOutline({
        x,
        z,
        halfThickness: Math.max(0.001, spec.wallThickness / 2),
        runLength: Math.max(spec.wallThickness, spec.baseUnit)
      })
    })
  );

  return { group };
}

function buildEndCapGroupPlan({ name, x, z, spec, manifestPartName = null }) {
  const depthBounds = getCenteredDepthBounds(z, spec.wallThickness);
  const group = createGroupNode({
    name,
    origin: [x, 0, z],
    manifestPartName
  });
  group.children.push(
    createCubeNode({
      name: "end_cap_body",
      from: [x - spec.wallThickness / 2, 0, depthBounds.start],
      to: [x + spec.wallThickness / 2, spec.wallHeight, depthBounds.end],
      origin: [x, 0, z]
    })
  );
  return { group };
}

function buildPortalSegmentNodes({ x, z, spec, width, depth, roofThickness }) {
  const nodes = [];
  const portalFrontZ = z - depth;
  const pierWidth = spec.wallThickness;
  const segmentWidth = Math.max(width, spec.wallSpan + pierWidth * 2);
  const doorSegmentStartX = x + Math.max(0, (segmentWidth - spec.wallSpan) / 2);
  const doorSegmentAnchorX = doorSegmentStartX + spec.baseUnit / 2;

  nodes.push(
    createCubeNode({
      name: "portal_pier_left",
      from: [x, 0, portalFrontZ],
      to: [x + pierWidth, spec.wallHeight, z + spec.wallThickness],
      origin: [x + pierWidth / 2, 0, portalFrontZ + (depth + spec.wallThickness) / 2]
    }),
    createCubeNode({
      name: "portal_pier_right",
      from: [x + segmentWidth - pierWidth, 0, portalFrontZ],
      to: [x + segmentWidth, spec.wallHeight, z + spec.wallThickness],
      origin: [
        x + segmentWidth - pierWidth / 2,
        0,
        portalFrontZ + (depth + spec.wallThickness) / 2
      ]
    }),
    createCubeNode({
      name: "portal_shadow_soffit",
      from: [x, spec.wallHeight - roofThickness, portalFrontZ],
      to: [x + segmentWidth, spec.wallHeight - 0.25, z + spec.wallThickness],
      origin: [x + segmentWidth / 2, spec.wallHeight - roofThickness, portalFrontZ + (depth + spec.wallThickness) / 2]
    })
  );

  if (doorSegmentStartX > x) {
    nodes.push(
      createCubeNode({
        name: "portal_shadow_back_left",
        from: [x, 0, z],
        to: [doorSegmentStartX, spec.wallHeight, z + spec.wallThickness],
        origin: [x + (doorSegmentStartX - x) / 2, 0, z + spec.wallThickness / 2]
      })
    );
  }

  nodes.push(
    buildDoorWallGroupPlan({
      name: "room_portal_door",
      x: doorSegmentAnchorX,
      z,
      spec
    }).group
  );

  const rightBackStart = doorSegmentStartX + spec.wallSpan;
  if (rightBackStart < x + segmentWidth) {
    nodes.push(
      createCubeNode({
        name: "portal_shadow_back_right",
        from: [rightBackStart, 0, z],
        to: [x + segmentWidth, spec.wallHeight, z + spec.wallThickness],
        origin: [rightBackStart + (x + segmentWidth - rightBackStart) / 2, 0, z + spec.wallThickness / 2]
      })
    );
  }

  nodes.push(
    createCubeNode({
      name: "portal_shadow_floor",
      from: [x, 0, portalFrontZ],
      to: [x + segmentWidth, Math.max(1, Math.round(spec.wallThickness / 2)), z],
      origin: [x + segmentWidth / 2, 0, portalFrontZ + depth / 2]
    })
  );

  return nodes;
}

function createWindowLeafOrGlassPlan({
  runStart,
  runEnd,
  anchorX,
  anchorZ,
  openingBottom,
  openingTop,
  front,
  back,
  glassThickness,
  articulation,
  partAnchorX
}) {
  const availableDepth = Math.abs(back - front);
  const centerInset = round(Math.max(0, availableDepth - glassThickness) / 2, 3);
  const glassDepth = resolveMountedElementDepthBounds({
    front,
    back,
    thickness: glassThickness,
    inset: centerInset
  });

  if (!articulation || articulation.type === "fixed") {
    const glassCenterX = round((runStart + runEnd) / 2, 3);
    return {
      articulationPivot: null,
      nodes: [
        createCubeNode({
          name: "window_glass",
          from: [runStart, openingBottom, glassDepth.start],
          to: [runEnd, openingTop, glassDepth.end],
          origin: [glassCenterX, openingBottom, glassDepth.center]
        })
      ]
    };
  }

  if (articulation.type.indexOf("casement") === 0) {
    const pivot = [
      round((articulation.hingeSide === "right" ? runEnd : runStart) - partAnchorX, 3),
      openingBottom,
      round(glassDepth.center - anchorZ, 3)
    ];
    const pivotWorld = [
      articulation.hingeSide === "right" ? runEnd : runStart,
      openingBottom,
      glassDepth.center
    ];
    const leafGroup = createGroupNode({
      name: "window_leaf_group",
      origin: pivotWorld
    });
    leafGroup.children.push(
      createCubeNode({
        name: "window_leaf",
        from: [runStart, openingBottom, glassDepth.start],
        to: [runEnd, openingTop, glassDepth.end],
        origin: pivotWorld
      })
    );
    return {
      articulationPivot: pivot,
      nodes: [leafGroup]
    };
  }

  if (articulation.type === "sliding") {
    const width = runEnd - runStart;
    return {
      articulationPivot: null,
      nodes: [
        createCubeNode({
          name: "window_leaf",
          from: [runStart, openingBottom, glassDepth.start],
          to: [runEnd, openingTop, glassDepth.end],
          origin: [runStart + width / 2, openingBottom, glassDepth.center]
        })
      ]
    };
  }

  return {
    articulationPivot: null,
    nodes: [
      createCubeNode({
        name: "window_glass",
        from: [runStart, openingBottom, glassDepth.start],
        to: [runEnd, openingTop, glassDepth.end],
        origin: [anchorX, openingBottom, glassDepth.center]
      })
    ]
  };
}

function resolveCatalogWindowSource(spec) {
  const fallbackFamily = spec?.windowFamilies?.[0] || null;
  if (!fallbackFamily) {
    return null;
  }
  const source = spec?.catalogWindowSource || {};
  const family = spec.windowFamilies.find((entry) => entry.name === source.familyName) || fallbackFamily;
  const variant = family.variants.find((entry) => entry.name === source.variantName) || family.variants[0] || null;
  if (!variant) {
    return null;
  }
  return { family, variant };
}

function resolveWindowTileLayout({ x, spec, family, role }) {
  const runBounds = getRunBounds({
    anchorX: x,
    logicalWidth: spec.wallSpan,
    anchorLeadWidth: spec.baseUnit
  });
  const logicalStart = round(x - spec.wallSpan / 2, 3);
  const logicalEnd = round(x + spec.wallSpan / 2, 3);
  const minimumGlassWidth = 4;
  const maxWallWidth = Math.max(0, spec.wallSpan - minimumGlassWidth);
  const leftWallWidth = role === "window_left" ? Math.min(positiveNumber(family.leftWidth, 0), maxWallWidth) : 0;
  const rightWallWidth = role === "window_right" ? Math.min(positiveNumber(family.rightWidth, 0), maxWallWidth) : 0;
  const glassStart = round(logicalStart + leftWallWidth, 3);
  const glassEnd = round(logicalEnd - rightWallWidth, 3);
  const wallSegments = [];

  if (role === "window_left") {
    wallSegments.push({
      name: "left_wall",
      start: runBounds.start,
      end: round(Math.min(runBounds.end, glassStart), 3)
    });
  }

  if (role === "window_right") {
    wallSegments.push({
      name: "right_wall",
      start: round(Math.max(runBounds.start, glassEnd), 3),
      end: runBounds.end
    });
  }

  return {
    runBounds,
    logicalStart,
    logicalEnd,
    wallSegments,
    glassStart,
    glassEnd,
    openingBottom: family.sillHeight,
    openingTop: family.sillHeight + family.openingHeight
  };
}

function buildRoomFrontSegments({
  spec,
  layout,
  widthInTiles,
  defaultFamily,
  defaultVariant,
  defaultWindowRepeatCount,
  monolithStyle
}) {
  const requestedSegments = Array.isArray(layout.frontSegments) ? layout.frontSegments : [];
  const defaultPortalWidth = Math.max(spec.wallSpan + spec.wallThickness * 2, Math.round(spec.wallSpan * 1.75));
  const defaultPortalDepth = Math.max(spec.authoringUnitsPerBaseUnit, Math.round(spec.wallSpan * 0.9));
  const defaults =
    requestedSegments.length > 0
      ? requestedSegments
      : monolithStyle
        ? [
            { type: "wall", width: spec.wallSpan * 1.5 },
            { type: "window", familyName: defaultFamily.name, variantName: defaultVariant.name, repeatCount: 1 },
            { type: "wall", width: Math.max(spec.authoringUnitsPerBaseUnit, Math.round(spec.wallSpan * 0.45)) },
            { type: "window", familyName: defaultFamily.name, variantName: defaultVariant.name, repeatCount: 1 },
            { type: "wall", width: spec.wallSpan },
            { type: "portal", width: defaultPortalWidth, depth: defaultPortalDepth }
          ]
        : [
            { type: "wall", width: spec.wallSpan },
            { type: "door", width: spec.wallSpan },
            { type: "wall", width: spec.wallSpan },
            {
              type: "window",
              familyName: defaultFamily.name,
              variantName: defaultVariant.name,
              repeatCount: defaultWindowRepeatCount
            }
          ];

  const segments = defaults
    .map((segment) =>
      normalizeRoomFrontSegment({
        segment,
        spec,
        defaultFamily,
        defaultVariant,
        defaultWindowRepeatCount,
        defaultPortalWidth,
        defaultPortalDepth
      })
    )
    .filter(Boolean);

  if (requestedSegments.length === 0) {
    const minimumFrontWidth = widthInTiles * spec.wallSpan;
    let assignedFrontWidth = segments.reduce((sum, entry) => sum + entry.width, 0);
    while (assignedFrontWidth < minimumFrontWidth) {
      segments.splice(Math.max(segments.length - 1, 0), 0, {
        type: "wall",
        width: spec.wallSpan
      });
      assignedFrontWidth += spec.wallSpan;
    }
  }

  return segments;
}

function normalizeRoomFrontSegment({
  segment,
  spec,
  defaultFamily,
  defaultVariant,
  defaultWindowRepeatCount,
  defaultPortalWidth,
  defaultPortalDepth
}) {
  const type = String(segment?.type || segment?.kind || "wall").trim().toLowerCase();
  if (!type) {
    return null;
  }

  if (type === "window") {
    const family = findRoomWindowFamily(spec, segment.familyName) || defaultFamily;
    const variant = findRoomWindowVariant(family, segment.variantName) || defaultVariant;
    const repeatCount = Math.max(1, Math.round(positiveNumber(segment.repeatCount, defaultWindowRepeatCount)));
    return {
      type,
      family,
      variant,
      repeatCount,
      width: positiveNumber(segment.width, resolveWindowLogicalWidth(spec, repeatCount))
    };
  }

  if (type === "portal") {
    return {
      type,
      width: Math.max(positiveNumber(segment.width, defaultPortalWidth), spec.wallSpan + spec.wallThickness * 2),
      depth: positiveNumber(segment.depth, defaultPortalDepth)
    };
  }

  if (type === "door") {
    return {
      type,
      width: positiveNumber(segment.width, spec.wallSpan)
    };
  }

  return {
    type: "wall",
    width: positiveNumber(segment.width, spec.wallSpan)
  };
}

function findRoomWindowFamily(spec, familyName) {
  if (!familyName) {
    return null;
  }
  return spec.windowFamilies.find((entry) => entry.name === familyName) || null;
}

function findRoomWindowVariant(family, variantName) {
  if (!family || !variantName) {
    return null;
  }
  return family.variants.find((entry) => entry.name === variantName) || null;
}

function buildCornerOutline({ x, z, halfThickness, runLength }) {
  // Corner anchor (x, z) is the grid vertex. Each wall leg is centered on
  // its grid line by extending halfThickness on each side, exactly matching
  // how wall tiles are centered on edge midpoints. The legs run `runLength`
  // into the +X/+Z quadrant from the vertex.
  return [
    [x - halfThickness, z - halfThickness],
    [x - halfThickness, z + runLength],
    [x + halfThickness, z + runLength],
    [x + halfThickness, z + halfThickness],
    [x + runLength,     z + halfThickness],
    [x + runLength,     z - halfThickness]
  ];
}

function buildFloorGuideNode({ x, z, spec }) {
  return buildGuidePadNode({
    name: "floor_tile_guide",
    from: [x - spec.baseUnit / 2, -6, z - spec.baseUnit / 2],
    to: [x + spec.baseUnit / 2, -4, z + spec.baseUnit / 2],
    origin: [x, -6, z]
  });
}

function buildLinearGuideNode({ name, x, z, width, depth, y }) {
  return buildGuidePadNode({
    name,
    from: [x - width / 2, y, z - depth / 2],
    to: [x + width / 2, y + 2, z + depth / 2],
    origin: [x, y, z]
  });
}

function buildCornerGuideNodes({ x, z, spec }) {
  // Guides mirror the mesh: two legs centered on the grid lines at (x, z),
  // extending halfThickness on each side just like the corner outline.
  const ht = spec.wallThickness / 2;
  return [
    buildGuidePadNode({
      name: "corner_x_guide",
      from: [x, -6, z - ht],
      to: [x + spec.baseUnit, -4, z + ht],
      origin: [x, -6, z]
    }),
    buildGuidePadNode({
      name: "corner_z_guide",
      from: [x - ht, -6, z],
      to: [x + ht, -4, z + spec.baseUnit],
      origin: [x, -6, z]
    })
  ];
}

function buildGuidePadNode({ name, from, to, origin }) {
  return createCubeNode({
    name,
    from,
    to,
    origin,
    color: 8,
    skipTexture: true
  });
}

function createGroupNode({ name, origin, isOpen = false, manifestPartName = null }) {
  return {
    type: "group",
    name,
    origin: deepClone(origin || [0, 0, 0]),
    isOpen: isOpen === true,
    manifestPartName,
    children: []
  };
}

function createCubeNode(options) {
  return {
    type: "cube",
    name: options.name,
    from: deepClone(options.from || [0, 0, 0]),
    to: deepClone(options.to || [0, 0, 0]),
    origin: deepClone(options.origin || [0, 0, 0]),
    color: options.color || 0,
    skipTexture: options.skipTexture === true,
    textureRole: options.textureRole || null
  };
}

function createPolygonPrismNode(options) {
  return {
    type: "polygon_prism",
    name: options.name,
    origin: deepClone(options.origin || [0, 0, 0]),
    bottomY: readCoordinate(options.bottomY, 0),
    topY: readCoordinate(options.topY, 0),
    contour: deepClone(options.contour || []),
    color: options.color || 0,
    skipTexture: options.skipTexture === true
  };
}

function getCenteredDepthBounds(anchor, depth) {
  return {
    start: round(anchor - depth / 2, 3),
    end: round(anchor + depth / 2, 3)
  };
}

function resolveMountedElementDepthBounds({ front, back, thickness, inset = 0 }) {
  const depthStart = Math.min(front, back);
  const depthEnd = Math.max(front, back);
  const availableDepth = Math.max(0, depthEnd - depthStart);
  const elementThickness = Math.min(positiveNumber(thickness, 0), availableDepth);
  const maxInset = Math.max(0, availableDepth - elementThickness);
  const mountedInset = Math.min(positiveNumber(inset, 0), maxInset);
  const start = round(depthStart + mountedInset, 3);
  const end = round(start + elementThickness, 3);
  return {
    start,
    end,
    center: round((start + end) / 2, 3)
  };
}

function resolveElementOrigin(from, to) {
  const start = Array.isArray(from) ? from : [0, 0, 0];
  const end = Array.isArray(to) ? to : [0, 0, 0];
  return [
    round((Number(start[0] || 0) + Number(end[0] || 0)) / 2, 3),
    round(Math.min(Number(start[1] || 0), Number(end[1] || 0)), 3),
    round((Number(start[2] || 0) + Number(end[2] || 0)) / 2, 3)
  ];
}

function getRunBounds({ anchorX, logicalWidth, anchorLeadWidth }) {
  const start = anchorX - anchorLeadWidth / 2;
  return {
    start: round(start, 3),
    end: round(start + logicalWidth, 3)
  };
}

function resolveWindowLogicalWidth(spec, repeatCount) {
  const middleCount = Math.max(1, Math.round(positiveNumber(repeatCount, 1)));
  return spec.wallSpan * (middleCount + 2);
}

function styleProfileToText(styleProfile) {
  if (!styleProfile || typeof styleProfile !== "object") {
    return "";
  }
  const parts = [];
  if (typeof styleProfile.notes === "string") {
    parts.push(styleProfile.notes);
  }
  if (typeof styleProfile.styleNotes === "string") {
    parts.push(styleProfile.styleNotes);
  }
  if (Array.isArray(styleProfile.keywords)) {
    parts.push(styleProfile.keywords.join(" "));
  }
  if (Array.isArray(styleProfile.assistantObservations)) {
    parts.push(styleProfile.assistantObservations.join(" "));
  }
  return parts.join(" ").toLowerCase();
}

function hasStyleToken(text, tokens) {
  const source = String(text || "");
  return (tokens || []).some((token) => source.indexOf(String(token).toLowerCase()) >= 0);
}

function positiveNumber(value, fallback) {
  const number = Number(value);
  return Number.isFinite(number) && number > 0 ? number : fallback;
}

function readCoordinate(value, fallback) {
  const number = Number(value);
  return Number.isFinite(number) ? number : fallback;
}

function round(value, digits) {
  const factor = Math.pow(10, digits || 0);
  return Math.round(value * factor) / factor;
}
