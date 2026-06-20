// plans_techniques.rs — house floor-plan generators, textually included into
// bin/plans.rs (NOT a crate module). Each is fn(seed) -> LevelSpec producing
// RECTANGULAR rooms (RoomSpec is one rect) + corridor rects + doors.
//
// Design goals from the research synthesis (see /tmp/floorplans/_research_surveys.json):
//   * explicit CIRCULATION — every room opens onto a corridor; no walking
//     through one room to reach another (no enfilade).
//   * ZONING — public (living/kitchen/dining/foyer) vs private (bedrooms/bath)
//     vs service (utility); bath + utility tagged as SERVICE rooms (rendered
//     distinct).
//   * SIZE VARIETY — a large living room, small baths; not uniform cubicles.
// The techniques differ in their CIRCULATION TOPOLOGY: line, cross, tree,
// designed-line, and loop.

// --- shared band slicer: cut [0,total) into rooms of width in [min_w,max_w] ---
fn slice_band(rng: &mut Rng, total: i32, min_w: i32, max_w: i32) -> Vec<(i32, i32)> {
    let mut out = Vec::new();
    let mut x = 0;
    while x < total {
        let rem = total - x;
        let mut w = if rem <= max_w { rem } else { rng.range(min_w, max_w + 1) };
        if rem - w < min_w {
            w = rem; // absorb a would-be sliver
        }
        out.push((x, w));
        x += w;
    }
    out
}

/// Merge the widest 2 adjacent slots into one (gives a dominant "living"-sized
/// room so the plan isn't uniform). Returns the merged slot index.
fn merge_widest_pair(slots: &mut Vec<(i32, i32)>) -> usize {
    if slots.len() < 2 {
        return 0;
    }
    let mut best = 0;
    let mut best_w = -1;
    for i in 0..slots.len() - 1 {
        let w = slots[i].1 + slots[i + 1].1;
        if w > best_w {
            best_w = w;
            best = i;
        }
    }
    let (x0, w0) = slots[best];
    let (_, w1) = slots[best + 1];
    slots[best] = (x0, w0 + w1);
    slots.remove(best + 1);
    best
}

/// Integer apportionment of `total` by `weights` (cumulative-rounding → sums
/// exactly to `total`); each weight jittered ±`jit` fraction. Returns widths.
fn apportion(rng: &mut Rng, total: i32, weights: &[f32], jit: f32) -> Vec<i32> {
    let w: Vec<f32> = weights.iter().map(|&x| (x * (1.0 + (rng.frac() * 2.0 - 1.0) * jit)).max(0.04)).collect();
    let sum: f32 = w.iter().sum();
    let mut acc = 0.0;
    let mut prev = 0;
    let mut out = Vec::with_capacity(w.len());
    for &wi in &w {
        acc += wi;
        let b = ((acc / sum) * total as f32).round() as i32;
        out.push((b - prev).max(1));
        prev = b;
    }
    // fix any drift so the widths sum to exactly `total`
    let diff = total - out.iter().sum::<i32>();
    if diff != 0 {
        let imax = (0..out.len()).max_by_key(|&i| out[i]).unwrap();
        out[imax] = (out[imax] + diff).max(1);
    }
    out
}

