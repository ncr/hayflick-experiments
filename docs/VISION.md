# VISION — radosne greyboxy + miodny player (2026-07-12)

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

**Faza 1 — projekcje + radosny look.** (a) projekcja-jako-dane + preset
trimetryczny, przełączane z menu; (b) domknięcie wyglądu-jako-danych
(Look + StyleCfg — po czystce zostały już tylko te dwa — w jeden
runtime'owo przełączany Look); (c) 3–5 kandydatów radosnego looku wg
kotwic; playtest ownera; wybór; nowe goldeny.

**Faza 2 — miodny player.** Jeden continuous stack ruchu (koniec z
grid-locked easingiem): collide-and-slide + pathfinding (A*/funnel +
steering) pod point-n-click; WASD (oba warianty w menu); pad (gilrs);
rampy przyspieszenia/hamowania, limit skrętu, foot-planting IK-lite,
pochylenie w przyspieszenie, osiadanie przy stopie. Scena-siłownia do
feel-testów. Uwaga na próg percepcyjny ~67 px/s przy pixel-snapie.

**Faza 3 — rozkminka gameplayu.** Wywiad projektowy na bazie filarów i smaków;
zamknięcie w spec dopiero, gdy 1 i 2 są "miodne".
