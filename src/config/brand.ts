// Central branding. Change the product name, tagline and palette here.
export const brand = {
  name: "Note",
  tagline: "A calm notebook for everything you learn.",
  description:
    "Write, organise and study in beautiful digital notebooks. Turn YouTube lectures into structured, editable notes.",
} as const;

// Notebook cover colours. Keys are stored in the database (notebooks.cover_color).
export const coverColors = {
  sage: { label: "Sage", value: "#7f9072" },
  clay: { label: "Clay", value: "#b0714f" },
  ink: { label: "Ink", value: "#34495e" },
  ochre: { label: "Ochre", value: "#b98a2f" },
  plum: { label: "Plum", value: "#7d5a73" },
  slate: { label: "Slate", value: "#5f6673" },
  moss: { label: "Moss", value: "#56694a" },
  rose: { label: "Rose", value: "#b0646f" },
} as const;

export type CoverColor = keyof typeof coverColors;
export const coverColorKeys = Object.keys(coverColors) as [CoverColor, ...CoverColor[]];

export function coverHex(key: string): string {
  return (coverColors as Record<string, { value: string }>)[key]?.value ?? coverColors.sage.value;
}
