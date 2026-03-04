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

  float scale = uPatternScale * 12.0;

  // Corrugation ridges — sinusoidal across X
  float ridge = sin(uv.x * scale * 3.14159 * 2.0);
  float ridgeShading = ridge * 0.15 + 0.85; // subtle light/dark

  vec3 color = uBaseColor * ridgeShading;

  // Sheet overlap seams (horizontal)
  float sheetHeight = 1.0 / (scale * 0.15);
  float sheetEdge = fract(uv.y / sheetHeight);
  float overlap = 1.0 - smoothstep(0.0, 0.03, sheetEdge) * 0.1;
  color *= overlap;

  // Surface scratches
  float scratch = _fbm(vec2(uv.x * scale * 4.0, uv.y * scale * 0.5) + uSeed, 3);
  color = mix(color, color * 1.3, smoothstep(0.6, 0.65, scratch) * 0.3);

  // Rust (weathering) — accent color as rust
  float rustNoise = _fbm(uv * 4.0 + uSeed * 0.8, 4);
  float rustMask = smoothstep(0.4, 0.7, rustNoise) * uWeathering;
  vec3 rustColor = uAccentColor * 0.6;
  color = mix(color, rustColor, rustMask);

  // Grime
  float grime = _fbm(uv * 5.0 + uSeed * 2.0, 3);
  float grimeW = (1.0 - smoothstep(0.0, 0.5, vUv.y)) * uGrimeIntensity;
  color = mix(color, color * 0.3, grime * grimeW);

  // Dents/damage (replaces cracks for metal)
  float dent = _fbm(uv * scale * 1.5 + uSeed * 3.0, 3);
  float dentMask = smoothstep(0.55, 0.6, dent) * uCrackDensity;
  color *= mix(1.0, 0.75, dentMask);

  gl_FragColor = vec4(color, 1.0);
}
