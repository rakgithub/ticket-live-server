import type { Request, Response } from "express";
import { z } from "zod";
import { authenticateUser } from "../../services/auth/loginService.ts";

const loginBodySchema = z.object({
  email: z.email().trim().toLowerCase(),
  password: z.string().min(1),
});

export async function login(req: Request, res: Response): Promise<void> {
  const parsedBody = loginBodySchema.safeParse(req.body);

  if (!parsedBody.success) {
    res.status(400).json({ error: "Email and password are required" });
    return;
  }

  const result = await authenticateUser(
    parsedBody.data.email,
    parsedBody.data.password,
  );

  if (!result) {
    res.status(401).json({ error: "Invalid email or password" });
    return;
  }

  res.status(200).json({
    accessToken: result.accessToken,
    tokenType: "Bearer",
    user: result.user,
  });
}
