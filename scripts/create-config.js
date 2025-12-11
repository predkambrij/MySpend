const crypto = require('crypto');
const fs = require('fs');
const path = require('path');
const readline = require('readline');

const argon2 = require('argon2');

const MINIMUM_PASSWORD_LENGTH = 20;

async function readPassword() {
  const input = readline.createInterface({ input: process.stdin, terminal: false });
  let password = '';
  for await (const line of input) {
    password = line;
    break;
  }
  input.close();
  return password;
}

async function main() {
  const publicOrigin = process.argv[2];
  let origin;
  try {
    origin = new URL(publicOrigin);
  } catch {
    throw new Error('Usage: npm run create-config -- https://app.example.com');
  }
  if (origin.protocol !== 'https:' || origin.origin !== publicOrigin) {
    throw new Error('The public origin must use HTTPS and must not include a path or trailing slash.');
  }

  const password = await readPassword();
  if (password.length < MINIMUM_PASSWORD_LENGTH) {
    throw new Error(`Password must contain at least ${MINIMUM_PASSWORD_LENGTH} characters.`);
  }

  const config = {
    server: { host: '0.0.0.0', port: 3000 },
    publicOrigin,
    passwordHash: await argon2.hash(password, { type: argon2.argon2id }),
    sessionSecret: crypto.randomBytes(32).toString('hex'),
  };
  const configFile = path.join(process.cwd(), 'config.json');
  fs.writeFileSync(configFile, `${JSON.stringify(config, null, 2)}\n`, { flag: 'wx', mode: 0o600 });
  process.stderr.write('Created config.json with mode 0600.\n');
}

main().catch((error) => {
  console.error(`ERROR: ${error.message}`);
  process.exitCode = 1;
});
