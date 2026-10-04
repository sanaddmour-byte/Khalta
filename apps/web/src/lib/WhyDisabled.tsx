/**
 * The reason a button is disabled, as visible text the button points at (aria-describedby). A disabled control with no
 * explanation is a dead end, so every one that depends on the user's input says what is still missing.
 */
export function WhyDisabled({ id, reason }: { id: string; reason: string | null }) {
  if (!reason) return null;
  return (
    <p id={id} role="note" className="text-xs text-muted" data-testid="why-disabled">
      {reason}
    </p>
  );
}
