import { execFileSync, spawn } from 'node:child_process';
import { mkdtempSync, mkdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = fileURLToPath(new URL('../', import.meta.url));
const wrangler = fileURLToPath(new URL('../node_modules/wrangler/bin/wrangler.js', import.meta.url));
const scratch = mkdtempSync(join(tmpdir(), 'vysta-verify-'));
const wranglerConfig = join(scratch, 'wrangler-config');
mkdirSync(wranglerConfig);
const wranglerEnv = { XDG_CONFIG_HOME: wranglerConfig };

function run(command, args, env = {}) {
  execFileSync(command, args, { cwd: root, stdio: 'inherit', env: { ...process.env, ...env } });
}

function migrate(persistTo) {
  run(process.execPath, [wrangler, 'd1', 'migrations', 'apply', 'minilytics', '--local', '--persist-to', persistTo], wranglerEnv);
}

async function waitForWorker(child, base) {
  const deadline = Date.now() + 30_000;
  while (Date.now() < deadline) {
    if (child.exitCode !== null) throw new Error(`Wrangler exited before ${base} was ready (code ${child.exitCode})`);
    try {
      const response = await fetch(`${base}/api/health`);
      if (response.ok) return;
    } catch {}
    await new Promise((resolve) => setTimeout(resolve, 250));
  }
  throw new Error(`Timed out waiting for ${base}`);
}

async function stopWorker(child) {
  if (child.exitCode !== null || !child.pid) return;
  if (process.platform === 'win32') {
    try {
      execFileSync('taskkill', ['/PID', String(child.pid), '/T', '/F'], { stdio: 'ignore' });
    } catch {}
  } else {
    child.kill('SIGTERM');
  }
  if (child.exitCode === null) {
    await new Promise((resolve) => {
      const timer = setTimeout(resolve, 3_000);
      child.once('exit', () => {
        clearTimeout(timer);
        resolve();
      });
    });
  }
}

async function smoke({ name, port, persistTo, vars, script, env }) {
  console.log(`\n== ${name} ==`);
  migrate(persistTo);
  const args = [wrangler, 'dev', '--local', '--ip', '127.0.0.1', '--port', String(port), '--persist-to', persistTo];
  for (const [key, value] of Object.entries(vars)) args.push('--var', `${key}:${value}`);
  const child = spawn(process.execPath, args, {
    cwd: root,
    stdio: 'inherit',
    windowsHide: true,
    env: { ...process.env, ...wranglerEnv },
  });
  const base = `http://127.0.0.1:${port}`;
  try {
    await waitForWorker(child, base);
    run(process.execPath, [script], { BASE: base, WRANGLER_PERSIST_TO: persistTo, ...wranglerEnv, ...env });
  } finally {
    await stopWorker(child);
  }
}

try {
  console.log('== verify ==');
  const npmCli = process.env.npm_execpath;
  if (!npmCli) throw new Error('npm_execpath is unavailable; run this script through npm run verify:full');
  run(process.execPath, [npmCli, 'run', 'verify']);

  const selfHosted = join(scratch, 'self-hosted');
  const hosted = join(scratch, 'hosted');
  mkdirSync(selfHosted);
  mkdirSync(hosted);

  await smoke({
    name: 'self-hosted smoke',
    port: 18787,
    persistTo: selfHosted,
    vars: { ADMIN_PASSWORD: 'change-me', SESSION_SECRET: 'verify-only-session-secret' },
    script: 'scripts/smoke.mjs',
    env: { ADMIN_PASSWORD: 'change-me' },
  });

  await smoke({
    name: 'hosted smoke',
    port: 18788,
    persistTo: hosted,
    vars: {
      ADMIN_PASSWORD: 'change-me',
      SESSION_SECRET: 'any-long-random-string',
      GOOGLE_CLIENT_ID: 'test',
      GOOGLE_CLIENT_SECRET: 'test',
      ADMIN_EMAILS: 'owner@example.com',
      PLAN_PRODUCT_ID: 'pdt_plan',
      PLAN_SPOTS: '50',
      PLAN_CHECKOUT_URL: 'https://checkout.dodopayments.com/buy/pdt_plan?quantity=1',
      BILLING_WEBHOOK_SECRET: 'whsec_dGVzdC1iaWxsaW5nLXNlY3JldA==',
    },
    script: 'scripts/smoke-hosted.mjs',
    env: { SESSION_SECRET: 'any-long-random-string' },
  });

  console.log('\nFull verification passed');
} finally {
  try {
    rmSync(scratch, { recursive: true, force: true, maxRetries: 10, retryDelay: 200 });
  } catch (error) {
    console.warn(`Could not remove temporary verification directory ${scratch}: ${error.code ?? error}`);
  }
}

// Wrangler can leave an unreferenced Windows runtime handle alive after its process tree stops.
process.exit(0);
