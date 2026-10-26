// The palette, for code that cannot read the stylesheet's tokens (the chart draws on a canvas).
// Keep these equal to the tokens at the top of styles.css.
export const T = {
  bgPrimary: "#010001",
  bgSecondary: "#0D1117",
  bgPanel: "#111013",
  bgElevated: "#151B24",
  bgHover: "#1C2430",
  borderPrimary: "#202A36",
  borderSubtle: "#17212B",
  textPrimary: "#E8EDF4",
  textSecondary: "#91A0B5",
  textMuted: "#64748B",
  green: "#35E58B",
  greenBg: "#0B3024",
  red: "#FF4D5A",
  redBg: "#35191F",
  blue: "#7AA7FF",
  chartGrid: "#18212B",
};
/** "r,g,b" of a "#rrggbb" colour, for rgba() strings. */
export const rgbOf = (hex: string) => [1, 3, 5].map(i => parseInt(hex.slice(i, i + 2), 16)).join(",");
export const alpha = (hex: string, a: number) => `rgba(${rgbOf(hex)},${a})`;
