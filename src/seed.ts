/**
 * Seeds the three roles. Users are provisioned separately — the seed never
 * creates a credential from the environment.
 * Replaces the old `python scripts/init_db.py`.
 *
 *   docker compose exec soc-core-api npm run seed
 */
import { PrismaClient } from '@prisma/client';

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

  console.log('\nDatabase seeded.');
}

main()
  .catch((err) => {
    console.error(err);
    process.exit(1);
  })
  .finally(() => prisma.$disconnect());
