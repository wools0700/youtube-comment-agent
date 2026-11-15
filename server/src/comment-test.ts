import { mkdir } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import { chromium, type BrowserContext, type Page } from 'playwright';
import { getTodayPostCount, getVideoPostStatus, recordPostEvent, videoIdFromUrl } from './videos.js';
import { listProfiles, profileDir } from './profiles.js';
import { commentIssues } from './drafts.js';
import { assignedProfileForPost, AssignmentError } from './assignments.js';

const dataDir = fileURLToPath(new URL('../../data/', import.meta.url));
const chooserDir = path.join(dataDir, 'chrome-profile-chooser');
const screenshotDir = path.join(dataDir, 'comment-test-errors');

type Phase = 'idle' | 'opening' | 'waiting_account' | 'typing' | 'posting' | 'posted' | 'needs_review' | 'failed';
type Status = { phase: Phase; message: string; videoId?: string; screenshot?: string };

export class CommentTestError extends Error {
  constructor(public status: number, message: string) { super(message); }
}

let page: Page | null = null;
const profileContexts = new Map<string, BrowserContext>();
let status: Status = { phase: 'idle', message: '영상 링크를 입력하고 댓글 달기를 누르세요.' };
let busy = false;

export function commentTestStatus(): Status { return status; }
export function isProfileInUse(id: string): boolean { return profileContexts.has(id); }
export function isCommentTestRunning(): boolean { return busy; }

function videoIdOrThrow(url: string): string {
  const videoId = videoIdFromUrl(url);
  if (!videoId) throw new CommentTestError(400, '올바른 YouTube 영상 링크를 입력하세요.');
  return videoId;
}

async function chooseProfile(videoId: string): Promise<string> {
  const profiles = await listProfiles();
  await mkdir(chooserDir, { recursive: true });
  const chooser = await chromium.launchPersistentContext(chooserDir, {
    channel: 'chrome', headless: false, locale: 'ko-KR', viewport: null, args: ['--start-maximized'],
  });
  const chooserPage = chooser.pages()[0] ?? await chooser.newPage();
  page = chooserPage;
  let resolveChoice!: (profile: string) => void;
  const choice = new Promise<string>((resolve) => { resolveChoice = resolve; });
  await chooserPage.exposeFunction('chooseYoutubeProfile', (value: string) => {
    if (profiles.some((profile) => profile.id === value)) resolveChoice(value);
  });
  await chooserPage.setContent(`<!doctype html><html lang="ko"><meta charset="utf-8"><title>유튜브 프로필 선택</title>
    <style>body{font:18px system-ui;margin:0;min-height:100vh;display:grid;place-items:center;background:#f5f7fa;color:#20242b}
    main{text-align:center;padding:24px}h1{font-size:28px}.profiles{display:flex;flex-wrap:wrap;justify-content:center;gap:16px;max-width:800px;margin:32px auto 0}
    button{width:180px;height:150px;border:1px solid #cbd2dc;border-radius:12px;background:white;font:700 21px system-ui;cursor:pointer}
    button:hover{border-color:#17599f;background:#edf5ff}p{font-size:14px;color:#667085}</style>
    <main><h1>유튜브 프로필 선택</h1><p>미리 로그인한 프로필을 선택하세요. 선택하면 바로 댓글 작업을 시작합니다.</p>
    <div class="profiles">${profiles.map((profile) => `<button onclick="chooseYoutubeProfile('${profile.id}')">${profile.name.replaceAll('&', '&amp;').replaceAll('<', '&lt;').replaceAll('>', '&gt;').replaceAll('"', '&quot;').replaceAll("'", '&#39;')}</button>`).join('')}</div></main></html>`);
  await chooserPage.bringToFront();
  status = { phase: 'waiting_account', message: '열린 크롬 창에서 사용할 프로필을 클릭하세요.', videoId };
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      choice,
      new Promise<string>((_, reject) => { timer = setTimeout(() => reject(new CommentTestError(408, '5분 안에 프로필이 선택되지 않았습니다.')), 300_000); }),
      new Promise<string>((_, reject) => chooserPage.on('close', () => reject(new CommentTestError(400, '프로필을 선택하기 전에 창을 닫았습니다.')))),
    ]);
  } finally {
    if (timer) clearTimeout(timer);
    await chooser.close().catch(() => {});
    if (page === chooserPage) page = null;
  }
}

async function openSelectedProfile(profileId: string): Promise<Page> {
  let context = profileContexts.get(profileId);
  if (!context) {
    context = await chromium.launchPersistentContext(profileDir(profileId), {
      channel: 'chrome', headless: false, locale: 'ko-KR', viewport: null, args: ['--start-maximized'],
    });
    profileContexts.set(profileId, context);
    context.on('close', () => { profileContexts.delete(profileId); });
  }
  const selectedPage = context.pages().find((item) => !item.isClosed()) ?? await context.newPage();
  page = selectedPage;
  await selectedPage.bringToFront();
  return selectedPage;
}

async function saveFailureScreenshot(): Promise<string | undefined> {
  if (!page || page.isClosed()) return undefined;
  try {
    await mkdir(screenshotDir, { recursive: true });
    const screenshot = path.join(screenshotDir, `${new Date().toISOString().replace(/[:.]/g, '-')}.png`);
    await page.screenshot({ path: screenshot, fullPage: false, timeout: 5_000 });
    return screenshot;
  } catch { return undefined; }
}

