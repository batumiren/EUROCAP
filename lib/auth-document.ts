import { z } from "zod";

export const hashSchema = z.string().regex(/^scrypt\$[a-f0-9]{32}\$[a-f0-9]{128}$/);
const account = z.object({ hash: hashSchema, revision: z.string().uuid() });
const attempts = z.object({ start: z.number(), count: z.number().int().nonnegative() });
export const documentSchema = z.object({
  version: z.literal(1),
  secret: z.string().regex(/^[a-f0-9]{64}$/),
  users: z.object({ admin: account, check: account }),
  revoked: z.array(z.object({ digest: z.string().regex(/^[a-f0-9]{64}$/), expires: z.number() })).default([]),
  attempts: z.object({ admin: attempts, check: attempts, unknown: attempts }),
});
export type CredentialDocument = z.infer<typeof documentSchema>;
