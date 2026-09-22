// World-space aerosol field; no screen history, random frame seeds or blur.
// cnNoise is shared with the materials. Time comes from the fixed-tick sim.
CFN float airDensity(vec3 p, float time) {
    vec3 advected = p - vec3(0.12, 0.0, 0.055) * time;
    float banks = cnNoise(advected * vec3(0.27, 0.48, 0.27));
    float wisps = cnNoise(advected * vec3(1.1, 1.7, 1.1) + 13.7);
    return 0.48 + 0.82 * banks + 0.32 * wisps;
}

// Clip to the useful height band. Orthographic camera distance is arbitrary;
// starting at the eye instead wastes all samples in empty air above the scene.
CFN vec2 airInterval(vec3 o, vec3 d, float distance, float height) {
    float start = 0.0, end = max(distance, 0.0);
    // Above five scale heights only 0.67% of the aerosol column remains.
    float ceiling = 5.0 * max(height, 0.05);
    if (d.y < -0.0001) start = max(0.0, (ceiling - o.y) / d.y);
    else if (d.y > 0.0001) end = min(end, (ceiling - o.y) / d.y);
    else if (o.y > ceiling) end = 0.0;
    return vec2(start, max(end - start, 0.0));
}

CFN float airStratum(vec3 o, vec3 d) {
    // All origins on the same ray share one seed, including camera dolly.
    // Freeze sample placement; only the continuous density field drifts.
    vec3 anchor = o - d * dot(o, d);
    return 0.15 + 0.70 * cnHash(floor(anchor * 23.0) + 71.0);
}