// ============================================================ T1: hall_rooms
/// Single central hallway (spine) with one row of rooms each side — the canonical
/// believable small house. Public wing (foyer/living/kitchen/dining) below the
/// hall, sleeping wing (bedrooms + bath) above. Every room doors onto the hall;
/// the foyer has the front door. Room widths are stochastic with a merged
/// living room. Circulation topology: a LINE.
fn hall_rooms(seed: u64) -> LevelSpec {
    let mut rng = Rng(seed ^ 0x4057_E0FF_0CE0_0001);
    let hall = 3;
    let top_d = rng.range(7, 11); // sleeping wing depth
    let bot_d = rng.range(8, 12); // living wing depth (deeper: bigger rooms)
    let (cz0, cz1) = (top_d, top_d + hall);
    let h = cz1 + bot_d;
    let w = rng.range(32, 42);

    let mut rooms: Vec<Rect> = Vec::new();
    let mut services: Vec<Rect> = Vec::new();
    let mut svc_doors: Vec<([f32; 4], Vec3)> = Vec::new();
    let mut room_doors: Vec<([f32; 4], Vec3)> = Vec::new();

    // sleeping wing (top): bedrooms, narrowest tagged as the bathroom (service)
    let top = slice_band(&mut rng, w, 6, 9);
    let bath_i = (0..top.len()).min_by_key(|&i| top[i].1).unwrap_or(0);
    for (i, &(x, ww)) in top.iter().enumerate() {
        let r = [x, 0, x + ww, cz0];
        let door = hdoor(cz0, x + ww / 2);
        if i == bath_i && top.len() >= 3 {
            services.push(r);
            svc_doors.push(door);
        } else {
            rooms.push(r);
            room_doors.push(door);
        }
    }

    // living wing (bottom): foyer (leftmost), big living (merged), kitchen,
    // dining, utility (rightmost, service)
    let mut bot = slice_band(&mut rng, w, 5, 8);
    let living_i = merge_widest_pair(&mut bot);
    let foyer_i = 0usize;
    let util_i = bot.len() - 1;
    let mut foyer_xc = bot[0].0 + bot[0].1 / 2;
    for (i, &(x, ww)) in bot.iter().enumerate() {
        let r = [x, cz1, x + ww, h];
        let door = hdoor(cz1, x + ww / 2);
        if i == util_i && bot.len() >= 4 {
            services.push(r);
            svc_doors.push(door);
        } else {
            rooms.push(r);
            room_doors.push(door);
        }
        if i == foyer_i {
            foyer_xc = x + ww / 2;
        }
        let _ = living_i;
    }

    let corridors: Vec<Rect> = vec![[0, cz0, w, cz1]];
    let mut doors = Vec::new();
    for d in room_doors.into_iter().chain(svc_doors) {
        push_door(&mut doors, d);
    }
    // front door on the foyer's south exterior wall
    push_door(&mut doors, hdoor(h, foyer_xc));

    assemble(&rooms, &corridors, &services, doors, Vec3::new(foyer_xc as f32 + 0.5, 0.0, h as f32 - 1.5), seed)
}

// =========================================================== T2: cross_hall
/// A '+' of two hallways (main horizontal + one vertical) splitting the floor
/// into 4 zones, each a single row of rooms onto the nearest hall. Public rooms
/// left, sleeping rooms right; front door (south) and back door (north) on the
/// vertical hall. Circulation topology: a CROSS (two axes, 2 exterior exits).
fn cross_hall(seed: u64) -> LevelSpec {
    let mut rng = Rng(seed ^ 0x0C_2055_A11_0001);
    let hall = 3;
    let top_d = rng.range(7, 11);
    let bot_d = rng.range(7, 11);
    let (cz0, cz1) = (top_d, top_d + hall);
    let h = cz1 + bot_d;
    let left_w = rng.range(11, 16);
    let right_w = rng.range(11, 16);
    let (vx0, vx1) = (left_w, left_w + hall);
    let w = vx1 + right_w;

    let mut rooms: Vec<Rect> = Vec::new();
    let mut services: Vec<Rect> = Vec::new();
    let mut doors_q: Vec<(bool, ([f32; 4], Vec3))> = Vec::new(); // (is_service, door)

    // one band of rooms over x-span [x0,x1) in z-band [z0,z1), doored onto the
    // horizontal hall line `hline`. `private`+narrowest → bathroom (service).
    let fill = |rng: &mut Rng, x0: i32, x1: i32, z0: i32, z1: i32, hline: i32, top: bool, private: bool, rooms: &mut Vec<Rect>, services: &mut Vec<Rect>, doors_q: &mut Vec<(bool, ([f32; 4], Vec3))>| {
        let span = x1 - x0;
        let slots = slice_band(rng, span, 5, 8);
        let bath_i = if private && slots.len() >= 2 { (0..slots.len()).min_by_key(|&i| slots[i].1).unwrap() } else { usize::MAX };
        for (i, &(xo, ww)) in slots.iter().enumerate() {
            let (rx0, rx1) = (x0 + xo, x0 + xo + ww);
            let r = if top { [rx0, z0, rx1, z1] } else { [rx0, z0, rx1, z1] };
            let door = hdoor(hline, rx0 + ww / 2);
            if i == bath_i {
                services.push(r);
                doors_q.push((true, door));
            } else {
                rooms.push(r);
                doors_q.push((false, door));
            }
        }
    };

    // top band, split by the vertical hall: public left, sleeping right
    fill(&mut rng, 0, vx0, 0, cz0, cz0, true, false, &mut rooms, &mut services, &mut doors_q);
    fill(&mut rng, vx1, w, 0, cz0, cz0, true, true, &mut rooms, &mut services, &mut doors_q);
    // bottom band
    fill(&mut rng, 0, vx0, cz1, h, cz1, false, false, &mut rooms, &mut services, &mut doors_q);
    fill(&mut rng, vx1, w, cz1, h, cz1, false, true, &mut rooms, &mut services, &mut doors_q);

    let corridors: Vec<Rect> = vec![[0, cz0, w, cz1], [vx0, 0, vx1, h]];
    let mut doors = Vec::new();
    for (_, d) in doors_q {
        push_door(&mut doors, d);
    }
    let vxc = vx0 + hall / 2;
    push_door(&mut doors, hdoor(h, vxc)); // front door (south, on vertical hall)
    push_door(&mut doors, hdoor(0, vxc)); // back door (north, on vertical hall)

    assemble(&rooms, &corridors, &services, doors, Vec3::new(vxc as f32 + 0.5, 0.0, h as f32 - 1.5), seed)
}

