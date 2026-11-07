import type { Config } from "tailwindcss";

export default {
  darkMode: ["class"],
  content: ["./index.html", "./src/**/*.{ts,tsx}"],
  theme: {
    extend: {
      colors: {
        border: "hsl(var(--border))",
        input: "hsl(var(--input))",
        ring: "hsl(var(--ring))",
        background: "hsl(var(--background))",
        foreground: "hsl(var(--foreground))",
        "muted-foreground": "hsl(var(--muted-foreground))",
        "primary-foreground": "hsl(var(--primary-foreground))",
        card: "hsl(var(--card))",
        muted: "hsl(var(--muted))",
        accent: "hsl(var(--accent))",
        primary: "hsl(var(--primary))",
      },
      fontFamily: {
        sans: ["Inter Variable", "Inter", "sans-serif"],
        mono: ["JetBrains Mono", "monospace"],
      },
      boxShadow: {
        panel: "0 20px 70px rgba(0,0,0,.22)",
        glow: "0 0 50px rgba(82,152,255,.12)",
      },
      backgroundImage: {
        "grid-fade": "linear-gradient(to bottom, rgba(255,255,255,.035) 1px, transparent 1px), linear-gradient(to right, rgba(255,255,255,.035) 1px, transparent 1px)",
      },
      keyframes: {
        "check-in": { "0%": { transform: "scale(.72)", opacity: ".35" }, "100%": { transform: "scale(1)", opacity: "1" } },
      },
      animation: {
        "check-in": "check-in .28s ease-out both",
      },
    },
  },
  plugins: [],
} satisfies Config;
