# VISION — radosne greyboxy + miodny player (2026-07-12)

## Active material direction — owner override, 2026-09-05

The owner requested a fresh aesthetic and a new effects pipeline for believable,
low-resolution reinforced concrete: severe corrosion, acid/rain exposure,
fire and blast damage, built from first principles. The sunny porcelain/meadow
palette and box-only surface constraints below are historical for this study.
The `concrete aftermath` level uses its own geometry and shared material shader;
the earlier scenes remain comparisons. Deterministic rendering, Metal support,
the headless game boundary and in-game playtesting still apply. See
`docs/CONCRETE_2026-09-05.md` for the material model and evidence.

The follow-up extends that direction to a coherent neighborhood: damaged
sidewalk pours and asphalt, patchy soil/grass, shader-driven wind and player
interaction, ruined dwellings, and a proportioned older survivor with a new
articulated rig and contact response. `after the rain` is the playable showcase.
Animated vegetation and breathing are deterministic functions of simulation
time: a fixed camera alone no longer implies a static image in this level.
See `docs/NEIGHBORHOOD_2026-09-05.md`.

## Previous direction

Status: **BINDING**. Zastępuje `docs/spec-reset-handoff.md` i cały `docs/spec/`
(usunięte; historia pod tagiem `archive/pre-joyful-reset`). Właściciel wizji:
Jacek. Gra: **Hayflick** (Beztroska Games). Rozwój: 100% Claude Code.

## Dlaczego reset

Dotychczasowe kierunki (goo-arena, thief/dedukcja) brzmiały dobrze na papierze,
ale były niegrywalne. Nowy porządek pracy: **najpierw estetyka, potem feel
gracza, dopiero potem gameplay** — i owner musi być zadowolony z każdej warstwy,
zanim powstanie następna.

## Trzy filary (kolejność obowiązuje)

1. **Radosna, beztroska estetyka.** Greyboxy, ale wesołe — koniec z "brudem"
   (dither-cienie, grain, noir/teal, niski klucz). Kotwice wybrane przez ownera:
   - **słoneczny dzień** — ciepłe słońce, błękit nieba, długie miękkie cienie;
   - **biel + akcent** — czyste jasne powierzchnie, jeden ciepły akcent;
   - **cukierkowe pastele** — nasycona, wysokokluczowa, wielobarwna paleta.
   Źródłem estetyki są pierwotne koncepty (dyrektywa ownera 2026-07-12):
   **`docs/concepts/`** — biały monolit w złotym polu, golden hour, wielkie
   niebo (patrz tamtejszy README). Decyzje wizualne rozstrzygamy ku nim.
   Kontur brył (outline w tonemap) to **składnik-knob** każdego looku, nie
   dominanta stylu. Pixel contract + RT/GI zostają — to jest tożsamość renderu.
2. **Miodny player klasy AAA.** Masa, bezwładność, antycypacja — w animacji
   (proceduralnej, bez assetów) i w sterowaniu. Cztery wejścia: mysz
   (point-n-click + pathfinding omijający przeszkody), trackpad (jak mysz),
   klawiatura (dwa warianty do playtestu: screen-relative 8-way vs
   obrót+przód/tył), pad (analog → ciągła prędkość; później, brak pada pod
   ręką). Priorytet dopracowania: mysz/trackpad → WASD → pad.
3. **Gameplay — dopiero po 1 i 2.** Eksploracja ostrożna, wywiadem, nie kodem.
   Wektor smaków ownera: Cannon Fodder, Fallout 1/2, przygodówki point-n-click,
   Alien Breed, Jagged Alliance. Owner gra kilka gier rocznie, ma mało czasu —
   gra musi szanować krótkie sesje.

## Decyzja: projekcja jako dane (PRZED wyborem looku)

Iso 2:1 przestaje być zahardkodowane. `iso-core` uogólnia się do
**projekcji-jako-danych**: projekcja = dwa całkowitoliczbowe wektory pikselowe
osi gruntu (iso 2:1 ≙ `(2,-1)/(2,1)`), z których WYPROWADZA SIĘ bazę kamery
(yaw/pitch/roll), foreshortening, walidator wymiarów wu i mapowanie inputu.
Inwarianty (czyste schody Bresenhama, lattice, R) mają zachodzić z konstrukcji,
nie z tuningu. Presety: `iso21` + co najmniej jeden **trimetryczny w duchu
Fallouta (90/120/150)**. Wybór projekcji w menu ESC; look dobieramy dopiero
w docelowej projekcji.

## Proces i tooling (zasady stałe)

- **Menu ESC to hub playtestowy ownera.** Wybór looku, projekcji, schematu
  sterowania, wariantów A/B — zawsze z menu, **nigdy przez parametry CLI**
  (env-knoby zostają dla agenta/harnessu).
- **Bramka wyjścia z każdej fazy** = playtest ownera z menu + nagrany klip
  pokazujący zamierzone zachowanie. Zielone testy nie wystarczają.
- **Determinizm jest nienegocjowalny**: fixed tick 60 Hz, trace replay,
  state-hash, byte-goldeny per maszyna/backend, zero wall-clocka i
  nieseedowanego RNG w simie.
- **Legacy usuwamy natychmiast**, gdy tylko generuje niepotrzebną robotę.
  Git + tagi archiwalne są siatką bezpieczeństwa; nie utrzymujemy kodu ani
  testów "do omijania".
- **Lockstep GLSL/MSL** (Vulkan na spawnerze, Metal na M2 Pro) bez zmian.
- Nagrywanie i interpretacja klipów (record-gameplay, DEMO/SHOT) to standard
  weryfikacji; debug-overlay ruchu (wektor prędkości, ścieżka, stan animacji)
  do włączenia klawiszem.