// ======================================================== T3: bsp_corridors
/// Recursive guillotine partition where EVERY split leaves a hallway-width gap
/// as a corridor. Because each child's gap spans the child's full extent it
/// touches the parent's gap, so all corridors connect and every leaf room
/// borders a corridor (no enfilade). The "fixed BSP" from the survey: split the
/// longer side, jitter the cut near centre, stop on a size threshold (not depth)
/// so room sizes vary 2-dimensionally. Circulation topology: a TREE.
fn bsp_corridors(seed: u64) -> LevelSpec {
    let mut rng = Rng(seed ^ 0xB59_C0FF_EE00_0001);
    let w = rng.range(32, 40);
    let h = rng.range(24, 30);
    let hall = 2;
    let min_room = 5;
    let max_room = 11;
    // need 2*min_room + hall to split
    let min_split = 2 * min_room + hall;

    let mut rooms: Vec<Rect> = Vec::new();
    let mut corridors: Vec<Rect> = Vec::new();
    let mut stack: Vec<(Rect, i32)> = vec![([0, 0, w, h], 0)];
    while let Some((r, depth)) = stack.pop() {
        let rw = r[2] - r[0];
        let rh = r[3] - r[1];
        let long = rw.max(rh);
        let split_h = rw >= rh; // split the longer side (vertical cut if wider)
        let dim = if split_h { rw } else { rh };
        // stop: too small to split, or small enough to be a room (random)
        if dim < min_split || depth >= 6 || (long <= max_room && rng.chance(1, 2)) {
            rooms.push(r);
            continue;
        }
        // cut position jittered ±dim/8 around centre, clamped so both children
        // keep >= min_room and the gap fits
        let centre = dim / 2;
        let jit = (dim / 8).max(1);
        let mut cut = centre + rng.range(-jit, jit + 1);
        cut = cut.clamp(min_room, dim - min_room - hall);
        if split_h {
            let gx = r[0] + cut;
            corridors.push([gx, r[1], gx + hall, r[3]]); // vertical gap spans full height
            stack.push(([r[0], r[1], gx, r[3]], depth + 1));
            stack.push(([gx + hall, r[1], r[2], r[3]], depth + 1));
        } else {
            let gz = r[1] + cut;
            corridors.push([r[0], gz, r[2], gz + hall]); // horizontal gap spans full width
            stack.push(([r[0], r[1], r[2], gz], depth + 1));
            stack.push(([r[0], gz + hall, r[2], r[3]], depth + 1));
        }
    }

    // doors: each room → its first adjacent corridor. tag the smallest ~1/5 of
    // rooms as service (bath/utility) for visual zoning.
    let mut order: Vec<usize> = (0..rooms.len()).collect();
    order.sort_by_key(|&i| area(&rooms[i]));
    let n_svc = (rooms.len() / 5).max(1);
    let svc_set: std::collections::HashSet<usize> = order[..n_svc].iter().copied().collect();

    let mut real: Vec<Rect> = Vec::new();
    let mut services: Vec<Rect> = Vec::new();
    let mut doors = Vec::new();
    // entry: the room on the south wall nearest the horizontal centre
    let entry = (0..rooms.len()).filter(|&i| rooms[i][3] == h).min_by_key(|&i| ((rooms[i][0] + rooms[i][2]) / 2 - w / 2).abs());
    let mut start = Vec3::new(w as f32 * 0.5, 0.0, h as f32 - 1.5);
    for i in 0..rooms.len() {
        let r = rooms[i];
        // door to first adjacent corridor
        for c in &corridors {
            if let Some(d) = shared_door(&r, c) {
                push_door(&mut doors, d);
                break;
            }
        }
        if Some(i) == entry {
            let xc = (r[0] + r[2]) / 2;
            push_door(&mut doors, hdoor(h, xc));
            start = Vec3::new(xc as f32 + 0.5, 0.0, h as f32 - 1.5);
        }
        if svc_set.contains(&i) {
            services.push(r);
        } else {
            real.push(r);
        }
    }

    assemble(&real, &corridors, &services, doors, start, seed)
}

