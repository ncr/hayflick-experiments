// Shared scalar transport math. Also executed by bin/check-atmosphere.
// Integral of D * exp(-max(y,0)/H): density never grows below ground.
CFN float airColumn(float y, float dy, float distance, float density, float height) {
    float H = max(height, 0.05);
    float L = max(distance, 0.0);
    float endY = y + dy * L;
    float lo = min(y, endY), hi = max(y, endY);
    float span = hi - lo;
    if (span < 0.00001)
        return max(density, 0.0) * L * exp(-max(0.5 * (y + endY), 0.0) / H);
    float a = max(lo, 0.0), b = max(hi, 0.0);
    float above = L * (b - a) / span;
    float q = (b - a) / H;
    // Stable expm1(-q)/-q limit for nearly horizontal/short segments.
    float average = q < 0.001 ? 1.0 - 0.5*q + q*q/6.0 : (1.0-exp(-q))/q;
    return max(density, 0.0) * (L - above + above * exp(-a/H) * average);
}

// Normalized Henyey-Greenstein phase: slightly forward-scattering dust.
CFN float airPhase(float cosine) {
    float g = 0.32;
    float q = 1.0 + g*g - 2.0*g*cosine;
    return (1.0-g*g) / (12.5663706 * q * sqrt(q));
}