## Fazy

**Faza 0 — czystka (DONE 2026-07-12, w dwóch cięciach).** Wylatują:
goo/arena (sim+bronie+taktyki+karty+pass shaderowy+oracle), sim dedukcji
thief, stare teksturowane sceny house/lab/grid z goldenami, generatory
cave/village/building/floorplan, docs/spec — a w drugim cięciu (dyrektywa
ownera tego samego dnia) także generator miasta, NPC-e, drzwi/okna, zegar
dnia i seedy. Zostaje: renderer (rt-probe/rt-viewer), iso-core, sim-core
oraz **gym** — JEDEN ręcznie zbudowany poziom (kilka wolnostojących murków,
jeden budynek z przejściem, dwie lampy, gracz; `house_game::gym`) jako
jedyny testbed. LOOKi i artykułowana figurka gracza przeżyły. Archiwa:
tagi `archive/pre-joyful-reset` i `archive/town-testbed`. Nowe goldeny
dopiero po fazie looku (na czas eksploracji gate golden zawieszony, testy
headless obowiązują).

**Faza 1 — projekcje + radosny look.** (a) **DONE 2026-07-12; owner
wybrał `trimetric` jako projekcję gry (domyślna).** Projekcja-jako-dane
w `iso-core` (`Projection`: dwa całkowitoliczbowe wektory pikselowe →
kamera/foreshortening/mapowanie inputu/walidator wyprowadzone, inwarianty
z konstrukcji). `trimetric` = (40,10)/(-20,20): falloutowski schodek 4:1
na osi X, czysta przekątna 1:1 na Z, pitch 30°, zero rolla (**kontrakt
ścian**: pion świata rzutuje się na pion ekranu, wymuszone w derive) i
S = 20√5 px/wu — w 1.2% od iso21, więc przełączanie porównuje kąt, nie
zoom (skala = j=10 rodziny (4j,j)/(-2j,2j); j=8 było optycznie ~21%
mniejsze). Architektura autorowana na siatce 0.1 wu (czysta krata
trimetryka). `iso21` zostaje w menu jako referencja A/B; env `PROJ` dla
harnessu. (b) **DONE 2026-07-12.** Wygląd-jako-dane domknięty: `Look` =
paleta + lampy + env + **słońce/niebo jako dane** (`SunSky`: kierunek i
barwa słońca, gradient nieba, tint pustki — dawne stałe czterech shaderów,
teraz wiersze push env1..4 na obu backendach) + post-stack (`StyleCfg`) +
ekspozycja + odpowiedź powierzchni (spec/gloss/bump/gi). Wiersz "look" w
menu ESC przełącza looki RUNTIME'owo (rebuild sceny + rebake sond GI,
cache dyskowy per look, ~2.5 s pierwszy raz na M2); env-knoby (`LOOK`,
`GRADE`, `SAT`, `EXPOSURE`, `BUMP`, …) zostają nadpisaniami dla
agenta/harnessu, a `LOOK_SWITCH=<name>` weryfikuje ścieżkę runtime
bezgłowo. Stare bundle `STYLE=` i looki ery brudu skasowane (archiwum w
git). (c) **kierunek WYBRANY (owner, 2026-07-12, po przeglądzie 4 kandydatów
tecta/meadow/porcelain/sorbet): porcelain × meadow**, zmergowane jako
preset **`polana`** — po drugim przeglądzie tego samego dnia JEDYNY look
(dyrektywa: „let's have the polana view, delete rest"): `porcelain`/
`meadow`/`tecta`/`sorbet` skasowane (git), wiersz „look" zniknął z menu
ESC (jeden preset = martwe UI; pin testowy przywróci go przy drugim
looku), a `LOOK_SWITCH=polana` został harness-owym testem tożsamości
force-rebuildu (maszyneria runtime-switch z 1b żyje). Treść looku:
super-czyste porcelanowe bryły (minimalne bumps, lekki sheen), bujna
nasycona zieleń i niebo („lush greens and sky"), rytm elewacji = czyste
panele + co jakiś czas (parzyste komórki świata; elewacje 5-komórkowe
mają 2 symetryczne okna, drzwi flankowane) CAŁOŚCIENNE czarne okno —
po refinemencie ownera PRAWDZIWE otwory w murze z taflą przydymionego
szkła, przez którą primary ray przechodzi z tintem transmisji („black
tinted, ale przezroczyste"; shadow raye i bake sond widzą szkło jako
nieprzezroczyste, więc kontrakt GI/NEE stoi; w cutawayu WALLCUT szklane
stuby są celowo 0.3125 wyższe od murów — kryją ościeże i powtarzają
motyw listwy nad koroną). Bursztynowy akcent z porcelain, wędrowiec w
czerwieni z meadow, trawa-dress na Outdoor (deterministyczny hash, bez
RNG). CZEKA: playtest ownera z menu ESC + lock + nowe goldeny.

**Faza 2 — miodny player.** Jeden continuous stack ruchu (koniec z
grid-locked easingiem): collide-and-slide + pathfinding (A*/funnel +
steering) pod point-n-click; WASD (oba warianty w menu); pad (gilrs);
rampy przyspieszenia/hamowania, limit skrętu, foot-planting IK-lite,
pochylenie w przyspieszenie, osiadanie przy stopie. Scena-siłownia do
feel-testów. Uwaga na próg percepcyjny ~67 px/s przy pixel-snapie.

**Faza 3 — rozkminka gameplayu.** Wywiad projektowy na bazie filarów i smaków;
zamknięcie w spec dopiero, gdy 1 i 2 są "miodne".
