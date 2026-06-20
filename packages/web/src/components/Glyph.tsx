import type { SVGProps } from "react";

/**
 * Inline SVG glyph set for PrintStream.
 *
 * The brand glyphs are authored with `fill`/`stroke="currentColor"`. Loading
 * them via <img> isolates them from the page CSS, so `currentColor` resolves to
 * black and they vanish on the dark UI. Rendering them inline lets them inherit
 * the surrounding text color — tint with `text-*` utilities at the call site.
 */
export type GlyphName =
  | "xxxy"
  | "heart"
  | "reticle"
  | "diamond"
  | "barcode"
  | "register-cross"
  | "no-symbol"
  | "target-x"
  | "chevron-up"
  | "check"
  | "plus"
  | "log-out"
  | "shield";

type GlyphProps = SVGProps<SVGSVGElement> & { name: GlyphName };

const STROKE = {
  fill: "none",
  stroke: "currentColor",
  strokeLinecap: "round",
  strokeLinejoin: "round",
} as const;

export default function Glyph({ name, ...props }: GlyphProps) {
  const base: SVGProps<SVGSVGElement> = {
    "aria-hidden": true,
    focusable: false,
    ...props,
  };

  switch (name) {
    case "xxxy":
      return (
        <svg viewBox="0 0 160 40" fill="currentColor" {...base}>
          <g
            fontFamily="'Space Grotesk', system-ui, sans-serif"
            fontWeight={700}
            fontSize={44}
            letterSpacing={-2}
          >
            <text x="0" y="34">X</text>
            <text x="36" y="34">X</text>
            <text x="72" y="34" opacity={0.45}>X</text>
            <text x="108" y="34">Y</text>
          </g>
        </svg>
      );

    case "heart":
      return (
        <svg viewBox="0 0 14 12" shapeRendering="crispEdges" fill="currentColor" {...base}>
          <rect x="1" y="2" width="2" height="2" />
          <rect x="3" y="1" width="2" height="2" />
          <rect x="5" y="2" width="2" height="2" />
          <rect x="7" y="2" width="2" height="2" />
          <rect x="9" y="1" width="2" height="2" />
          <rect x="11" y="2" width="2" height="2" />
          <rect x="1" y="4" width="12" height="2" />
          <rect x="2" y="6" width="10" height="2" />
          <rect x="3" y="8" width="8" height="2" />
          <rect x="5" y="10" width="4" height="1" />
        </svg>
      );

    case "diamond":
      return (
        <svg viewBox="0 0 12 12" shapeRendering="crispEdges" fill="currentColor" {...base}>
          <rect x="5" y="1" width="2" height="2" />
          <rect x="3" y="3" width="6" height="2" />
          <rect x="1" y="5" width="10" height="2" />
          <rect x="3" y="7" width="6" height="2" />
          <rect x="5" y="9" width="2" height="2" />
        </svg>
      );

    case "barcode":
      return (
        <svg viewBox="0 0 80 24" shapeRendering="crispEdges" fill="currentColor" {...base}>
          {[
            [0, 2], [3, 1], [6, 3], [10, 1], [13, 2], [17, 1], [19, 4], [25, 1],
            [28, 2], [32, 3], [37, 1], [40, 2], [44, 1], [47, 3], [52, 2], [56, 1],
            [59, 2], [63, 4], [69, 1], [72, 2], [76, 1], [78, 2],
          ].map(([x, w], i) => (
            <rect key={i} x={x} y="0" width={w} height="24" />
          ))}
        </svg>
      );

    case "reticle":
      return (
        <svg viewBox="0 0 32 32" strokeWidth={1} {...STROKE} {...base}>
          <circle cx="16" cy="16" r="10" />
          <circle cx="16" cy="16" r="2" fill="currentColor" />
          <path d="M16 0 L16 8 M16 24 L16 32 M0 16 L8 16 M24 16 L32 16" />
          <path
            d="M10 10 L6 6 M22 10 L26 6 M10 22 L6 26 M22 22 L26 26"
            opacity={0.4}
          />
        </svg>
      );

    case "register-cross":
      return (
        <svg viewBox="0 0 24 24" strokeWidth={1} {...STROKE} {...base}>
          <circle cx="12" cy="12" r="7" />
          <path d="M12 0 L12 24 M0 12 L24 12" />
          <circle cx="12" cy="12" r="1.5" fill="currentColor" />
        </svg>
      );

    case "no-symbol":
      return (
        <svg viewBox="0 0 24 24" strokeWidth={1.25} {...STROKE} {...base}>
          <circle cx="12" cy="12" r="9" />
          <path d="M5.6 5.6 L18.4 18.4" />
        </svg>
      );

    case "target-x":
      return (
        <svg viewBox="0 0 24 24" strokeWidth={1.5} {...STROKE} {...base}>
          <path d="M5 5 L19 19 M19 5 L5 19" />
          <path d="M1 1 L1 4 M1 1 L4 1" />
          <path d="M23 1 L20 1 M23 1 L23 4" />
          <path d="M1 23 L1 20 M1 23 L4 23" />
          <path d="M23 23 L23 20 M23 23 L20 23" />
        </svg>
      );

    case "chevron-up":
      return (
        <svg viewBox="0 0 24 24" strokeWidth={2} {...STROKE} {...base}>
          <path d="M5 14 L12 7 L19 14" />
        </svg>
      );

    case "check":
      return (
        <svg viewBox="0 0 24 24" strokeWidth={2} {...STROKE} {...base}>
          <path d="M4 12 L9 17 L20 6" />
        </svg>
      );

    case "plus":
      return (
        <svg viewBox="0 0 24 24" strokeWidth={1.75} {...STROKE} {...base}>
          <path d="M12 5 L12 19 M5 12 L19 12" />
        </svg>
      );

    case "log-out":
      return (
        <svg viewBox="0 0 24 24" strokeWidth={1.5} {...STROKE} {...base}>
          <path d="M9 21 H5 a2 2 0 0 1 -2 -2 V5 a2 2 0 0 1 2 -2 h4" />
          <path d="M16 17 L21 12 L16 7" />
          <path d="M21 12 H9" />
        </svg>
      );

    case "shield":
      return (
        <svg viewBox="0 0 24 24" strokeWidth={1.5} {...STROKE} {...base}>
          <path d="M12 2 L20 5 V11 c0 5 -3.5 8.5 -8 10 c-4.5 -1.5 -8 -5 -8 -10 V5 Z" />
          <path d="M9 12 L11 14 L15.5 9.5" />
        </svg>
      );

    default:
      // Exhaustiveness guard: adding a GlyphName without a case is a compile error.
      name satisfies never;
      return null;
  }
}
