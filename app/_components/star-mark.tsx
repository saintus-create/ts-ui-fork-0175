import { cn } from "@/lib/utils";

/**
 * The site mark: a single red star.
 *
 * One five-point star at the California Republic's red (#c8102e), replacing the
 * "CA" letterform mark. Geometry is shared with the favicon and the
 * apple-touch icon (see scripts/make-star.py) so the three cannot drift.
 * fill="currentColor" so a caller can recolour it if it ever needs to sit on
 * a surface where the red does not read.
 */
export function StarMark({ className }: { className?: string }) {
  return (
    <svg
      viewBox="0 0 100 100"
      className={cn("text-[#c8102e]", className)}
      fill="currentColor"
      xmlns="http://www.w3.org/2000/svg"
      aria-hidden
    >
      <path d="M50 3 L60.55 35.47 L94.7 35.48 L67.08 55.55 L77.63 88.02 L50 67.95 L22.37 88.02 L32.92 55.55 L5.3 35.48 L39.45 35.47 Z" />
    </svg>
  );
}
