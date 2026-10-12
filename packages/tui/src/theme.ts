import type { Tone } from "./types.ts";

export const theme = {
  background: "#101010",
  surface: "#191919",
  selected: "#252525",
  border: "#444444",
  text: "#eeeeee",
  muted: "#a0a0a0",
  accent: "#91b4f5",
  success: "#b3cf99",
  warning: "#edcf87",
  danger: "#e995a0",
} as const;

export function toneColor(tone: Tone = "neutral"): string {
  return tone === "neutral" ? theme.text : theme[tone];
}
