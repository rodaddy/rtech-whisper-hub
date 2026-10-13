import type { Context } from "hono";

/** Hono env for routes behind device auth: the authenticated device and its owner. */
export type OwnerEnv = {
  Variables: { device: { id: string; name: string; ownerId: string } };
};

/** The owner of the authenticated device making this request. */
export function ownerOf(c: Context<OwnerEnv>): string {
  return c.get("device").ownerId;
}
