precision highp float;

varying vec2 vUv;

uniform vec3 uBaseColor;
uniform vec3 uAccentColor;
uniform float uPatternScale;
uniform float uWeathering;
uniform float uGrimeIntensity;
uniform float uCrackDensity;
uniform float uSeed;
uniform float uAspect;

// inline noise functions to avoid import issues
float _hash21(vec2 p) {
  vec3 p3 = fract(vec3(p.xyx) * 0.1031);
  p3 += dot(p3, p3.yzx + 33.33);
  return fract((p3.x + p3.y) * p3.z);
}

float _valueNoise(vec2 p) {
  vec2 i = floor(p);
  vec2 f = fract(p);
  f = f * f * (3.0 - 2.0 * f);
  float a = _hash21(i);
  float b = _hash21(i + vec2(1.0, 0.0));
  float c = _hash21(i + vec2(0.0, 1.0));
  float d = _hash21(i + vec2(1.0, 1.0));
  return mix(mix(a, b, f.x), mix(c, d, f.x), f.y);
}

float _fbm(vec2 p, int octaves) {
  float value = 0.0;
  float amplitude = 0.5;
  float frequency = 1.0;
  for (int i = 0; i < 6; i++) {
    if (i >= octaves) break;
    value += amplitude * _valueNoise(p * frequency);
    frequency *= 2.0;
    amplitude *= 0.5;
  }
  return value;
}

vec2 _hash22(vec2 p) {
  vec3 p3 = fract(vec3(p.xyx) * vec3(0.1031, 0.1030, 0.0973));
  p3 += dot(p3, p3.yzx + 33.33);
  return fract((p3.xx + p3.yz) * p3.zy);
}

float _voronoi(vec2 p) {
  vec2 i = floor(p);
  vec2 f = fract(p);
  float minDist = 1.0;
  for (int y = -1; y <= 1; y++) {
    for (int x = -1; x <= 1; x++) {
      vec2 neighbor = vec2(float(x), float(y));
      vec2 point = _hash22(i + neighbor);
      vec2 diff = neighbor + point - f;
      minDist = min(minDist, dot(diff, diff));
    }
  }
  return sqrt(minDist);
}

void main() {
  vec2 uv = vUv;
  uv.x *= uAspect;

  float scale = uPatternScale * 8.0;
  vec2 brickUv = uv * scale;

  // Offset every other row for brick pattern
  float row = floor(brickUv.y * 2.0);
  float xOffset = mod(row, 2.0) * 0.5;
  vec2 brickCoord = vec2(brickUv.x + xOffset, brickUv.y * 2.0);

  // Brick cell coordinates
  vec2 cellId = floor(brickCoord);
  vec2 cellUv = fract(brickCoord);

  // Mortar lines
  float mortarWidth = 0.06;
  float mx = step(mortarWidth, cellUv.x) * step(cellUv.x, 1.0 - mortarWidth);
  float my = step(mortarWidth, cellUv.y) * step(cellUv.y, 1.0 - mortarWidth);
  float isBrick = mx * my;

  // Per-brick color variation
  float brickHash = _hash21(cellId + uSeed);
  vec3 brickColor = mix(uBaseColor * 0.85, uBaseColor * 1.15, brickHash);

  // Mortar color (accent)
  vec3 mortarColor = uAccentColor;

  vec3 color = mix(mortarColor, brickColor, isBrick);

  // Surface noise for texture
  float surfaceNoise = _fbm(uv * scale * 2.0 + uSeed, 4);
  color *= mix(0.9, 1.1, surfaceNoise);

  // Weathering: darken edges and add noise
  float weatherNoise = _fbm(uv * 3.0 + uSeed * 0.5, 3);
  float edgeDarken = smoothstep(0.0, 0.3, vUv.y) * smoothstep(0.0, 0.15, vUv.x) *
                     smoothstep(0.0, 0.15, 1.0 - vUv.x);
  color *= mix(1.0, mix(1.0, 0.6, weatherNoise) * edgeDarken, uWeathering);

  // Grime: dark splotches concentrated at bottom
  float grime = _fbm(uv * 5.0 + uSeed * 1.7, 3);
  float grimeWeight = (1.0 - smoothstep(0.0, 0.5, vUv.y)) * uGrimeIntensity;
  color = mix(color, color * 0.4, grime * grimeWeight);

  // Cracks: voronoi-based lines
  float crackPattern = _voronoi(uv * scale * 1.5 + uSeed * 2.0);
  float crackLine = smoothstep(0.02, 0.04, crackPattern);
  color *= mix(0.7, 1.0, mix(1.0, crackLine, uCrackDensity));

  gl_FragColor = vec4(color, 1.0);
}