// ======================================================== T4: program_pack
/// A DESIGNED architectural program slotted into the footprint with seed-varied
/// proportions (not random widths): the sleeping wing is master + 2 bedrooms +
/// bath at realistic area ratios; the living wing is foyer + a dominant living
/// room + kitchen + dining. Spine hall between. This is the graph/adjacency
/// "designed plan" direction — consistent realistic proportions. Topology: a
/// LINE, but proportion-controlled rather than stochastic.
fn program_pack(seed: u64) -> LevelSpec {
    let mut rng = Rng(seed ^ 0x9_03A_7AC0_0001);
    let hall = 3;
    let top_d = rng.range(10, 13); // sleeping wing
    let bot_d = rng.range(10, 13); // living wing (a touch deeper)
    let (cz0, cz1) = (top_d, top_d + hall);
    let h = cz1 + bot_d;
    let w = rng.range(34, 42);

    let mut rooms: Vec<Rect> = Vec::new();
    let mut services: Vec<Rect> = Vec::new();
    let mut doors = Vec::new();

    // sleeping wing: master(0.32) | bed(0.24) | bed(0.24) | bath(0.20)
    let top_w = apportion(&mut rng, w, &[0.32, 0.24, 0.24, 0.20], 0.12);
    let mut x = 0;
    for (i, &ww) in top_w.iter().enumerate() {
        let r = [x, 0, x + ww, cz0];
        let door = hdoor(cz0, x + ww / 2);
        if i == top_w.len() - 1 {
            services.push(r); // bath
        } else {
            rooms.push(r);
        }
        push_door(&mut doors, door);
        x += ww;
    }

    // living wing: foyer(0.14) | living(0.40) | kitchen(0.24) | dining(0.22)
    let bot_w = apportion(&mut rng, w, &[0.14, 0.40, 0.24, 0.22], 0.10);
    let mut x = 0;
    let mut foyer_xc = bot_w[0] / 2;
    for (i, &ww) in bot_w.iter().enumerate() {
        let r = [x, cz1, x + ww, h];
        rooms.push(r);
        push_door(&mut doors, hdoor(cz1, x + ww / 2));
        if i == 0 {
            foyer_xc = x + ww / 2;
        }
        x += ww;
    }

    let corridors: Vec<Rect> = vec![[0, cz0, w, cz1]];
    push_door(&mut doors, hdoor(h, foyer_xc)); // front door at the foyer

    assemble(&rooms, &corridors, &services, doors, Vec3::new(foyer_xc as f32 + 0.5, 0.0, h as f32 - 1.5), seed)
}

