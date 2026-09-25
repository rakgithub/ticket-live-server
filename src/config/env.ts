import "dotenv/config";
import { z } from "zod";

const envSchema = z.object({
  NODE_ENV: z
    .enum(["development", "test", "production"])
    .default("development"),
  PORT: z.coerce.number().int().min(1).max(65_535).default(4002),
  TRUST_PROXY_HOPS: z.coerce.number().int().min(0).max(5).default(0),
  DATABASE_URL: z.string().min(1, "DATABASE_URL is required"),
  JWT_SECRET: z.string().min(1, "JWT_SECRET is required"),
  ACCESS_TOKEN_TTL: z
    .string()
    .regex(/^\d+[smhd]$/, "ACCESS_TOKEN_TTL must look like 15m, 1h, or 1d")
    .default("15m"),
  CORS_ORIGINS: z
    .string()
    .default("http://localhost:3000,http://localhost:5173"),
}).superRefine((values, context) => {
  if (values.NODE_ENV === "production" && !process.env.CORS_ORIGINS) {
    context.addIssue({
      code: "custom",
      path: ["CORS_ORIGINS"],
      message: "CORS_ORIGINS must be configured in production",
    });
  }
});

const parsedEnv = envSchema.safeParse(process.env);

if (!parsedEnv.success) {
  const details = parsedEnv.error.issues
    .map(({ path, message }) => `${path.join(".")}: ${message}`)
    .join("; ");
  throw new Error(`Invalid environment configuration: ${details}`);
}

if (new TextEncoder().encode(parsedEnv.data.JWT_SECRET).length < 32) {
  throw new Error(
    "Invalid environment configuration: JWT_SECRET must be at least 32 bytes",
  );
}

export const env = parsedEnv.data;

export const corsOrigins = new Set(
  env.CORS_ORIGINS.split(",").map((origin) => origin.trim()).filter(Boolean),
);

if (corsOrigins.size === 0) {
  throw new Error(
    "Invalid environment configuration: CORS_ORIGINS must include at least one origin",
  );
}

for (const origin of corsOrigins) {
  if (new URL(origin).origin !== origin) {
    throw new Error(
      `Invalid environment configuration: ${origin} must be an origin without a path`,
    );
  }
}
