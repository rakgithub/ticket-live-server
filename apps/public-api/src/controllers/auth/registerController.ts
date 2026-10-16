import type { Request, Response } from "express";
import { z } from "zod";
import { registerUser } from "../../services/auth/registerService.ts";

const registerBodySchema = z.object({
  name: z.string().trim().min(1).max(255),
  email: z.email().trim().toLowerCase(),
  password: z.string().min(12).refine(
    (password) => new TextEncoder().encode(password).length <= 72,
    "Password must be no more than 72 bytes",
  ),
});

export async function register(req: Request, res: Response): Promise<void> {
  const parsedBody = registerBodySchema.safeParse(req.body);
  if (!parsedBody.success) {
    res.status(400).json({ error: "Invalid registration details" });
    return;
  }

  const createdUser = await registerUser(
    parsedBody.data.name,
    parsedBody.data.email,
    parsedBody.data.password,
  );

  if (!createdUser) {
    res.status(409).json({ error: "Email is already registered" });
    return;
  }

  res.status(201).json({ user: createdUser });
}
