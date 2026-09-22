/**
 * Seeds the three roles and the bootstrap admin user.
 * Replaces the old `python scripts/init_db.py`.
 *
 *   docker compose exec soc-core-api npm run seed
 */
import { PrismaClient } from '@prisma/client';
import * as bcrypt from 'bcrypt';

const prisma = new PrismaClient();

const ROLES: Array<{ name: string; description: string }> = [
  { name: 'admin', description: 'Full system access' },
  { name: 'analyst', description: 'Can analyze and manage own API keys' },
  { name: 'readonly', description: 'Read-only access to own jobs' },
];

async function main() {
  for (const role of ROLES) {
    await prisma.role.upsert({
      where: { name: role.name },
      update: {},
      create: role,
    });
    console.log(`  [=] role: ${role.name}`);
  }

  const username = process.env.DEFAULT_ADMIN_USERNAME ?? 'admin';
  const existing = await prisma.user.findUnique({ where: { username } });

  if (existing) {
    console.log(`  [=] admin user already exists: ${username}`);
  } else {
    const adminRole = await prisma.role.findUniqueOrThrow({ where: { name: 'admin' } });
    const password = process.env.DEFAULT_ADMIN_PASSWORD;

    // Refused rather than defaulted. A fallback would be a password that ships
    // in the source, and this branch runs once — so an install that never set
    // it ends up with an account whose password is public and nothing to say
    // so. Stopping here is loud; a working login with a known password is not.
    if (!password) {
      throw new Error(
        'DEFAULT_ADMIN_PASSWORD is not set, and there is no default. Set it to ' +
          'something you generated, then run the seed again:\n' +
          "  DEFAULT_ADMIN_PASSWORD=\"$(openssl rand -base64 24)\" npm run seed",
      );
    }

    await prisma.user.create({
      data: {
        username,
        email: process.env.DEFAULT_ADMIN_EMAIL ?? 'admin@soc.local',
        hashedPassword: await bcrypt.hash(password, 12),
        roleId: adminRole.id,
      },
    });
    console.log(`  [+] created admin user: ${username}`);
    // The password is not echoed. Whoever ran this set it; printing it puts a
    // live credential into CI logs and shell history for no one's benefit.
    console.log('      password: the one you set in DEFAULT_ADMIN_PASSWORD');
  }

  console.log('\nDatabase seeded.');
}

main()
  .catch((err) => {
    console.error(err);
    process.exit(1);
  })
  .finally(() => prisma.$disconnect());
