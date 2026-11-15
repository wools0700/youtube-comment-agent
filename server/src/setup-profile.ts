import { spawn } from 'node:child_process';
import { existsSync } from 'node:fs';
import { mkdir } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

const profile = process.argv[2];
if (!['youtube1', 'youtube2', 'youtube3'].includes(profile ?? '')) {
  console.error('사용법: npm run setup:profile -w server -- youtube1');
  process.exit(1);
}

const chromePaths = [
  path.join(process.env.PROGRAMFILES ?? '', 'Google', 'Chrome', 'Application', 'chrome.exe'),
  path.join(process.env['PROGRAMFILES(X86)'] ?? '', 'Google', 'Chrome', 'Application', 'chrome.exe'),
  path.join(process.env.LOCALAPPDATA ?? '', 'Google', 'Chrome', 'Application', 'chrome.exe'),
].filter((candidate) => existsSync(candidate));
if (!chromePaths[0]) {
  console.error('Google Chrome을 찾지 못했습니다. Chrome을 설치한 뒤 다시 실행하세요.');
  process.exit(1);
}

const dataDir = fileURLToPath(new URL('../../data/', import.meta.url));
const profileDir = path.join(dataDir, `chrome-${profile}`);
await mkdir(profileDir, { recursive: true });
const chrome = spawn(chromePaths[0], [
  `--user-data-dir=${profileDir}`, '--no-first-run', '--no-default-browser-check',
  'https://www.youtube.com/',
], { detached: true, stdio: 'ignore', windowsHide: false });
chrome.on('error', (error) => { console.error(`Chrome 실행 실패: ${error.message}`); process.exitCode = 1; });
chrome.unref();
console.log(`${profile} 전용 Chrome 창을 열었습니다. YouTube에 로그인한 뒤 이 창을 완전히 닫으세요.`);
