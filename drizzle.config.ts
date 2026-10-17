import 'dotenv/config';
import { defineConfig } from 'drizzle-kit';

export default defineConfig({
  out: './drizzle',
  schema: [
    './apps/public-api/src/db/schema/index.ts',
    './apps/order-service/src/db/schema/index.ts',
    './apps/event-service/src/db/schema/index.ts',
    './apps/email-service/src/db/schema/index.ts',
    './apps/payment-service/src/db/schema/index.ts',
  ],
  dialect: 'postgresql',
  dbCredentials: {
    url: process.env.MIGRATION_DATABASE_URL ?? process.env.DATABASE_URL!,
  },
});