// ========================================================== T5: loop_ring
/// A circulation LOOP: two horizontal halls joined at both ends by vertical
/// connectors form a rectangular ring, so you can walk a circuit (no
/// dead-ending back through rooms — Dormans' cyclic idea). Rooms in three bands:
/// north strip onto the top hall, a middle band between the halls, south strip
/// onto the bottom hall. Front door on the south strip.
fn loop_ring(seed: u64) -> LevelSpec {
    let mut rng = Rng(seed ^ 0x100_9_8E0_0001);
    let hh = 2; // hall thickness
    let v = 2; // vertical connector width
    let north_d = rng.range(5, 8);
    let mid_d = rng.range(7, 10);
    let south_d = rng.range(5, 8);
    let t0 = north_d;
    let b0 = t0 + hh + mid_d;
    let h = b0 + hh + south_d;
    let w = rng.range(30, 40);

    let mut rooms: Vec<Rect> = Vec::new();
    let mut services: Vec<Rect> = Vec::new();
    let mut doors = Vec::new();

    // north strip: bedrooms, narrowest = bath (service); door onto top hall
    let north = slice_band(&mut rng, w, 6, 9);
    let bath_i = (0..north.len()).min_by_key(|&i| north[i].1).unwrap_or(0);
    for (i, &(x, ww)) in north.iter().enumerate() {
        let r = [x, 0, x + ww, t0];
        push_door(&mut doors, hdoor(t0, x + ww / 2));
        if i == bath_i && north.len() >= 3 {
            services.push(r);
        } else {
            rooms.push(r);
        }
    }

    // middle band (between halls), x in [v, w-v]; a big merged living + others.
    // doored onto BOTH halls is overkill — one door onto the top hall.
    let mut mid = slice_band(&mut rng, w - 2 * v, 5, 9);
    merge_widest_pair(&mut mid);
    for &(x, ww) in &mid {
        let (rx0, rx1) = (v + x, v + x + ww);
        rooms.push([rx0, t0 + hh, rx1, b0]);
        push_door(&mut doors, hdoor(t0 + hh, rx0 + ww / 2)); // onto top hall
    }

    // south strip: foyer (leftmost) + utility (rightmost, service); front door
    let south = slice_band(&mut rng, w, 6, 9);
    let util_i = south.len() - 1;
    let mut foyer_xc = south[0].0 + south[0].1 / 2;
    for (i, &(x, ww)) in south.iter().enumerate() {
        let r = [x, b0 + hh, x + ww, h];
        push_door(&mut doors, hdoor(b0 + hh, x + ww / 2)); // onto bottom hall
        if i == util_i && south.len() >= 3 {
            services.push(r);
        } else {
            rooms.push(r);
        }
        if i == 0 {
            foyer_xc = x + ww / 2;
        }
    }
    push_door(&mut doors, hdoor(h, foyer_xc));

    let corridors: Vec<Rect> = vec![
        [0, t0, w, t0 + hh],        // top hall
        [0, b0, w, b0 + hh],        // bottom hall
        [0, t0, v, b0 + hh],        // left connector
        [w - v, t0, w, b0 + hh],    // right connector
    ];

    assemble(&rooms, &corridors, &services, doors, Vec3::new(foyer_xc as f32 + 0.5, 0.0, h as f32 - 1.5), seed)
}

// --- slice a z-span [start,end) into runs of depth in [min_d,max_d] ---
fn slice_runs(rng: &mut Rng, start: i32, end: i32, min_d: i32, max_d: i32) -> Vec<(i32, i32)> {
    let mut out = Vec::new();
    let mut z = start;
    while z < end {
        let rem = end - z;
        let mut d = if rem <= max_d { rem } else { rng.range(min_d, max_d + 1) };
        if rem - d < min_d {
            d = rem;
        }
        out.push((z, z + d));
        z += d;
    }
    out
}

/// Mirror a built plan across X and/or Z in place (distinctness pass). Bounds
/// are derived from the rects so any footprint (incl. protrusions) reflects
/// correctly.
fn reflect(rooms: &mut [Rect], services: &mut [Rect], corridors: &mut [Rect], doors: &mut [([f32; 4], Vec3)], start: &mut Vec3, flip_x: bool, flip_z: bool) {
    if !flip_x && !flip_z {
        return;
    }
    let wt = rooms.iter().chain(services.iter()).chain(corridors.iter()).map(|r| r[2]).max().unwrap();
    let ht = rooms.iter().chain(services.iter()).chain(corridors.iter()).map(|r| r[3]).max().unwrap();
    let fr = |r: &mut Rect| {
        if flip_x {
            *r = [wt - r[2], r[1], wt - r[0], r[3]];
        }
        if flip_z {
            *r = [r[0], ht - r[3], r[2], ht - r[1]];
        }
    };
    rooms.iter_mut().for_each(&fr);
    services.iter_mut().for_each(&fr);
    corridors.iter_mut().for_each(&fr);
    for (c, hg) in doors.iter_mut() {
        if flip_x {
            *c = [wt as f32 - c[2], c[1], wt as f32 - c[0], c[3]];
            hg.x = wt as f32 - hg.x;
        }
        if flip_z {
            *c = [c[0], ht as f32 - c[3], c[2], ht as f32 - c[1]];
            hg.z = ht as f32 - hg.z;
        }
    }
    if flip_x {
        start.x = wt as f32 - start.x;
    }
    if flip_z {
        start.z = ht as f32 - start.z;
    }
}

