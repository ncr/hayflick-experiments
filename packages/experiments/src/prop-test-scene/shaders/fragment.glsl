varying vec2 vUv;
uniform float uTime;

void main() {
  vec3 color = vec3(vUv, 0.5 + 0.5 * sin(uTime));
  gl_FragColor = vec4(color, 1.0);
}
