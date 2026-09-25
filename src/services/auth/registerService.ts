import bcrypt from "bcryptjs";
import { eq } from "drizzle-orm";
import { db } from "../../db/client.ts";
import { usersTable } from "../../db/schema/users.ts";

export type RegisteredUser = {
  id: string;
  name: string;
  email: string;
};

function isUniqueViolation(error: unknown): boolean {
  return (
    typeof error === "object" &&
    error !== null &&
    "code" in error &&
    error.code === "23505"
  );
}

export async function registerUser(
  name: string,
  email: string,
  password: string,
): Promise<RegisteredUser | null> {
  const existingUser = await db
    .select({ id: usersTable.id })
    .from(usersTable)
    .where(eq(usersTable.email, email))
    .limit(1);

  if (existingUser.length > 0) {
    return null;
  }

  const passwordHash = await bcrypt.hash(password, 12);

  try {
    const [createdUser] = await db
      .insert(usersTable)
      .values({
        displayName: name,
        email,
        passwordHash,
      })
      .returning({
        id: usersTable.id,
        name: usersTable.displayName,
        email: usersTable.email,
      });

    return createdUser;
  } catch (error) {
    // The unique constraint is the final guard if two requests race past the lookup.
    if (isUniqueViolation(error)) {
      return null;
    }

    throw error;
  }
}
