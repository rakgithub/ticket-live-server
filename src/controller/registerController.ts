import bcrypt from "bcryptjs";
import { eq } from "drizzle-orm";
import type { Request, Response } from "express";
import { z } from "zod";
import { db } from "../db/client.ts";
import { usersTable } from "../db/schema/users.ts";

const registerBodySchema = z.object({
  name: z.string().trim().min(1).max(255),
  email: z.email().trim().toLowerCase(),
  password: z.string().min(12).refine(
    (password) => new TextEncoder().encode(password).length <= 72,
    "Password must be no more than 72 bytes",
  ),
});

function isUniqueViolation(error: unknown): boolean {
  return (
    typeof error === "object" &&
    error !== null &&
    "code" in error &&
    error.code === "23505"
  );
}

export async function register(req: Request, res: Response): Promise<void> {
  const parsedBody = registerBodySchema.safeParse(req.body);
  if (!parsedBody.success) {
    res.status(400).json({ error: "Invalid registration details" });
    return;
  }

  const { name, email, password } = parsedBody.data;

  const existingUser = await db
    .select({ id: usersTable.id })
    .from(usersTable)
    .where(eq(usersTable.email, email))
    .limit(1);

  if (existingUser.length > 0) {
    res.status(409).json({ error: "Email is already registered" });
    return;
  }

  const passwordHash = await bcrypt.hash(password, 12);

  try {
    const [createdUser] = await db
      .insert(usersTable)
      .values({
        displayName: name,
        email: email,
        passwordHash: passwordHash,
      })
      .returning({
        id: usersTable.id,
        name: usersTable.displayName,
        email: usersTable.email,
      });

    res.status(201).json({ user: createdUser });
  } catch (error) {
    // The unique constraint is the final guard if two requests race past the lookup.
    if (isUniqueViolation(error)) {
      res.status(409).json({ error: "Email is already registered" });
      return;
    }

    throw error;
  }
}
