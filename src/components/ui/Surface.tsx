// The shared surface primitives — the elevation budget (two levels,
// "felt not seen") and the raised-surface rhythm. Cards, drawers, and
// popovers all come from these; the P2 elevation experiment renders
// Surface with and without the shadow.
import type { ParentProps } from 'solid-js';

export type SurfaceTone = 'raised' | 'well' | 'page';

const TONE: Record<SurfaceTone, string> = {
  raised: 'bg-fd-bg-1 border border-fd-line shadow-fd-1',
  well: 'bg-fd-bg-2',
  page: 'bg-fd-bg border border-fd-line',
};

const RADIUS: Record<'sm' | 'md' | 'lg', string> = {
  sm: 'rounded-fd-sm',
  md: 'rounded-fd-md',
  lg: 'rounded-fd-lg',
};

export function Surface(
  props: ParentProps & {
    tone?: SurfaceTone;
    /** Elevation off = the P2 flat-card experiment's ground truth. */
    flat?: boolean;
    radius?: 'sm' | 'md' | 'lg';
  },
) {
  return (
    <div
      class={[
        TONE[props.tone ?? 'raised'],
        RADIUS[props.radius ?? 'md'],
        // The P2 axis: flat vs elevated cards, both from the same tokens.
        props.flat ? 'shadow-none' : '',
      ]}
    >
      {props.children}
    </div>
  );
}
