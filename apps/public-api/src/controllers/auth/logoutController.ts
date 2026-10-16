import type { Request, Response } from "express";
import { revokeAccessToken } from "../../services/auth/logoutService.ts";

export async function logout(req: Request, res: Response): Promise<void> {
  if (!req.auth) {
    res.status(401).json({ error: "Authentication required" });
    return;
  }

  await revokeAccessToken(req.auth.tokenId, req.auth.expiresAt);
  res.status(204).send();
}
