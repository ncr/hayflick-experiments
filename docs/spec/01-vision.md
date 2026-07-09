# 01 · Vision & Pillars

## One line

An isometric stealth-thief game where the hard part isn't the heist — it's staying
**unidentified** in a living town that remembers, deduces, and hunts.

## The fantasy

You arrive in a town you've never seen. By day you walk the streets as a nobody: you watch
who owns what, who guards it, who wakes when, which window is never latched. By night you
take what you came for. But the town is not a set of alarm cones — it's a set of *minds*. A
neighbour half-remembers a stranger loitering by the silversmith's gate. At dawn the smith
finds the strongbox light and says so. The two facts meet — in a person's head, in a
guard's briefing, in tavern gossip — and now there is a **description** abroad: a person of
your height, in your coat, seen near the scene. Wear that coat tomorrow and a guard's eyes
catch, hold, and narrow. You are searched. The loot is found. The run is over.

So the game you actually play is the management of **identity, appearance, timing, and
evidence** — staying one deduction ahead of a town that is slowly assembling a case against
someone who looks exactly like you.

## Locked shape (round 1)

- **Structure — procedural town per run (roguelike).** Each run generates a fresh town.
  Meta-progression (skills, tools, reputation-as-legend) carries between runs; the details
  are module 02. **A run spans multiple in-game days** in that one town, so the
  discover-and-deduce loop has room to breathe. Suspicion is a *within-run* arc that resets
  when you leave for a new town. (Run anatomy: module 02 / round 2.)
- **Time — living continuous day/night with NPC schedules.** Sim time = `tick / 60` (fixed
  60 Hz). NPCs follow real daily routines (work, market, tavern, home, sleep); the "right
  moment" is something you observe and exploit, not a menu you pick. (Details: module 04.)
- **Violence — non-lethal-first, lethal-possible, always costly.** You can stealth-choke or
  knock out a guard before he raises the alarm, and you can move and hide the body. You *can*
  kill — but a body is the strongest, most persistent evidence in the game and spikes
  town-wide heat far beyond a missing trinket. Murder-to-cover-a-theft is a real, tempting,
  usually-bad option. (Details: modules 07 verbs / 08 AI.)
- **Identity — anonymous player; appearance is identity.** No fixed face or name. What NPCs
  remember and hunt is your *look*: clothes, silhouette, mask, gait. Changing your look is a
  first-class system for shedding accumulated suspicion. This is the mechanic the whole game
  is built to honour. (Details: module 06.)

## Pillars

1. **Memory & deduction over alarm meters.** The antagonist is a reasoning town, not a guard cone.
2. **Identity is a resource you spend and rebuild.** Appearance, reputation, and alibi are consumables.
3. **A living, scheduled town you learn and exploit.** Knowledge of routines is your real weapon.
4. **Every town is a fresh puzzle; the thief who runs them grows.** Roguelike runs, persistent thief.
5. **Violence is available but expensive.** Evidence outlives the act.
6. **The game unfolds.** Stealing is the foundation, not the ceiling — new systems keep
   arriving across the whole length of the game (fencing, forgery, crews, social warfare…).
   The player should repeatedly discover the game is bigger than they thought.

## Non-goals (draft — refine as we go)

- Not primarily a combat game; fighting is a failure-adjacent option, not a power fantasy.
- Not a single persistent open world; the world is regenerated per run.
- Not RPG combat-number-stacking. Progression is **use-based skill** (you get better at what you
  practice) plus **tool unlocks** that expand options and ease friction — gating *access and
  technique*, not inflating a to-hit % in a vacuum. (See module 07.)
- Not a scripted linear narrative; story is emergent from the simulation.
- **Lone wolf** — not a squad or guild-management game. You operate alone; your "organization"
  is tools, contacts, reputation, and a lair (02), never a roster of companions.
