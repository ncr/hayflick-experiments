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

  // Smooth plaster surface with subtle trowel marks
  float scale = uPatternScale * 6.0;
  float trowel = _fbm(uv * scale + uSeed, 5);
  float fineTex = _fbm(uv * scale * 4.0 + uSeed * 1.3, 3);

  vec3 color = uBaseColor;
  // Subtle trowel variation
  color *= mix(0.95, 1.05, trowel);
  color *= mix(0.98, 1.02, fineTex);

  // Weathering: peeling reveals accent (underlying) color
  float weatherNoise = _fbm(uv * 4.0 + uSeed * 0.7, 4);
  float peelMask = smoothstep(0.5, 0.65, weatherNoise) * uWeathering;
  color = mix(color, uAccentColor * 0.8, peelMask);

  // Grime streaks running downward
  float grimeStreak = _fbm(vec2(uv.x * 8.0, uv.y * 2.0) + uSeed * 2.0, 3);
  float grimeWeight = (1.0 - smoothstep(0.0, 0.6, vUv.y)) * uGrimeIntensity;
  color = mix(color, color * 0.35, grimeStreak * grimeWeight);

  // Cracks: thin voronoi lines
  float crack = _voronoi(uv * scale * 2.0 + uSeed * 3.0);
  float crackLine = smoothstep(0.01, 0.03, crack);
  color *= mix(0.6, 1.0, mix(1.0, crackLine, uCrackDensity));

  gl_FragColor = vec4(color, 1.0);
}