// ===================================================== T6: hybrid (mixed)
/// MIXES several techniques the way real homes are actually organized, instead
/// of one uniform treatment everywhere:
///   * OPEN-PLAN public — living/dining are a single large great room (no
///     internal walls), the modern domestic signature;
///   * CELLULAR private wing — bedrooms off a short hall (spine technique),
///     each with its own door (no enfilade);
///   * MASTER SUITE — ensuite bath + walk-in closet reached *through* the
///     master bedroom (intentional, realistic enfilade — the one place it's
///     correct);
///   * IRREGULAR FOOTPRINT — an attached garage protrusion breaks the rectangle
///     so the outline isn't a clean box.
/// The result reads less synthetic because connection style varies by zone.
fn hybrid(seed: u64) -> LevelSpec {
    let mut rng = Rng(seed ^ 0x04_B1E_D000_0001);
    let priv_d = rng.range(12, 16); // bedroom wing depth (north)
    let pub_d = rng.range(10, 13); // public depth (south)
    let h = priv_d + pub_d;
    let hallw = rng.range(2, 4);
    let cw = rng.range(4, 6); // closet/ensuite column width
    let left_w = rng.range(cw + 6, cw + 10); // left column (master + bedrooms)
    let hx0 = left_w;
    let hx1 = hx0 + hallw;
    let right_w = rng.range(7, 11);
    let w = hx1 + right_w;
    let m_d = rng.range(7, 10).min(priv_d - 4); // master depth

    let mut rooms: Vec<Rect> = Vec::new();
    let mut services: Vec<Rect> = Vec::new();
    let mut doors: Vec<([f32; 4], Vec3)> = Vec::new();

    let corridors: Vec<Rect> = vec![[hx0, 0, hx1, priv_d]]; // private-wing hall (canonical)

    // master suite (NW): master + walk-in closet + ensuite, chained off master
    rooms.push([cw, 0, hx0, m_d]);
    doors.push(vdoor(hx0, m_d / 2)); // master -> hall
    services.push([0, 0, cw, m_d / 2]); // closet
    services.push([0, m_d / 2, cw, m_d]); // ensuite
    doors.push(vdoor(cw, m_d / 4)); // master -> closet
    doors.push(vdoor(cw, m_d / 2 + (m_d - m_d / 2) / 2)); // master -> ensuite

    // remaining left bedrooms below the master, each doored onto the hall
    for (z0, z1) in slice_runs(&mut rng, m_d, priv_d, 4, 6) {
        rooms.push([0, z0, hx0, z1]);
        doors.push(vdoor(hx0, (z0 + z1) / 2));
    }
    // right bedrooms + a bath (the narrowest run, tagged service)
    let runs = slice_runs(&mut rng, 0, priv_d, 4, 6);
    let bath_i = (0..runs.len()).min_by_key(|&i| runs[i].1 - runs[i].0).unwrap_or(0);
    for (i, &(z0, z1)) in runs.iter().enumerate() {
        let r = [hx1, z0, w, z1];
        doors.push(vdoor(hx1, (z0 + z1) / 2));
        if i == bath_i && runs.len() >= 2 {
            services.push(r);
        } else {
            rooms.push(r);
        }
    }

    // public zone (south): narrow foyer + open public + kitchen
    rooms.push([hx0, priv_d, hx1, h]); // foyer (entry buffer, aligned with the hall)
    doors.push(hdoor(priv_d, hx0 + hallw / 2)); // foyer <-> hall
    // left of the foyer: either ONE open great room, or living/dining split
    if rng.chance(1, 2) {
        let mz = priv_d + pub_d / 2;
        rooms.push([0, priv_d, hx0, mz]); // dining (back)
        rooms.push([0, mz, hx0, h]); // living (front)
        doors.push(hdoor(mz, hx0 / 2)); // dining <-> living (open)
        doors.push(vdoor(hx0, priv_d + pub_d / 4)); // dining <-> foyer
        doors.push(vdoor(hx0, mz + (h - mz) / 2)); // living <-> foyer
    } else {
        rooms.push([0, priv_d, hx0, h]); // one big open great room
        doors.push(vdoor(hx0, priv_d + pub_d / 2)); // great <-> foyer
    }
    rooms.push([hx1, priv_d, w, h]); // kitchen
    doors.push(vdoor(hx1, priv_d + pub_d / 2)); // kitchen <-> foyer
    doors.push(hdoor(h, hx0 + hallw / 2)); // front door at the foyer

    // attached garage, flush with the public band (juts past the bedroom wing)
    if rng.chance(3, 4) {
        let gw = rng.range(7, 10);
        services.push([w, priv_d, w + gw, h]);
        doors.push(vdoor(w, priv_d + pub_d / 2)); // kitchen -> garage
    }

    let mut start = Vec3::new((hx0 + hallw / 2) as f32 + 0.5, 0.0, h as f32 - 1.5);
    let (mut rooms, mut services, mut doors) = (rooms, services, doors);
    let mut corridors = corridors;
    reflect(&mut rooms, &mut services, &mut corridors, &mut doors, &mut start, rng.chance(1, 2), rng.chance(1, 2));

    let mut dvec = Vec::new();
    for d in doors {
        push_door(&mut dvec, d);
    }
    assemble(&rooms, &corridors, &services, dvec, start, seed)
}

