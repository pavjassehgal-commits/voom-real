import "server-only";
import { z } from "zod";

const schema = z.object({
  clientId: z.string().trim().min(1),
  clientSecret: z.string().trim().min(1),
  redirectUri: z.string().url().refine((value) => {
    const url = new URL(value);
    return url.protocol === "https:" && !url.search && !url.hash && !url.username && !url.password;
  }),
  encryptionKey: z.string().min(32),
  apiVersion: z.string().regex(/^20\d{2}(0[1-9]|1[0-2])$/),
});
export type LinkedInConfig = z.infer<typeof schema>;
export function readLinkedInConfig(): LinkedInConfig | null {
  const result = schema.safeParse({
    clientId: process.env.LINKEDIN_CLIENT_ID,
    clientSecret: process.env.LINKEDIN_CLIENT_SECRET,
    redirectUri: process.env.LINKEDIN_REDIRECT_URI,
    encryptionKey: process.env.LINKEDIN_TOKEN_ENCRYPTION_KEY,
    apiVersion: process.env.LINKEDIN_API_VERSION,
  });
  return result.success ? result.data : null;
}
