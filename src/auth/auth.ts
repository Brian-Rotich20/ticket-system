// src/auth/auth.ts
import { betterAuth } from "better-auth";
import { drizzleAdapter } from "better-auth/adapters/drizzle";
import * as schema from "../model/schema";
import { db } from "../config/db"; // Point to your drizzle db config

export const auth = betterAuth({
  database: drizzleAdapter(db, {
    provider: "pg",
    schema: schema,
  }),
  emailAndPassword: { enabled: true },
  user: {
    additionalFields: {
      tenantId: { type: "string", required: true },
      role: { type: "string", required: true, defaultValue: "CUSTOMER" },
    },
  },
});
