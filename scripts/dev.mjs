/**
 * 开发模式：同时起 API（3001）与 Vite 开发服务器（5173）。
 *
 * 不引 concurrently 这类依赖 —— 只有两个进程，spawn 就够了。
 * Vite 已配好 /api 代理到 3001（见 vite.config.ts），
 * 所以浏览器只需访问 http://localhost:5173。
 *
 * 任一进程退出，另一个也一起收掉，避免留下孤儿进程占着端口。
 */

import { spawn } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const isWin = process.platform === 'win32';

if (!fs.existsSync(path.join(ROOT, 'data', 'app.db'))) {
  console.error('找不到 data/app.db。请先运行：');
  console.error('  npm run build:db && npm run seed');
  process.exit(1);
}

/** @type {import('node:child_process').ChildProcess[]} */
const children = [];

function run(name, command, args, color) {
  const child = spawn(command, args, {
    cwd: ROOT,
    shell: isWin,
    stdio: ['ignore', 'pipe', 'pipe'],
    env: { ...process.env, FORCE_COLOR: '1' },
  });

  const tag = `\u001b[${color}m[${name}]\u001b[0m `;
  const pipe = (stream, out) => {
    stream.setEncoding('utf8');
    let buf = '';
    stream.on('data', (chunk) => {
      buf += chunk;
      const lines = buf.split('\n');
      buf = lines.pop() ?? '';
      for (const line of lines) out.write(tag + line + '\n');
    });
  };
  pipe(child.stdout, process.stdout);
  pipe(child.stderr, process.stderr);

  child.on('exit', (code) => {
    console.log(`${tag}退出（code ${code ?? 0}）`);
    shutdown();
  });

  children.push(child);
  return child;
}

let shuttingDown = false;
function shutdown() {
  if (shuttingDown) return;
  shuttingDown = true;
  for (const c of children) {
    if (!c.killed) c.kill();
  }
  // 给子进程一点时间做优雅退出
  setTimeout(() => process.exit(0), 300);
}

process.on('SIGINT', shutdown);
process.on('SIGTERM', shutdown);

run('api', 'node', ['--watch', 'server/index.mjs'], '36');
run('web', 'npx', ['vite'], '35');

console.log('\n开发服务器启动中… 浏览器打开 http://localhost:5173\n');
