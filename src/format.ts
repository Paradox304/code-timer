// Token: {{<id>}} or {{<id> "label"}} or {{<id> "label"s}}
//   - Bare token emits the raw number.
//   - With a label: emits `<value> <label>`.
//   - Trailing `s` (outside quotes) pluralizes the label when value !== 1.
//   - When a labeled token's value is 0, it emits an empty string so the format
//     stays clean (e.g. "Took 45 minutes" instead of "Took 0 hours 45 minutes").
// IDs:
//   hours / minutes / seconds   — leftover components (hours = total/3600 since no day unit)
//   totalHours / totalMinutes / totalSeconds — full counts
//   h / m / s — aliases for the leftover components

const TOKEN_RE = /\{\{(\w+)(?:\s+"([^"]*)"(s)?)?\}\}/g;

export function formatElapsed(template: string, totalSeconds: number): string {
  const total = Math.max(0, Math.floor(totalSeconds));
  const hours = Math.floor(total / 3600);
  const minutes = Math.floor((total % 3600) / 60);
  const seconds = total % 60;

  const values: Record<string, number> = {
    hours, minutes, seconds,
    h: hours, m: minutes, s: seconds,
    totalHours: hours,
    totalMinutes: Math.floor(total / 60),
    totalSeconds: total,
  };

  const replaced = template.replace(TOKEN_RE, (_match, id: string, label: string | undefined, plural: string | undefined) => {
    const val = values[id];
    if (val === undefined) return '';
    if (label === undefined) return String(val);
    if (val === 0) return '';
    const suffix = plural && val !== 1 ? 's' : '';
    return `${val} ${label}${suffix}`;
  });

  return replaced.replace(/\s+/g, ' ').trim();
}
