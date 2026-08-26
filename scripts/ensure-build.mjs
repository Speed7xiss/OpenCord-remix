import { existsSync } from 'node:fs';
import { spawnSync } from 'node:child_process';

const requiredBuildFiles = [
  'server/dist/index.js',
  'client/dist/index.html',
];

const needsBuild = requiredBuildFiles.some((file) => !existsSync(file));

if (!needsBuild) {
  process.exit(0);
}

console.log('Build not found. Building OpenCord...');

const npmCommand = process.platform === 'win32' ? 'npm.cmd' : 'npm';
const result = spawnSync(npmCommand, ['run', 'build'], {
  cwd: process.cwd(),
  stdio: 'inherit',
  shell: false,
});

if (result.error) {
  console.error('Failed to start the build process:', result.error.message);
  process.exit(1);
}

process.exit(result.status ?? 1);
