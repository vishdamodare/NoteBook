import { z } from "zod";

export const emailSchema = z.email("Enter a valid email address.").max(254);
export const passwordSchema = z
  .string()
  .min(8, "Use at least 8 characters.")
  .max(72, "Use 72 characters or fewer.");

export const loginSchema = z.object({
  email: emailSchema,
  password: z.string().min(1, "Enter your password."),
});

export const signupSchema = z.object({
  displayName: z.string().trim().min(1, "Enter your name.").max(80),
  email: emailSchema,
  password: passwordSchema,
});

export const forgotPasswordSchema = z.object({ email: emailSchema });

export const resetPasswordSchema = z
  .object({ password: passwordSchema, confirm: z.string() })
  .refine((v) => v.password === v.confirm, { message: "Passwords don't match.", path: ["confirm"] });

export const profileSchema = z.object({
  displayName: z.string().trim().max(80),
  avatarUrl: z.union([z.literal(""), z.url({ protocol: /^https$/, error: "Use an https:// image URL." }).max(2000)]),
});

export const preferencesSchema = z.object({
  theme: z.enum(["system", "light", "dark"]).catch("system"),
  editorFont: z.enum(["serif", "sans"]).catch("serif"),
});
export type Preferences = z.infer<typeof preferencesSchema>;

/** First error message per field, for form display. */
export function fieldErrors(error: z.ZodError): Record<string, string> {
  const out: Record<string, string> = {};
  for (const issue of error.issues) {
    const key = String(issue.path[0] ?? "form");
    out[key] ??= issue.message;
  }
  return out;
}
