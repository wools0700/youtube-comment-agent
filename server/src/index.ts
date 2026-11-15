import express from 'express';
import { config } from 'dotenv';
import { fileURLToPath } from 'node:url';
import { randomUUID } from 'node:crypto';
import { loadVideos, currentTrendSnapshot, getTodayPostCount, getVideoForDraft, videoIdFromUrl, VideoLoadError } from './videos.js';
import { createDraft, DraftError } from './drafts.js';
import { commentTestStatus, startCommentTest, CommentTestError, isProfileInUse, isCommentTestRunning } from './comment-test.js';
import { listProfiles, addProfile, renameProfile, deleteProfile, openProfileLogin, verifyProfileLogin, ProfileError } from './profiles.js';
import { assignProfileToVideo, AssignmentError } from './assignments.js';

config({ path: fileURLToPath(new URL('../../.env', import.meta.url)), quiet: true });

const app = express();
const port = Number(process.env.PORT ?? 3001);
type DraftJob = { status: 'running' } | { status: 'completed'; result: Awaited<ReturnType<typeof createDraft>> } | { status: 'failed'; error: string };
const draftJobs = new Map<string, DraftJob>();
app.use(express.json({ limit: '32kb' }));
app.use('/api', (request, response, next) => {
  const loopback = new Set(['localhost', '127.0.0.1', '[::1]']);
  let host: string;
  try { host = new URL(`http://${request.headers.host ?? ''}`).hostname.toLowerCase(); }
  catch { response.status(403).json({ error: '로컬 주소에서만 접근할 수 있습니다.' }); return; }
  if (!loopback.has(host)) { response.status(403).json({ error: '로컬 주소에서만 접근할 수 있습니다.' }); return; }
  if (request.headers.origin) {
    try {
      if (!loopback.has(new URL(request.headers.origin).hostname.toLowerCase())) throw new Error('external origin');
    } catch { response.status(403).json({ error: '다른 사이트의 요청은 허용하지 않습니다.' }); return; }
  }
  if (request.headers['sec-fetch-site'] === 'cross-site') {
    response.status(403).json({ error: '다른 사이트의 요청은 허용하지 않습니다.' }); return;
  }
  if (!['GET', 'HEAD', 'OPTIONS'].includes(request.method) && request.headers['x-marketing-agent-request'] !== '1') {
    response.status(403).json({ error: '대시보드에서 다시 시도하세요.' }); return;
  }
  next();
});

app.get('/health', (_request, response) => {
  response.json({ status: 'ok' });
});

app.get('/api/videos', async (_request, response) => {
  try {
    const batch = await loadVideos(process.env.YOUTUBE_API_KEY ?? '', _request.query.next === '1', _request.query.reset === '1');
    response.json({ ...batch, loadedAt: new Date().toISOString(), measuredAt: currentTrendSnapshot().measuredAt });
  } catch (error) {
    const status = error instanceof VideoLoadError ? error.status : 500;
    const message = error instanceof VideoLoadError ? error.message : '영상을 불러오는 중 오류가 발생했습니다.';
    response.status(status).json({ error: message });
  }
});

app.get('/api/videos/trends', (_request, response) => {
  response.json(currentTrendSnapshot());
});

app.post('/api/assignments', async (_request, response) => {
  if (isCommentTestRunning()) { response.status(409).json({ error: '댓글 작업이 끝난 뒤 다음 영상을 배정하세요.' }); return; }
  try { response.json(await assignProfileToVideo(_request.body?.videoId)); }
  catch (error) { response.status(error instanceof AssignmentError ? error.status : 500).json({ error: error instanceof AssignmentError ? error.message : '게시 계정을 자동배정하지 못했습니다.' }); }
});

app.get('/api/today', async (_request, response) => {
  try { response.json(await getTodayPostCount()); }
  catch { response.status(500).json({ error: '오늘 게시 기록을 읽지 못했습니다.' }); }
});

app.post('/api/videos/resolve', async (request, response) => {
  const videoId = typeof request.body?.url === 'string' ? videoIdFromUrl(request.body.url) : null;
  if (!videoId) { response.status(400).json({ error: '올바른 YouTube 영상 링크를 입력하세요.' }); return; }
  try {
    const { video } = await getVideoForDraft(process.env.YOUTUBE_API_KEY ?? '', videoId);
    response.json({ video });
  } catch (error) {
    response.status(error instanceof VideoLoadError ? error.status : 500).json({
      error: error instanceof VideoLoadError ? error.message : '영상 링크를 확인하지 못했습니다.',
    });
  }
});

