// Motion constants: durations in seconds, used by every animated component.
export const motionTokens = {
  quick: 0.16,
  base: 0.28,
  drop: 0.9, // the marker's way down the autonomy ladder
  ease: [0.2, 0.7, 0.2, 1] as const,
};
