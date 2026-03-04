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

void main() {
  vec2 uv = vUv;
  uv.x *= uAspect;

  float scale = uPatternScale * 8.0;

  // Vertical planks
  float plankWidth = 1.0 / (scale * 0.5);
  float plankId = floor(uv.x / plankWidth);
  float plankUv = fract(uv.x / plankWidth);

  // Plank seams
  float seam = smoothstep(0.0, 0.02, plankUv) * smoothstep(0.0, 0.02, 1.0 - plankUv);

  // Per-plank color variation
  float plankHash = _hash21(vec2(plankId + uSeed, 0.0));
  vec3 plankColor = mix(uBaseColor * 0.85, uBaseColor * 1.15, plankHash);

  // Wood grain — stretched noise along Y
  float grain = _fbm(vec2(uv.x * scale * 2.0, uv.y * scale * 0.3) + uSeed, 5);
  vec3 grainColor = mix(plankColor, uAccentColor, grain * 0.3);

  vec3 color = grainColor * seam;

  // Weathering: faded color, lighter
  float weatherNoise = _fbm(uv * 3.0 + uSeed * 0.6, 3);
  color = mix(color, mix(color, vec3(0.6), 0.4), uWeathering * weatherNoise);

  // Grime
  float grime = _fbm(uv * 5.0 + uSeed * 1.8, 3);
  float grimeW = (1.0 - smoothstep(0.0, 0.5, vUv.y)) * uGrimeIntensity;
  color = mix(color, color * 0.3, grime * grimeW);

  // Cracks — along grain direction
  float crackNoise = _fbm(vec2(uv.x * scale * 3.0, uv.y * scale * 0.5) + uSeed * 5.0, 3);
  float crackLine = smoothstep(0.45, 0.48, crackNoise);
  color *= mix(0.7, 1.0, mix(1.0, 1.0 - crackLine, uCrackDensity));

  gl_FragColor = vec4(color, 1.0);
}
