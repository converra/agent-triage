import { z } from "zod";

export const PolicySchema = z.object({
  id: z.string(),
  name: z.string(),
  description: z.string(),
  complexity: z.number().int().min(1).max(5),
  category: z.enum([
    "routing",
    "tone",
    "safety",
    "knowledge",
    "behavior",
    "formatting",
  ]),
});

export type Policy = z.infer<typeof PolicySchema>;

export const PoliciesFileSchema = z.array(PolicySchema);