export async function startCommentTest(url: string, comment: string, confirmed: boolean, assignmentId?: unknown): Promise<Status> {
  if (busy) throw new CommentTestError(409, '댓글 작업이 진행 중입니다.');
  const videoId = videoIdOrThrow(url);
  const text = typeof comment === 'string' ? comment.trim() : '';
  if (!confirmed) throw new CommentTestError(400, '영상 내용과 댓글을 확인한 뒤 게시하세요.');
  const issues = commentIssues(text);
  if (issues.length) throw new CommentTestError(400, issues.join(' '));
  busy = true;
  try {
    if (await getVideoPostStatus(videoId) !== 'none') throw new CommentTestError(409, '이 영상은 이미 게시했거나 게시 여부 확인이 필요합니다. 중복 등록을 막기 위해 중단합니다.');
    const today = await getTodayPostCount();
    if (today.posted >= today.dailyMax) throw new CommentTestError(409, `오늘 댓글 ${today.dailyMax}개를 모두 게시했습니다.`);
    const assignedProfileId = assignmentId === undefined ? undefined
      : await assignedProfileForPost(assignmentId, videoId).catch((error: unknown) => {
        if (error instanceof AssignmentError) throw new CommentTestError(error.status, error.message);
        throw error;
      });
    status = { phase: 'opening', message: assignedProfileId ? '배정된 크롬 프로필을 여는 중입니다.' : '프로필 선택창을 여는 중입니다.', videoId };
    void runCommentTest(videoId, text, assignedProfileId).finally(() => { busy = false; });
    return status;
  } catch (error) { busy = false; throw error; }
}

async function runCommentTest(videoId: string, comment: string, assignedProfileId?: string): Promise<void> {
  let submitted = false;
  let profileId: string | undefined;
  try {
    profileId = assignedProfileId ?? await chooseProfile(videoId);
    const currentPage = await openSelectedProfile(profileId);
    const videoUrl = `https://www.youtube.com/watch?v=${videoId}&hl=ko`;
    status = { phase: 'opening', message: '선택한 크롬 프로필에서 영상을 여는 중입니다.', videoId };
    await currentPage.goto(videoUrl, { waitUntil: 'domcontentloaded', timeout: 30_000 });
    const comments = currentPage.locator('ytd-comments#comments');
    const placeholder = currentPage.locator('ytd-comment-simplebox-renderer #placeholder-area').first();
    if (currentPage.isClosed()) throw new CommentTestError(400, '선택한 크롬 창이 닫혔습니다.');
    await comments.scrollIntoViewIfNeeded({ timeout: 15_000 }).catch(() => {});
    try {
      await placeholder.waitFor({ state: 'visible', timeout: 20_000 });
    } catch {
      const signedIn = await currentPage.locator('#avatar-btn').first().isVisible().catch(() => false);
      throw new CommentTestError(signedIn ? 422 : 401, signedIn
        ? '댓글 입력창이 나타나지 않았습니다. 영상의 댓글 허용 여부를 확인하세요.'
        : '선택한 프로필에 YouTube 로그인이 필요합니다. 대시보드 우측 상단의 Google 계정 연동에서 로그인하세요.');
    }
    await placeholder.click({ timeout: 10_000 });

    const editor = currentPage.locator('ytd-comment-simplebox-renderer #contenteditable-root[contenteditable="true"]').first();
    await editor.waitFor({ state: 'visible', timeout: 10_000 });
    const existingMatches = await currentPage.locator('ytd-comment-thread-renderer #content-text')
      .evaluateAll((nodes, value) => nodes.filter((node) => node.textContent?.trim() === value).length, comment);
    status = { phase: 'typing', message: '댓글을 한 글자씩 입력 중입니다.', videoId };
    await editor.pressSequentially(comment, { delay: 120 });
    const typed = (await editor.innerText()).trim();
    if (typed !== comment) throw new CommentTestError(422, '입력된 댓글이 검토한 내용과 달라 게시를 중단했습니다. 크롬 창에서 입력 내용을 확인하세요.');

    const submit = currentPage.locator('ytd-comment-simplebox-renderer #submit-button button').first();
    status = { phase: 'posting', message: 'YouTube 게시 버튼을 누르고 댓글 표시를 확인 중입니다.', videoId };
    await recordPostEvent({ videoId, profileId, status: 'needs_review', comment });
    submitted = true;
    await submit.click({ timeout: 10_000 });
    await currentPage.waitForFunction(({ comment, previousCount }) =>
      [...document.querySelectorAll('ytd-comment-thread-renderer #content-text')]
        .filter((node) => node.textContent?.trim() === comment).length > previousCount,
      { comment, previousCount: existingMatches }, { timeout: 20_000 });
    await recordPostEvent({ videoId, profileId, status: 'posted', comment });
    status = { phase: 'posted', message: '게시한 댓글이 영상 화면에 표시되는 것을 확인했습니다.', videoId };
  } catch (error) {
    const screenshot = await saveFailureScreenshot();
    const message = error instanceof CommentTestError ? error.message : error instanceof Error ? error.message : String(error);
    if (profileId && !submitted) await recordPostEvent({ videoId, profileId, status: 'failed', comment, error: message }).catch(() => {});
    status = { phase: submitted ? 'needs_review' : 'failed',
      message: submitted ? `게시 시도 후 새 댓글을 화면에서 확인하지 못했습니다. 다시 게시하지 말고 크롬 창을 확인하세요. ${message}` : message,
      videoId, screenshot };
  }
}
