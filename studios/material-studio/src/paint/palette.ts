/**
 * Default paint-editor swatches — biased toward the year-2200 ceramic
 * palette: clean whites and warm/cool greys with two amber accents.
 * The native `<input type="color">` is always available for fine-tune.
 */
export const PALETTE: ReadonlyArray<{ hex: string; label: string }> = [
  { hex: "#ffffff", label: "white" },
  { hex: "#f4ede0", label: "warm cream" },
  { hex: "#e6dfc8", label: "bone" },
  { hex: "#cfc8b0", label: "taupe" },
  { hex: "#a4a395", label: "warm grey" },
  { hex: "#5e564e", label: "graphite" },
  { hex: "#1a1a1a", label: "structural dark" },
  { hex: "#b8430e", label: "burnt amber" },
  { hex: "#8a3000", label: "dark amber" },
  { hex: "#3a5163", label: "cool slate" },
];

export const DEFAULT_COLOR = "#1a1a1a";
