import { execFileSync } from 'node:child_process';

export default function setup() {
  execFileSync('npm', ['run', 'build'], { stdio: 'inherit', env: { ...process.env, NODE_ENV: 'production' } });
}
