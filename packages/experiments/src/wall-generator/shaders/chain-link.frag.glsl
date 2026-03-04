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

  float scale = uPatternScale * 10.0;

  // Diamond chain-link pattern
  // Rotate UV 45° for diamond grid
  vec2 rotUv = vec2(uv.x - uv.y, uv.x + uv.y) * scale * 0.707;

  vec2 cellId = floor(rotUv);
  vec2 cellUv = fract(rotUv);

  // Wire thickness
  float wireWidth = 0.08;

  // Horizontal and vertical wires forming diamond
  float hWire = smoothstep(wireWidth, wireWidth * 0.5, abs(cellUv.y - 0.5));
  float vWire = smoothstep(wireWidth, wireWidth * 0.5, abs(cellUv.x - 0.5));
  float wire = max(hWire, vWire);

  // Wire color with slight metallic sheen
  float sheen = 0.9 + 0.1 * sin(rotUv.x * 20.0 + rotUv.y * 20.0);
  vec3 wireColor = uBaseColor * sheen;

  // Background (sky/void) — using accent color with transparency hint
  vec3 bgColor = uAccentColor * 0.3;

  vec3 color = mix(bgColor, wireColor, wire);

  // Rust weathering on wires
  float rustNoise = _fbm(uv * 6.0 + uSeed * 0.5, 3);
  float rustMask = wire * smoothstep(0.4, 0.7, rustNoise) * uWeathering;
  color = mix(color, uAccentColor * 0.5, rustMask);

  // Alpha: wire = 1, gaps = low alpha (for chain-link transparency)
  float alpha = mix(0.15, 1.0, wire);

  gl_FragColor = vec4(color, alpha);
}
