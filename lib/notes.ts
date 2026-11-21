import { z } from "zod";

/** A private note: an id of the record it belongs to and some text (control characters removed, trimmed, 1 to 4000 characters). */
export const noteSchema = z.object({
  id: z.string().uuid(),
  body: z.string().transform((v) => v.replace(/\u0000/g, "").trim()).pipe(z.string().min(1).max(4000)),
});
