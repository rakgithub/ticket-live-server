import bcrypt from "bcryptjs";
import { and, eq, isNull } from "drizzle-orm";
import { createAccessToken } from "../../auth/accessToken.ts";
import { db } from "../../db/client.ts";
import { usersTable } from "../../db/schema/users.ts";

export type LoginResult = {
  accessToken: string;
  user: {
    id: string;
    name: string;
    email: string;
  };
};

export async function authenticateUser(
  email: string,
  password: string,
): Promise<LoginResult | null> {
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
    return null;
  }

  return {
    accessToken: await createAccessToken(user.id),
    user: {
      id: user.id,
      name: user.name,
      email: user.email,
    },
  };
}