// ===================================================== T7: bungalow (open core)
/// A SMALL cottage with NO hallway: one big LIVING room is the circulation hub,
/// and a couple of bedrooms + bath + kitchen open directly off it (the genuine
/// pattern of old small houses — "rooms off the living room"). Few rooms, small
/// compact footprint — structurally unlike the hall/spine plans.
fn bungalow(seed: u64) -> LevelSpec {
    let mut rng = Rng(seed ^ 0xB04_6A10_0000_0001);
    let w = rng.range(18, 24);
    let bd = rng.range(7, 10); // back bedroom band depth
    let fd = rng.range(8, 11); // front living/kitchen depth
    let h = bd + fd;

    let mut rooms: Vec<Rect> = Vec::new();
    let mut services: Vec<Rect> = Vec::new();
    let mut doors: Vec<([f32; 4], Vec3)> = Vec::new();

    // front: living (the hub, left & large) + kitchen (right)
    let kx = rng.range(w * 11 / 20, w * 3 / 4);
    rooms.push([0, bd, kx, h]); // living
    rooms.push([kx, bd, w, h]); // kitchen
    doors.push(vdoor(kx, bd + fd / 2)); // kitchen <-> living
    doors.push(hdoor(h, kx / 2)); // front door into the living room

    // back: 2-3 bedrooms + a bath (narrowest), each opening onto the living/kitchen
    let runs = slice_band(&mut rng, w, 5, 8);
    let bath_i = (0..runs.len()).min_by_key(|&i| runs[i].1).unwrap_or(0);
    for (i, &(x, ww)) in runs.iter().enumerate() {
        let r = [x, 0, x + ww, bd];
        doors.push(hdoor(bd, x + ww / 2)); // onto the hub below
        if i == bath_i && runs.len() >= 2 {
            services.push(r);
        } else {
            rooms.push(r);
        }
    }

    let mut start = Vec3::new((kx / 2) as f32 + 0.5, 0.0, h as f32 - 1.5);
    let no_corr: Vec<Rect> = Vec::new();
    let mut corridors = no_corr;
    reflect(&mut rooms, &mut services, &mut corridors, &mut doors, &mut start, rng.chance(1, 2), rng.chance(1, 2));
    let mut dvec = Vec::new();
    for d in doors {
        push_door(&mut dvec, d);
    }
    assemble(&rooms, &corridors, &services, dvec, start, seed)
}

// ===================================================== T8: l_wing (L-shape)
/// An L-SHAPED house: a public wing (living/kitchen) along the bottom and a
/// bedroom wing rising from one end, with a top-corner notch left as void so the
/// FOOTPRINT itself is an L — not a rectangle. Bedrooms sit off a short hall in
/// the wing; the public arm is the long leg of the L.
fn l_wing(seed: u64) -> LevelSpec {
    let mut rng = Rng(seed ^ 0x1AB9_0570_0000_0001);
    let w = rng.range(24, 32);
    let pub_d = rng.range(10, 13); // bottom public band depth
    let wing_d = rng.range(10, 14); // bedroom wing height above the public band
    let h = pub_d + wing_d;
    let hallw = rng.range(2, 3);
    let cx = rng.range(11, 15); // wing column width (bedrooms + hall)
    let hx0 = cx - hallw;
    let hx1 = cx;

    let mut rooms: Vec<Rect> = Vec::new();
    let mut services: Vec<Rect> = Vec::new();
    let mut doors: Vec<([f32; 4], Vec3)> = Vec::new();
    let mut corridors: Vec<Rect> = vec![[hx0, 0, hx1, wing_d]]; // wing hall

    // bedrooms in the wing, left of the hall, each doored onto it
    let runs = slice_runs(&mut rng, 0, wing_d, 4, 6);
    let bath_i = (0..runs.len()).min_by_key(|&i| runs[i].1 - runs[i].0).unwrap_or(0);
    for (i, &(z0, z1)) in runs.iter().enumerate() {
        let r = [0, z0, hx0, z1];
        doors.push(vdoor(hx0, (z0 + z1) / 2));
        if i == bath_i && runs.len() >= 2 {
            services.push(r);
        } else {
            rooms.push(r);
        }
    }
    // public band (the L's long leg): foyer under the hall, living left, kitchen right
    rooms.push([hx0, wing_d, hx1, h]); // foyer
    doors.push(hdoor(wing_d, hx0 + hallw / 2)); // hall <-> foyer
    doors.push(hdoor(h, hx0 + hallw / 2)); // front door
    rooms.push([0, wing_d, hx0, h]); // living (under the wing)
    doors.push(vdoor(hx0, wing_d + pub_d / 2));
    rooms.push([hx1, wing_d, w, h]); // kitchen (the long arm)
    doors.push(vdoor(hx1, wing_d + pub_d / 2));
    // the top-right region [cx, 0, w, wing_d] is left as VOID → the L footprint

    let mut start = Vec3::new((hx0 + hallw / 2) as f32 + 0.5, 0.0, h as f32 - 1.5);
    reflect(&mut rooms, &mut services, &mut corridors, &mut doors, &mut start, rng.chance(1, 2), rng.chance(1, 2));
    let mut dvec = Vec::new();
    for d in doors {
        push_door(&mut dvec, d);
    }
    assemble(&rooms, &corridors, &services, dvec, start, seed)
}

