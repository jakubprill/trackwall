import { z } from "zod";

/**
 * What files an agent writes and the user approves by their exact content share (routines, ADR-173; workspace knowledge,
 * ADR-170): a name that is also the file name, and the SHA-256 of the file's bytes the user approved.
 */

/** Lowercase words joined by `-`, e.g. `update-orders-client`; also the file name without `.md`. */
export function fileName(max: number, what: string): z.ZodString {
  return z
    .string()
    .min(1)
    .max(max)
    .regex(/^[a-z0-9]+(-[a-z0-9]+)*$/, `${what} is lowercase letters and digits in words joined by -`);
}

/** SHA-256 of a file's bytes, in hex: what the user approved, and what an approval names. */
export const ContentDigest = z.string().regex(/^[0-9a-f]{64}$/, "a digest is 64 hex digits");
export type ContentDigest = z.infer<typeof ContentDigest>;
