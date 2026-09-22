# After the Rain

Playable from Esc → levels → **after the rain**. The owner's reinforced-concrete
direction now extends through the ground, dwellings, vegetation and character.
The environment's materials and meshes are procedural. The player has since
been replaced with an original Blender-authored leather-jacket model, exported
into the game, with procedural garment surface detail and runtime animation.
See `PLAYER_2026-09-05.md` for that follow-up; the character description and
performance figures below record the first version of this level.

## Place and materials

Three dwelling shells face a four-metre road. Five-foot sidewalk pours and short
entry paths connect the houses. Two-cell doors, real window openings, lintels,
surviving corner columns and roof strips establish the buildings' scale. The
southern house has blast damage and bent exposed reinforcement; the others show
corrosion and fire. Scorched ground and reduced regrowth follow the fire house.

`assets/procedural/neighborhood.layout` is shared by the headless game, mesh
builder and shader. It determines parcels, surfaces, doorway locations and
growth exclusion. Roads/path geometry and vegetation therefore use the same
boundaries.

- Concrete pours have separate joints, tilted tops, fractured edges and large
  missing corners exposing the soil below. Their thickness is real geometry.
- Asphalt has exposed road base in potholes, worn centre paint, aggregate and
  branching cracks. Weeds root along those same cracks.
- Soil has compacted/bare areas and uneven grass coverage. Short green blades,
  taller grass and dry straw share the restrained mineral palette.
- The original concrete material still supplies the walls, broken cover,
  exposed aggregate, soot, oxide, cracks and bent bars.

## Grass and the survivor

`terrain.inc` generates and intersects tapered, bent grass ribbons during primary
shading. Traveling gusts and blade flutter use the fixed simulation clock.
Blades bend outward and lower around the player, recovering as he moves away.
Both Metal and GLSL compile the same source. Grass receives scene shadows;
foliage self-shading and its ground contribution are approximated through leaf
height and ground cover. The probe bake contains static scene geometry and
average materials. This is a local, elastic interaction; it does not store
permanent flattened trails or simulate vegetation growth over time.

`survivor.rs` replaces the box figure in the aftermath aesthetic with a faceted
older man: receding grey hair, brows and beard, neck, coat collar/pockets,
trousers, hands and boots. Fifteen dynamic runs articulate the pelvis, chest,
head, thighs, shins, feet, upper/lower arms and hands. The rig uses planted stance
feet, two-link knee/elbow IK, distance-paced walk/jog, gradual turning, subtle
breathing and acceleration lean. Actual collision contact stops the stride,
raises the hands into a brace and releases the pose when the input stops.

The neighborhood's walk/jog speeds are 1.65/3.2 world units per second. Clicking
a destination follows continuous fixed-tick movement through the grid path.
Boot support follows the paving/road/soil heights. Collider walls and visible
door openings are derived from the same grid.

## Validation and maintenance

- 207 workspace tests pass, including the existing menu-crash regression.
- Red/green regressions cover the old fixed player height, cell-jumping click
  routes, and missing instance transforms in articulated shading.
- New checks cover reachable doors, planted feet, knee link lengths, bracing
  and release, window clipping area, ground material families and finite,
  nondegenerate scene geometry.
- GLSL compiles in the release build; Metal compiles and renders on Apple M2 Pro.
  The Vulkan runtime was not available on this Mac.
- Final scene: 192 primitives, 354,868 triangles, 27,500 probes; fresh Metal GI
  bake about 4.4 seconds. A 180-frame headless benchmark at 2560×1600,
  `PIXEL=4`, averaged 36.16 ms per CPU frame (about 28 frames/second).
  Windowed performance can vary with movement and the visible part of the level.
- Actual menu rebuilds exercised concrete → neighborhood → courtyard →
  neighborhood. The walkthrough crosses the road and grass, holds against a
  wall, releases, and enters a dwelling through the door.
- Grass animation uses `env4.w` for simulation time and the actor position
  independently of ROI reveal. The shade push remains 256 bytes.
- Straight steel chains are reduced to their endpoints while retaining bends.
  Window openings clip polygons, including long steel triangles; they do not
  rely on triangle-centroid deletion.

The normal-transform correction follows the instance transform access described
in [Apple's Metal ray tracing session](https://developer.apple.com/videos/play/wwdc2021/10149/):
inverse-transpose for normals, object-to-world for contour edge distances.

Review artifacts are in `output/neighborhood/`: `overview.png`, `survivor.png`,
`walkthrough.mp4`, `walk.trace` and 16 selected review frames in `final-frames/`.
The 1,120-tick trace produces
an 18.7-second recording at 60 captured simulation frames per second; capture
playback rate is independent of measured interactive rendering performance.

Launch on Retina with `LEVEL='after the rain' WINDOW=1280x800 PIXEL=4`.
Enter starts play, WASD/click moves, Shift jogs, Q/E rotates, scroll or +/- zooms,
and Esc opens the playtest menus.