/// Transpose (swap X/Z = 90° rotation) and/or mirror a whole assembled spec, so
/// a wide horizontal-hall plan can present as a tall vertical one. Footprint min
/// is 0 on both axes for all archetypes, so reflection is just `extent - coord`.
fn transform_spec(mut s: LevelSpec, transpose: bool, flip_x: bool, flip_z: bool) -> LevelSpec {
    if transpose {
        for r in &mut s.rooms {
            let f = r.floor_rect;
            r.floor_rect = [f[1], f[0], f[3], f[2]];
        }
        for d in &mut s.doors {
            let c = d.closed_solid;
            d.closed_solid = [c[1], c[0], c[3], c[2]];
            let h = d.hinge;
            d.hinge = Vec3::new(h.z, h.y, h.x);
        }
        let p = s.player_start;
        s.player_start = Vec3::new(p.z, p.y, p.x);
    }
    let b = s.floor_bounds();
    let (wt, ht) = (b[2], b[3]);
    let fr = |f: [f32; 4]| -> [f32; 4] {
        let mut o = f;
        if flip_x {
            o = [wt - o[2], o[1], wt - o[0], o[3]];
        }
        if flip_z {
            o = [o[0], ht - o[3], o[2], ht - o[1]];
        }
        o
    };
    for r in &mut s.rooms {
        r.floor_rect = fr(r.floor_rect);
    }
    for d in &mut s.doors {
        d.closed_solid = fr(d.closed_solid);
        if flip_x {
            d.hinge.x = wt - d.hinge.x;
        }
        if flip_z {
            d.hinge.z = ht - d.hinge.z;
        }
    }
    if flip_x {
        s.player_start.x = wt - s.player_start.x;
    }
    if flip_z {
        s.player_start.z = ht - s.player_start.z;
    }
    s
}

// ===================================================== house: archetype mix
/// The believable-house generator: per seed, pick a structurally DISTINCT plan
/// archetype (different footprint shape, circulation topology, and room count),
/// THEN randomly rotate/mirror the whole thing. A single parametric skeleton
/// only ever yields one house; mixing archetypes + orientation gives real variety.
fn house(seed: u64) -> LevelSpec {
    let mut r = Rng(seed.wrapping_mul(0x2545_F491_4F6C_DD1D) ^ 0xA17C_0DE5_0000_0001);
    let spec = match r.next_u64() % 6 {
        0 => hall_rooms(seed),
        1 => loop_ring(seed),
        2 => program_pack(seed),
        3 => bungalow(seed),
        4 => l_wing(seed),
        _ => hybrid(seed),
    };
    transform_spec(spec, r.chance(1, 2), r.chance(1, 2), r.chance(1, 2))
}

// ============================================================ baseline (BSP)
/// The current shipped generator (`house_game::house_floor`) — naive BSP with a
/// spanning-tree of inter-room doors and NO corridor. Included as the reference
/// the new techniques are meant to beat.
fn baseline(seed: u64) -> LevelSpec {
    house_game::house_floor(seed)
}

fn techniques() -> Vec<Gen> {
    vec![
        ("baseline", baseline as fn(u64) -> LevelSpec),
        ("hall_rooms", hall_rooms),
        ("cross_hall", cross_hall),
        ("bsp_corridors", bsp_corridors),
        ("program_pack", program_pack),
        ("loop_ring", loop_ring),
        ("hybrid", hybrid),
        ("bungalow", bungalow),
        ("l_wing", l_wing),
        ("house", house),
    ]
}
