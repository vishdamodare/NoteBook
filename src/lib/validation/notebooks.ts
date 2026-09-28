import { z } from "zod";
import { coverColorKeys } from "@/config/brand";

export const notebookInputSchema = z.object({
  title: z.string().trim().min(1, "Give your notebook a title.").max(200),
  description: z.string().trim().max(1000),
  coverColor: z.enum(coverColorKeys),
});
export type NotebookInput = z.infer<typeof notebookInputSchema>;

export const pageTitleSchema = z.string().max(300);
export const pageTypeSchema = z.enum(["note", "youtube"]);
