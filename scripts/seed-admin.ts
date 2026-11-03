import { eq } from 'drizzle-orm';
import { createDb } from '../src/config/db.js';
import { users } from '../src/model/schema.js';
import { hashPassword } from '../src/service/password.js';

const { DATABASE_URL, ADMIN_EMAIL, ADMIN_PASSWORD, ADMIN_NAME = 'Admin' } = process.env;
if (!DATABASE_URL || !ADMIN_EMAIL || !ADMIN_PASSWORD) {
  console.error('Set DATABASE_URL, ADMIN_EMAIL and ADMIN_PASSWORD');
  process.exit(1);
}
const { db, close } = createDb(DATABASE_URL);
const email = ADMIN_EMAIL.toLowerCase();
const [existing] = await db.select().from(users).where(eq(users.email, email)).limit(1);
if (existing) {
  console.log(`User ${email} already exists (role ${existing.role})`);
} else {
  await db.insert(users).values({ name: ADMIN_NAME, email, role: 'ADMIN', passwordHash: await hashPassword(ADMIN_PASSWORD) });
  console.log(`Created admin ${email}`);
}
await close();
