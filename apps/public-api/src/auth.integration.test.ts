import { readdir, readFile } from "node:fs/promises";
import { resolve } from "node:path";
import express from "express";
import { PostgreSqlContainer } from "@testcontainers/postgresql";
import { Pool } from "pg";
import request from "supertest";
import { z } from "zod";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";

const databaseName = "ticket_live_integration";
const adminUsername = "postgres";
const adminPassword = "integration-admin-password";
const publicApiPassword = "integration-public-api-password";
const originalDatabaseUrl = process.env.DATABASE_URL;

let container: Awaited<ReturnType<PostgreSqlContainer["start"]>> | undefined;
let adminPool: Pool | undefined;
let publicApiPool: Pool | undefined;
let app: express.Express;

function getAdminPool(): Pool {
  if (!adminPool) {
    throw new Error("The integration database has not been started");
  }
  return adminPool;
}

async function createDatabaseRoles(pool: Pool): Promise<void> {
  const roles = [
    "ticketlive_order",
    "ticketlive_event",
    "ticketlive_email",
    "ticketlive_payment",
    "ticketlive_ticketing",
  ];

  for (const role of roles) {
    await pool.query(`CREATE ROLE ${role} NOLOGIN`);
  }

  await pool.query(
    `CREATE ROLE ticketlive_public_api LOGIN PASSWORD '${publicApiPassword}'`,
  );
  await pool.query(
    `GRANT CONNECT ON DATABASE ${databaseName} TO ticketlive_public_api`,
  );
}

async function applyRepositoryMigrations(pool: Pool): Promise<void> {
  const migrationsDirectory = resolve(process.cwd(), "drizzle");
  const migrationDirectories = (await readdir(migrationsDirectory, {
    withFileTypes: true,
  }))
    .filter((entry) => entry.isDirectory())
    .map((entry) => entry.name)
    .sort();

  for (const migrationDirectory of migrationDirectories) {
    const directoryPath = resolve(migrationsDirectory, migrationDirectory);
    const migrationFiles = (await readdir(directoryPath))
      .filter((file) => file.endsWith(".sql"))
      .sort();

    for (const migrationFile of migrationFiles) {
      const migration = await readFile(
        resolve(directoryPath, migrationFile),
        "utf8",
      );
      const statements = migration
        .split(/--> statement-breakpoint\s*/g)
        .map((statement) => statement.trim())
        .filter(Boolean);

      for (const statement of statements) {
        await pool.query(statement);
      }
    }
  }
}

function createApp(): express.Express {
  const integrationApp = express();
  integrationApp.use(express.json());
  integrationApp.use("/", authRoutes);
  integrationApp.use(requireAuth);
  integrationApp.get("/protected", (req, res) => {
    res.json({ userId: req.auth?.userId });
  });
  return integrationApp;
}

let authRoutes: (typeof import("./routes/authRoutes.ts"))[
  "default"
];
let requireAuth: (typeof import("./auth/requireAuth.ts"))["requireAuth"];

beforeAll(async () => {
  container = await new PostgreSqlContainer("postgres:16.15-bookworm")
    .withDatabase(databaseName)
    .withUsername(adminUsername)
    .withPassword(adminPassword)
    .start();

  const adminUrl = container.getConnectionUri();
  adminPool = new Pool({ connectionString: adminUrl });
  await createDatabaseRoles(adminPool);
  await applyRepositoryMigrations(adminPool);

  const publicApiUrl = new URL(adminUrl);
  publicApiUrl.username = "ticketlive_public_api";
  publicApiUrl.password = publicApiPassword;
  process.env.DATABASE_URL = publicApiUrl.toString();

  await adminPool.query(
    "GRANT USAGE ON SCHEMA public TO ticketlive_public_api",
  );
  await adminPool.query(
    "GRANT SELECT, INSERT, UPDATE, DELETE ON ALL TABLES IN SCHEMA public TO ticketlive_public_api",
  );

  const [routesModule, authModule] = await Promise.all([
    import("./routes/authRoutes.ts"),
    import("./auth/requireAuth.ts"),
  ]);
  authRoutes = routesModule.default;
  requireAuth = authModule.requireAuth;

  const databaseModule = await import("./db/client.ts");
  publicApiPool = databaseModule.pool;
  app = createApp();
}, 120_000);

afterAll(async () => {
  try {
    await publicApiPool?.end();
  } finally {
    try {
      await adminPool?.end();
    } finally {
      try {
        await container?.stop();
      } finally {
        if (originalDatabaseUrl === undefined) {
          delete process.env.DATABASE_URL;
        } else {
          process.env.DATABASE_URL = originalDatabaseUrl;
        }
      }
    }
  }
});

beforeEach(async () => {
  await getAdminPool().query(
    "TRUNCATE TABLE public.revoked_access_tokens, public.users",
  );
});

