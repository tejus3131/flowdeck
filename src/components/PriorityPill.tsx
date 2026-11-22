/** Priority as a colored pill (shared by the board, drawer, and search). */
export function PriorityPill(props: { priority: string }) {
  const styles: Record<string, string> = {
    urgent: 'bg-red-100 text-red-700 dark:bg-red-500/15 dark:text-red-300',
    high: 'bg-orange-100 text-orange-700 dark:bg-orange-500/15 dark:text-orange-300',
    medium: 'bg-amber-100 text-amber-700 dark:bg-amber-500/15 dark:text-amber-300',
    low: 'bg-neutral-100 text-neutral-500 dark:bg-neutral-800 dark:text-neutral-400',
  };
  return (
    <span
      class={`rounded-full px-2 py-0.5 text-[10px] font-semibold uppercase tracking-wide ${
        styles[props.priority] ?? styles.low
      }`}
    >
      {props.priority}
    </span>
  );
}
