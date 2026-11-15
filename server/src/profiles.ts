import { spawn } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { existsSync } from 'node:fs';
import { mkdir, readFile, rename, rm, writeFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import { chromium } from 'playwright';

export type ManagedProfile = {
  id: string;
  name: string;
  connection: 'unverified' | 'connected' | 'disconnected';
  checkedAt?: string;
};

export class ProfileError extends Error {
  constructor(public status: number, message: string) { super(message); }
}

const dataDir = fileURLToPath(new URL('../../data/', import.meta.url));
const registryPath = path.join(dataDir, 'profiles.json');
const initialProfiles: ManagedProfile[] = [1, 2, 3].map((number) => ({
  id: `youtube${number}`, name: `유튜브${number}`, connection: 'unverified',
}));

export function profileDir(id: string): string { return path.join(dataDir, `chrome-${id}`); }

export async function listProfiles(): Promise<ManagedProfile[]> {
  try { return JSON.parse(await readFile(registryPath, 'utf8')) as ManagedProfile[]; }
  catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return initialProfiles;
    throw error;
  }
}

async function saveProfiles(profiles: ManagedProfile[]): Promise<void> {
  await mkdir(dataDir, { recursive: true });
  const tempPath = `${registryPath}.${randomUUID()}.tmp`;
  await writeFile(tempPath, JSON.stringify(profiles, null, 2), 'utf8');
  await rename(tempPath, registryPath);
}

function validName(value: unknown): string {
  const name = typeof value === 'string' ? value.trim() : '';
  if (!name || name.length > 30) throw new ProfileError(400, '프로필 이름은 1~30자로 입력하세요.');
  return name;
}

export async function getProfile(id: string): Promise<ManagedProfile> {
  const profile = (await listProfiles()).find((item) => item.id === id);
  if (!profile) throw new ProfileError(404, '프로필을 찾지 못했습니다.');
  return profile;
}

export async function addProfile(value: unknown): Promise<ManagedProfile> {
  const name = validName(value);
  const profiles = await listProfiles();
  if (profiles.length >= 20) throw new ProfileError(400, '프로필은 최대 20개까지 추가할 수 있습니다.');
  const profile: ManagedProfile = { id: `youtube-${randomUUID()}`, name, connection: 'unverified' };
  profiles.push(profile);
  await mkdir(profileDir(profile.id), { recursive: true });
  await saveProfiles(profiles);
  return profile;
}

export async function renameProfile(id: string, value: unknown): Promise<ManagedProfile> {
  const name = validName(value);
  const profiles = await listProfiles();
  const profile = profiles.find((item) => item.id === id);
  if (!profile) throw new ProfileError(404, '프로필을 찾지 못했습니다.');
  profile.name = name;
  await saveProfiles(profiles);
  return profile;
}

export async function deleteProfile(id: string): Promise<void> {
  const folder = safeProfileFolder(id);
  const profiles = await listProfiles();
  if (!profiles.some((profile) => profile.id === id)) throw new ProfileError(404, '프로필을 찾지 못했습니다.');
  try {
    await rm(folder, { recursive: true, force: true, maxRetries: 2, retryDelay: 100 });
  } catch {
    throw new ProfileError(409, '전용 Chrome 창을 완전히 닫은 뒤 다시 삭제하세요.');
  }
  await saveProfiles(profiles.filter((profile) => profile.id !== id));
}

function safeProfileFolder(id: string): string {
  if (!/^youtube(?:[123]|-[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})$/i.test(id)) {
    throw new ProfileError(400, '올바르지 않은 프로필 ID입니다.');
  }
  const folder = path.resolve(profileDir(id));
  if (path.dirname(folder) !== path.resolve(dataDir)) {
    throw new ProfileError(400, '프로필 경로가 올바르지 않습니다.');
  }
  return folder;
}

export async function openProfileLogin(id: string, reset = false): Promise<void> {
  await getProfile(id);
  const folder = safeProfileFolder(id);
  const chrome = [process.env.PROGRAMFILES, process.env['PROGRAMFILES(X86)'], process.env.LOCALAPPDATA]
    .filter((root): root is string => Boolean(root))
    .map((root) => path.join(root, 'Google', 'Chrome', 'Application', 'chrome.exe'))
    .find(existsSync);
  if (!chrome) throw new ProfileError(500, 'Google Chrome을 찾지 못했습니다.');
  if (reset) {
    try {
      await rm(folder, { recursive: true, force: true, maxRetries: 2, retryDelay: 100 });
    } catch {
      throw new ProfileError(409, '기존 전용 Chrome 창을 완전히 닫은 뒤 계정을 변경하세요.');
    }
  }
  await mkdir(folder, { recursive: true });
  await new Promise<void>((resolve, reject) => {
    const child = spawn(chrome, [`--user-data-dir=${folder}`, '--no-first-run', '--no-default-browser-check', 'https://www.youtube.com/'],
      { detached: true, stdio: 'ignore', windowsHide: false });
    child.once('error', reject);
    child.once('spawn', () => { child.unref(); resolve(); });
  });
  const profiles = await listProfiles();
  const profile = profiles.find((item) => item.id === id);
  if (profile) { profile.connection = 'unverified'; delete profile.checkedAt; await saveProfiles(profiles); }
}

export async function verifyProfileLogin(id: string): Promise<ManagedProfile> {
  await getProfile(id);
  let context;
  try {
    context = await chromium.launchPersistentContext(profileDir(id), {
      channel: 'chrome', headless: false, locale: 'ko-KR', viewport: null,
    });
    const page = context.pages()[0] ?? await context.newPage();
    await page.goto('https://www.youtube.com/', { waitUntil: 'domcontentloaded', timeout: 30_000 });
    const signedIn = await page.locator('#avatar-btn img').first().waitFor({ state: 'visible', timeout: 15_000 })
      .then(() => true).catch(() => false);
    const profiles = await listProfiles();
    const profile = profiles.find((item) => item.id === id)!;
    profile.connection = signedIn ? 'connected' : 'disconnected';
    profile.checkedAt = new Date().toISOString();
    await saveProfiles(profiles);
    return profile;
  } catch (error) {
    throw new ProfileError(409, `로그인 상태를 확인하지 못했습니다. 해당 프로필의 크롬 창을 완전히 닫고 다시 시도하세요. ${error instanceof Error ? error.message : ''}`);
  } finally {
    await context?.close().catch(() => {});
  }
}