describe("Public API authentication integration", () => {
  it("keeps each service database role inside its own private schema", async () => {
    const serviceStorage = new Map([
      ["ticketlive_order", { schema: "order_service", table: "orders" }],
      ["ticketlive_event", { schema: "event_service", table: "events" }],
      ["ticketlive_email", { schema: "email_service", table: "email_deliveries" }],
      ["ticketlive_payment", { schema: "payment_service", table: "payments" }],
      ["ticketlive_ticketing", { schema: "ticketing_service", table: "tickets" }],
    ]);

    for (const [role, ownedStorage] of serviceStorage) {
      for (const { schema, table } of serviceStorage.values()) {
        const result = await getAdminPool().query<{ can_use_schema: boolean }>(
          "SELECT has_schema_privilege($1, $2, 'USAGE') AS can_use_schema",
          [role, schema],
        );

        const expectedAccess = schema === ownedStorage.schema;
        expect(result.rows[0]?.can_use_schema).toBe(expectedAccess);

        for (const privilege of ["SELECT", "INSERT", "UPDATE", "DELETE"]) {
          const tableAccess = await getAdminPool().query<{ has_privilege: boolean }>(
            "SELECT has_table_privilege($1, $2, $3) AS has_privilege",
            [role, `${schema}.${table}`, privilege],
          );
          expect(tableAccess.rows[0]?.has_privilege).toBe(expectedAccess);
        }
      }
    }
  });

  it("registers users with normalized details and stores a password hash", async () => {
    const response = await request(app).post("/register").send({
      name: "  Casey Example  ",
      email: "CASEY@EXAMPLE.COM",
      password: "correct horse battery staple",
    });

    expect(response.status).toBe(201);
    expect(response.body).toEqual({
      user: {
        id: expect.any(String),
        name: "Casey Example",
        email: "casey@example.com",
      },
    });
    expect(response.body.user).not.toHaveProperty("passwordHash");

    const storedUser = await getAdminPool().query<{
      display_name: string;
      email: string;
      password_hash: string;
    }>(
      "SELECT display_name, email, password_hash FROM public.users WHERE email = $1",
      ["casey@example.com"],
    );

    expect(storedUser.rows).toHaveLength(1);
    expect(storedUser.rows[0]).toMatchObject({
      display_name: "Casey Example",
      email: "casey@example.com",
    });
    expect(storedUser.rows[0]?.password_hash).not.toBe(
      "correct horse battery staple",
    );
  });

  it("rejects invalid registration details without creating a user", async () => {
    const invalidRegistrations = [
      {
        name: "blank name",
        body: {
          name: "   ",
          email: "casey@example.com",
          password: "correct horse battery staple",
        },
      },
      {
        name: "invalid email",
        body: {
          name: "Casey Example",
          email: "not-an-email",
          password: "correct horse battery staple",
        },
      },
      {
        name: "short password",
        body: {
          name: "Casey Example",
          email: "casey@example.com",
          password: "short",
        },
      },
    ];

    for (const registration of invalidRegistrations) {
      const response = await request(app)
        .post("/register")
        .send(registration.body);

      expect(response.status, registration.name).toBe(400);
      expect(response.body).toEqual({
        error: "Invalid registration details",
      });
    }

    const storedUsers = await getAdminPool().query("SELECT id FROM public.users");
    expect(storedUsers.rows).toHaveLength(0);
  });

  it("returns a conflict when concurrent registrations use the same email", async () => {
    const registration = {
      name: "Casey Example",
      email: "casey@example.com",
      password: "correct horse battery staple",
    };

    const responses = await Promise.all([
      request(app).post("/register").send(registration),
      request(app).post("/register").send(registration),
    ]);

    expect(responses.map((response) => response.status).sort()).toEqual([
      201,
      409,
    ]);

    const storedUsers = await getAdminPool().query(
      "SELECT id FROM public.users WHERE email = $1",
      [registration.email],
    );
    expect(storedUsers.rows).toHaveLength(1);
  });

  it("authenticates a registered user and protects routes with its bearer token", async () => {
    await request(app).post("/register").send({
      name: "Casey Example",
      email: "casey@example.com",
      password: "correct horse battery staple",
    }).expect(201);

    const missingTokenResponse = await request(app).get("/protected");
    expect(missingTokenResponse.status).toBe(401);
    expect(missingTokenResponse.body).toEqual({
      error: "Authentication required",
    });

    const invalidCredentials = await request(app)
      .post("/login")
      .send({
        email: "CASEY@EXAMPLE.COM",
        password: "incorrect password",
      });
    expect(invalidCredentials.status).toBe(401);
    expect(invalidCredentials.body).toEqual({
      error: "Invalid email or password",
    });

    const loginResponse = await request(app)
      .post("/login")
      .send({
        email: "CASEY@EXAMPLE.COM",
        password: "correct horse battery staple",
      });

    expect(loginResponse.status).toBe(200);
    const accessToken = z.string().parse(loginResponse.body.accessToken);
    const userId = z.string().parse(loginResponse.body.user.id);
    expect(loginResponse.body).toMatchObject({
      accessToken,
      tokenType: "Bearer",
      user: {
        id: userId,
        name: "Casey Example",
        email: "casey@example.com",
      },
    });

    const protectedResponse = await request(app)
      .get("/protected")
      .set("Authorization", `Bearer ${accessToken}`);
    expect(protectedResponse.status).toBe(200);
    expect(protectedResponse.body).toEqual({
      userId,
    });
  });

  it("revokes a bearer token after logout", async () => {
    await request(app).post("/register").send({
      name: "Casey Example",
      email: "casey@example.com",
      password: "correct horse battery staple",
    }).expect(201);

    const loginResponse = await request(app)
      .post("/login")
      .send({
        email: "casey@example.com",
        password: "correct horse battery staple",
      })
      .expect(200);
    const accessToken = z.string().parse(loginResponse.body.accessToken);

    await request(app)
      .post("/logout")
      .set("Authorization", `Bearer ${accessToken}`)
      .expect(204);

    const protectedResponse = await request(app)
      .get("/protected")
      .set("Authorization", `Bearer ${accessToken}`);
    expect(protectedResponse.status).toBe(401);
    expect(protectedResponse.body).toEqual({
      error: "Invalid or expired access token",
    });

    const revokedToken = await getAdminPool().query(
      "SELECT token_id FROM public.revoked_access_tokens",
    );
    expect(revokedToken.rows).toHaveLength(1);
  });
});
