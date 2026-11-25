/** @type {import('tailwindcss').Config} */
const { heroui } = require("@heroui/react");

module.exports = {
  content: [
    "./src/**/*.{js,ts,jsx,tsx,mdx}",
    "./node_modules/@heroui/theme/dist/**/*.{js,ts,jsx,tsx}",
  ],
  theme: {
    extend: {
      colors: {
        "swiss-paper": "#fbfaf8",
        "swiss-canvas": "#f7f6f2",
        "swiss-ink": "#37352f",
        "swiss-muted": "#9b9993",
        "swiss-border": "rgba(55,53,47,0.12)",
        "hyper-blue": "#44558a",
      },
      fontFamily: {
        swiss: ["Inter", "Helvetica Neue", "Arial", "sans-serif"],
        "swiss-mono": ["SFMono-Regular", "Menlo", "Consolas", "monospace"],
      },
      boxShadow: {
        "swiss-hard": "none",
        "swiss-soft": "0 1px 2px rgba(55,53,47,0.04)",
      },
    },
  },
  darkMode: "class",
  // HeroUI primary = ink, never its default blue (#006FEE). Values mirror design-tokens.css:
  // primary = --ou-action-primary (--ou-neutral-12 #231d19), hover-ish 600 = --ou-action-primary-hover
  // (--ou-neutral-11 #69625d), focus = --ou-focus-ring (--ou-neutral-8 #c4bab4). design:audit does not scan
  // this file (it is outside src/), so keep these in sync with the tokens by hand.
  plugins: [
    heroui({
      themes: {
        light: {
          colors: {
            primary: {
              DEFAULT: "#231d19",
              foreground: "#ffffff",
              50: "#f6efeb",
              100: "#f1e9e4",
              200: "#e3dad5",
              300: "#c4bab4",
              400: "#928a85",
              500: "#69625d",
              600: "#231d19",
              700: "#231d19",
              800: "#1a1512",
              900: "#120e0c",
            },
            focus: "#c4bab4",
          },
        },
      },
    }),
  ],
};