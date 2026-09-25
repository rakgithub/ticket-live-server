import bcrypt from "bcryptjs";
import { and, eq, isNull } from "drizzle-orm";
import type { Request, Response } from "express";
import { z } from "zod";
import { db } from "../db/client.ts";
import { usersTable } from "../db/schema/users.ts";
import { createAccessToken } from "../auth/accessToken.ts";

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

  const { email, password } = parsedBody.data;
  const [user] = await db
    .select({
      id: usersTable.id,
      name: usersTable.displayName,
      email: usersTable.email,
      passwordHash: usersTable.passwordHash,
    })
    .from(usersTable)
    .where(and(eq(usersTable.email, email), isNull(usersTable.deletedAt)))
    .limit(1);

  if (!user || !(await bcrypt.compare(password, user.passwordHash))) {
    res.status(401).json({ error: "Invalid email or password" });
    return;
  }

  const accessToken = await createAccessToken(user.id);

  res.status(200).json({
    accessToken,
    tokenType: "Bearer",
    user: {
      id: user.id,
      name: user.name,
      email: user.email,
    },
  });
}
