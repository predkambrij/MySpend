const argon2 = require('argon2');
const readline = require('readline');

const MINIMUM_PASSWORD_LENGTH = 20;

async function readPassword() {
  const input = readline.createInterface({
    input: process.stdin,
    output: process.stderr,
    terminal: false,
  });

  let password = '';
  for await (const line of input) {
    password = line;
    break;
  }
  input.close();
  return password;
}

async function main() {
  const password = await readPassword();
  if (password.length < MINIMUM_PASSWORD_LENGTH) {
    throw new Error(`Password must contain at least ${MINIMUM_PASSWORD_LENGTH} characters.`);
  }

  const passwordHash = await argon2.hash(password, { type: argon2.argon2id });
  process.stdout.write(`${passwordHash}\n`);
}

main().catch((error) => {
  console.error(`ERROR: ${error.message}`);
  process.exitCode = 1;
});
