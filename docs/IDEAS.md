# IDEAS — parked directions (owner-approved, realize in a future session)

## 2026-07-27 — break the big-pixel rule on purpose (hi-res islands)

Owner: the game is big pixels — so let's violate that rule deliberately in a
few places. The anchor example: a pixel-art monitor standing in the world that
DISPLAYS high-resolution content — a screen inside the screen, rendered at
native (or near-native) resolution while everything around it keeps the fat
game texels. The contrast is the point: the rule must be visibly load-bearing
everywhere else for the violation to land.

First taste already shipping: the IDE overlay renders at 2× the game's pixel
density (owner ask, same day) — tooling gets the fine grid, the world keeps
the coarse one. The in-world version (monitor/display objects) is the real
realization and needs renderer thought: a hi-res sub-viewport composited into
the low-res buffer BEFORE post, or after it — decide when we get there.
