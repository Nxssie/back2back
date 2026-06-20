/**
 * Four corner reticle brackets — drop inside any `position: relative` element to
 * frame it like a tactical HUD readout. Color follows the parent's text color
 * (`currentColor`), so tint with a `text-*` class on the wrapper.
 */
export default function ReticleCorners({
  className = "",
  size = 10,
}: {
  className?: string;
  size?: number;
}) {
  const s = { width: size, height: size };
  return (
    <span aria-hidden className={`pointer-events-none absolute inset-0 ${className}`}>
      <span className="absolute -top-px -left-px border-t border-l border-current" style={s} />
      <span className="absolute -top-px -right-px border-t border-r border-current" style={s} />
      <span className="absolute -bottom-px -left-px border-b border-l border-current" style={s} />
      <span className="absolute -bottom-px -right-px border-b border-r border-current" style={s} />
    </span>
  );
}
