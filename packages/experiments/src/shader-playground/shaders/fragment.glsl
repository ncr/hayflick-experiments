varying vec2 vUv;
uniform float uTime;

void main() {
  vec2 p = vUv - 0.5;
  float wave = 0.5 + 0.5 * sin(12.0 * p.x + uTime * 1.7);
  vec3 base = mix(vec3(0.03, 0.09, 0.16), vec3(0.13, 0.78, 0.62), wave);
  float ring = smoothstep(0.24, 0.23, abs(length(p) - 0.22));
  gl_FragColor = vec4(base + ring * vec3(0.96, 0.86, 0.44), 1.0);
}
