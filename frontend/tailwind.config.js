/** @type {import('tailwindcss').Config} */
const { nextui } = require("@nextui-org/react");

module.exports = {
  content: [
    "./src/**/*.{js,ts,jsx,tsx,mdx}",
    "./node_modules/@nextui-org/theme/dist/**/*.{js,ts,jsx,tsx}",
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
  plugins: [nextui()],
};