app.post('/api/drafts', async (request, response) => {
  const videoId = request.body?.videoId;
  if (typeof videoId !== 'string' || !/^[A-Za-z0-9_-]{11}$/.test(videoId)) {
    response.status(400).json({ error: '영상을 먼저 선택하세요.' }); return;
  }
  const jobId = randomUUID();
  draftJobs.set(jobId, { status: 'running' });
  response.status(202).json({ jobId });
  void createDraft({
      videoId,
      regenerate: request.body?.regenerate === true,
      youtubeKey: process.env.YOUTUBE_API_KEY ?? '',
      geminiKey: process.env.GEMINI_API_KEY ?? '',
    }).then((result) => { draftJobs.set(jobId, { status: 'completed', result }); }).catch((error: unknown) => {
    const message = error instanceof DraftError || error instanceof VideoLoadError ? error.message : '댓글 초안을 작성하지 못했습니다.';
    draftJobs.set(jobId, { status: 'failed', error: message });
  });
});

app.get('/api/drafts/jobs/:jobId', (request, response) => {
  const job = draftJobs.get(request.params.jobId);
  if (!job) { response.status(404).json({ error: '초안 작업을 찾지 못했습니다. 서버가 재시작됐다면 다시 작성하세요.' }); return; }
  response.json(job);
});

app.get('/api/comment-test/status', (_request, response) => {
  response.json(commentTestStatus());
});

app.get('/api/profiles', async (_request, response) => {
  try { response.json({ profiles: await listProfiles() }); }
  catch { response.status(500).json({ error: '프로필 목록을 읽지 못했습니다.' }); }
});

app.post('/api/profiles', async (request, response) => {
  try { response.status(201).json(await addProfile(request.body?.name)); }
  catch (error) { response.status(error instanceof ProfileError ? error.status : 500).json({ error: error instanceof ProfileError ? error.message : '프로필을 추가하지 못했습니다.' }); }
});

app.patch('/api/profiles/:id', async (request, response) => {
  try { response.json(await renameProfile(request.params.id, request.body?.name)); }
  catch (error) { response.status(error instanceof ProfileError ? error.status : 500).json({ error: error instanceof ProfileError ? error.message : '프로필을 수정하지 못했습니다.' }); }
});

app.delete('/api/profiles/:id', async (request, response) => {
  if (isCommentTestRunning() || isProfileInUse(request.params.id)) {
    response.status(409).json({ error: '댓글 작업이나 전용 Chrome 창이 열려 있습니다. 작업을 마치고 창을 닫은 뒤 삭제하세요.' });
    return;
  }
  try { await deleteProfile(request.params.id); response.json({ deletedId: request.params.id }); }
  catch (error) { response.status(error instanceof ProfileError ? error.status : 500).json({ error: error instanceof ProfileError ? error.message : '프로필을 삭제하지 못했습니다.' }); }
});

app.post('/api/profiles/:id/login', async (request, response) => {
  if (isProfileInUse(request.params.id)) { response.status(409).json({ error: '이 프로필의 댓글 창이 열려 있습니다. 창을 닫은 뒤 연동하세요.' }); return; }
  if (request.body?.reset === true && isCommentTestRunning()) { response.status(409).json({ error: '댓글 작업이 끝난 뒤 계정을 변경하세요.' }); return; }
  try { await openProfileLogin(request.params.id, request.body?.reset === true); response.json({ message: 'Chrome에서 YouTube에 로그인한 뒤 창을 완전히 닫고 상태 확인을 누르세요.' }); }
  catch (error) { response.status(error instanceof ProfileError ? error.status : 500).json({ error: error instanceof ProfileError ? error.message : '로그인 창을 열지 못했습니다.' }); }
});

app.post('/api/profiles/:id/verify', async (request, response) => {
  if (isProfileInUse(request.params.id)) { response.status(409).json({ error: '이 프로필의 댓글 창이 열려 있습니다. 창을 닫은 뒤 확인하세요.' }); return; }
  try { response.json(await verifyProfileLogin(request.params.id)); }
  catch (error) { response.status(error instanceof ProfileError ? error.status : 500).json({ error: error instanceof ProfileError ? error.message : '로그인 상태를 확인하지 못했습니다.' }); }
});

app.post('/api/comment-test/post', async (request, response) => {
  try { response.status(202).json(await startCommentTest(request.body?.url, request.body?.comment, request.body?.confirmed === true, request.body?.assignmentId)); }
  catch (error) { response.status(error instanceof CommentTestError ? error.status : 500).json({
    error: error instanceof CommentTestError ? error.message : '댓글 작업을 시작하지 못했습니다.',
  }); }
});

app.listen(port, '127.0.0.1', () => {
  console.log(`Server ready at http://127.0.0.1:${port}`);
});
