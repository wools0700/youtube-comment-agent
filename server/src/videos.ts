import { appendFile, mkdir, readFile, rename, writeFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

const rootDir = fileURLToPath(new URL('../../', import.meta.url));
const dataDir = path.join(rootDir, 'data');
const viewHistoryPath = path.join(dataDir, 'view-history.json');
const postHistoryPath = path.join(dataDir, 'history.jsonl');
const searchTerms = ['연애상담', '연애 고민', '연애 심리', '연애 조언', '짝사랑 고민', '썸남 심리', '썸녀 심리', '이별 상담', '재회 상담', '남자 심리', '여자 심리'];
const hashtagTerms = ['#연애', '#연애상담', '#고민상담', '#짝사랑', '#썸녀', '#썸남'];
const relationshipTerms = ['연애상담', '짝사랑', '썸남', '썸녀', '이별', '재회', '연애', '남친', '여친', '데이트', '커플', '결혼', '헤어진', '바람', '남자심리', '여자심리'];
const hour = 60 * 60 * 1000;
const trendCheckInterval = 30 * 60 * 1000;
const maxVideoDurationSeconds = 48 * 60;

export type PostStatus = 'none' | 'posted' | 'needs_review';
export type VideoFormat = 'shorts' | 'video' | 'unknown';

export interface VideoCandidate {
  videoId: string;
  url: string;
  title: string;
  channelTitle: string;
  publishedAt: string;
  thumbnailUrl: string;
  durationSeconds: number;
  format: VideoFormat;
  keywords: string[];
  viewCount: number | null;
  likeCount: number | null;
  commentCount: number | null;
  viewsPerHour: number | null;
  isRising: boolean;
  postStatus: PostStatus;
  recommendationScore: number;
  embeddable: boolean;
}

interface SearchResponse {
  items?: Array<{ id?: { videoId?: string } }>;
  nextPageToken?: string;
}

interface VideoDetails {
  id: string;
  snippet?: {
    title?: string;
    description?: string;
    channelTitle?: string;
    channelId?: string;
    categoryId?: string;
    publishedAt?: string;
    liveBroadcastContent?: string;
    thumbnails?: Record<string, { url?: string }>;
  };
  contentDetails?: { duration?: string };
  player?: { embedWidth?: string; embedHeight?: string };
  statistics?: { viewCount?: string; likeCount?: string; commentCount?: string };
  liveStreamingDetails?: object;
  status?: { embeddable?: boolean };
}

interface DetailsResponse {
  items?: VideoDetails[];
}

interface ChannelDetails {
  id: string;
  snippet?: { title?: string; description?: string };
  topicDetails?: { topicCategories?: string[] };
  brandingSettings?: { channel?: { keywords?: string } };
}

interface ChannelsResponse {
  items?: ChannelDetails[];
}
interface Snapshot {
  sampledAt: string;
  viewCount: number;
}

type ViewHistory = Record<string, Snapshot[]>;

export class VideoLoadError extends Error {
  constructor(public status: number, message: string) {
    super(message);
  }
}

async function youtubeGet<T>(endpoint: string, params: Record<string, string>, apiKey: string): Promise<T> {
  const query = new URLSearchParams({ ...params, key: apiKey });
  let response: Response;
  try {
    response = await fetch(`https://www.googleapis.com/youtube/v3/${endpoint}?${query}`, {
      signal: AbortSignal.timeout(15_000),
    });
  } catch {
    throw new VideoLoadError(502, 'YouTube에 연결하지 못했습니다. 네트워크 연결을 확인하세요.');
  }

  if (!response.ok) {
    const message = response.status === 403
      ? 'YouTube API 요청이 거부됐습니다. API 키, API 활성화 상태와 할당량을 확인하세요.'
      : `YouTube API 요청에 실패했습니다. (HTTP ${response.status})`;
    throw new VideoLoadError(502, message);
  }
  return response.json() as Promise<T>;
}

async function readJsonFile<T>(filePath: string, fallback: T): Promise<T> {
  try {
    return JSON.parse(await readFile(filePath, 'utf8')) as T;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return fallback;
    throw error;
  }
}

async function readPostStatuses(): Promise<Map<string, PostStatus>> {
  const statuses = new Map<string, PostStatus>();
  let content: string;
  try {
    content = await readFile(postHistoryPath, 'utf8');
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return statuses;
    throw error;
  }

  for (const line of content.split(/\r?\n/)) {
    if (!line.trim()) continue;
    const event = JSON.parse(line) as { videoId?: string; status?: string };
    if (!event.videoId) continue;
    if (event.status === 'posted') statuses.set(event.videoId, 'posted');
    if (event.status === 'needs_review') statuses.set(event.videoId, 'needs_review');
    if (event.status === 'failed' && statuses.get(event.videoId) !== 'posted') statuses.delete(event.videoId);
  }
  return statuses;
}

export async function getVideoPostStatus(videoId: string): Promise<PostStatus> {
  return (await readPostStatuses()).get(videoId) ?? 'none';
}

export async function recordPostEvent(event: {
  videoId: string; profileId: string; status: 'posted' | 'needs_review' | 'failed';
  comment: string; error?: string;
}): Promise<void> {
  await mkdir(dataDir, { recursive: true });
  const timestamp = new Date().toISOString();
  await appendFile(postHistoryPath, `${JSON.stringify({ ...event, timestamp })}\n`, 'utf8');
}

export async function getTodayPostCount(): Promise<{ date: string; posted: number; dailyMax: number }> {
  const date = new Intl.DateTimeFormat('sv-SE', {
    timeZone: 'Asia/Seoul', year: 'numeric', month: '2-digit', day: '2-digit',
  }).format(new Date());
  let content: string;
  try {
    content = await readFile(postHistoryPath, 'utf8');
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return { date, posted: 0, dailyMax: 10 };
    throw error;
  }
  const postedIds = new Set<string>();
  for (const line of content.split(/\r?\n/)) {
    if (!line.trim()) continue;
    const event = JSON.parse(line) as { videoId?: string; status?: string; postedAt?: string; timestamp?: string; attemptedAt?: string };
    const eventDate = event.postedAt ?? event.timestamp ?? event.attemptedAt;
    if (event.status === 'posted' && event.videoId && eventDate && !Number.isNaN(Date.parse(eventDate))
      && new Intl.DateTimeFormat('sv-SE', { timeZone: 'Asia/Seoul', year: 'numeric', month: '2-digit', day: '2-digit' }).format(new Date(eventDate)) === date) {
      postedIds.add(event.videoId);
    }
  }
  return { date, posted: postedIds.size, dailyMax: 10 };
}

export function videoIdFromUrl(value: string): string | null {
  let url: URL;
  try {
    url = new URL(value.trim());
  } catch {
    return null;
  }
  if (url.protocol !== 'https:' && url.protocol !== 'http:') return null;
  const host = url.hostname.toLowerCase();
  const pathParts = url.pathname.split('/').filter(Boolean);
  let id: string | null = null;
  if (host === 'youtu.be' || host === 'www.youtu.be') id = pathParts.length === 1 ? pathParts[0] : null;
  if (['youtube.com', 'www.youtube.com', 'm.youtube.com'].includes(host)) {
    if (url.pathname === '/watch') id = url.searchParams.get('v');
    else if (['shorts', 'live', 'embed'].includes(pathParts[0]) && pathParts.length === 2) id = pathParts[1];
  }
  return id && /^[A-Za-z0-9_-]{11}$/.test(id) ? id : null;
}

export async function getVideoForDraft(apiKey: string, videoId: string): Promise<{ video: VideoCandidate; description: string }> {
  if (!apiKey) throw new VideoLoadError(503, 'YOUTUBE_API_KEY가 설정되지 않았습니다.');
  if (!/^[A-Za-z0-9_-]{11}$/.test(videoId)) throw new VideoLoadError(400, '올바른 YouTube 영상 ID가 아닙니다.');
  const result = await youtubeGet<DetailsResponse>('videos', {
    part: 'snippet,contentDetails,statistics,liveStreamingDetails,player,status', id: videoId,
    maxWidth: '400', maxHeight: '400',
  }, apiKey);
  const detail = result.items?.[0];
  const snippet = detail?.snippet;
  const duration = durationSeconds(detail?.contentDetails?.duration);
  if (!detail || !snippet?.title || !snippet.publishedAt || duration === null) {
    throw new VideoLoadError(404, '영상을 찾을 수 없거나 공개 영상이 아닙니다.');
  }
  if (detail.liveStreamingDetails || (snippet.liveBroadcastContent && snippet.liveBroadcastContent !== 'none')) {
    throw new VideoLoadError(400, '라이브 영상과 다시보기는 선택할 수 없습니다.');
  }
  if (duration > maxVideoDurationSeconds) {
    throw new VideoLoadError(400, '무료 영상 분석을 위해 48분 이하 영상만 선택할 수 있습니다.');
  }
  const statuses = await readPostStatuses();
  return {
    video: {
      videoId: detail.id,
      url: `https://www.youtube.com/watch?v=${detail.id}`,
      title: snippet.title,
      channelTitle: snippet.channelTitle ?? '채널 정보 없음',
      publishedAt: snippet.publishedAt,
      thumbnailUrl: snippet.thumbnails?.medium?.url ?? snippet.thumbnails?.default?.url ?? '',
      durationSeconds: duration,
      format: videoFormat(detail, duration),
      keywords: matchingKeywords(snippet.title, snippet.description ?? ''),
      viewCount: count(detail.statistics?.viewCount),
      likeCount: count(detail.statistics?.likeCount),
      commentCount: count(detail.statistics?.commentCount),
      viewsPerHour: null,
      isRising: false,
      postStatus: statuses.get(detail.id) ?? 'none',
      recommendationScore: 0,
      embeddable: detail.status?.embeddable !== false,
    },
    description: snippet.description ?? '',
  };
}

function durationSeconds(value?: string): number | null {
  if (!value) return null;
  const match = /^P(?:(\d+)D)?T(?:(\d+)H)?(?:(\d+)M)?(?:(\d+)S)?$/.exec(value);
  if (!match) return null;
  return Number(match[1] ?? 0) * 86_400 + Number(match[2] ?? 0) * 3_600
    + Number(match[3] ?? 0) * 60 + Number(match[4] ?? 0);
}

function videoFormat(detail: VideoDetails, duration: number): VideoFormat {
  if (duration > 180) return 'video';
  const width = Number(detail.player?.embedWidth);
  const height = Number(detail.player?.embedHeight);
  if (width > 0 && height > 0) {
    if (width > height) return 'video';
    if (duration <= 60 || Date.parse(detail.snippet?.publishedAt ?? '') >= Date.parse('2024-10-15')) {
      return 'shorts';
    }
    return 'unknown';
  }
  return /#shorts|#쇼츠/i.test(detail.snippet?.title ?? '') ? 'shorts' : 'unknown';
}
function count(value?: string): number | null {
  if (value === undefined) return null;
  const parsed = Number(value);
  return Number.isSafeInteger(parsed) && parsed >= 0 ? parsed : null;
}

function matchingKeywords(title: string, description: string): string[] {
  const hashtags = [...`${title}\n${description}`.matchAll(/#[^\s#.,!?]+/gu)]
    .map((match) => match[0].slice(1));
  const searchable = `${title}\n${hashtags.join(' ')}`;
  const headline = title.replace(/#[^\s#]+/gu, '').trim();
  const matches = relationshipTerms.filter((term) => term !== '연애' && searchable.includes(term));
  if (searchable.includes('연애') && /상담|고민|심리|조언|질문|방법|대처|연락|연애법|연애하는법/.test(headline)) {
    matches.push('연애');
  }
  const romanceContext = /연애|짝사랑|썸남|썸녀|이별|재회|남친|여친|남자친구|여자친구|연인|커플|데이트|소개팅|헤어진|애인|고백/;
  const descriptionIntro = description.replace(/#[^\s#]+/gu, '').slice(0, 500);
  if (hashtags.includes('고민상담') && romanceContext.test(`${headline}\n${descriptionIntro}`)) {
    matches.push('고민상담');
  }
  return matches;
}

function isExcludedChannel(channel?: ChannelDetails): boolean {
  if (!channel) return false;
  const topics = channel.topicDetails?.topicCategories ?? [];
  if (topics.some((topic) => /\/wiki\/(?:Music|Music_of_Asia|Pop_music|K-pop|Korean_pop)$/i.test(topic))) return true;
  const description = channel.snippet?.description ?? '';
  const keywords = channel.brandingSettings?.channel?.keywords ?? '';
  return /음악 전문 채널|음악 채널|official music channel|music label|뮤직 채널/i.test(description)
    || /(?:^|\s)(?:KPOP|K-POP|뮤직뱅크|musicbank)(?:\s|$)/i.test(keywords);
}

function isExcludedContent(snippet: NonNullable<VideoDetails['snippet']>, channel?: ChannelDetails): boolean {
  if (snippet.categoryId === '1' || snippet.categoryId === '10') return true;

  const title = snippet.title ?? '';
  const headline = title.replace(/#[^\s#]+/gu, '').trim();
  const channelName = snippet.channelTitle ?? '';
  const hashtags = [...`${title}\n${snippet.description ?? ''}`.matchAll(/#[^\s#.,!?]+/gu)]
    .map((match) => match[0]);
  const visibleText = `${title} ${hashtags.join(' ')}`;

  const fortune = /타로|사주|신점|점사|점괘|운세|점성술|오라클|무속|궁합/i;
  const media = /드라마|숏드라마|웹드라마|영화|명장면|명대사|예고편|티저|몰아보기|재회씬|#연애전쟁|#내새끼의연애|환승연애|연프|뮤직비디오|뮤비|플레이리스트|가사|lyrics|\bmv\b|\bost\b|official music video|불후의 명곡|싱어게인|노래|발라드|커버곡|콘서트|concert|\bkpop\b|\bmusic\b|\bsong\b|\bstage\b|short.?drama|short.?film|곡에 대한|살해|범죄|범인|사건|액괴|슬라임|standupcomedy|코미디|comedy|댓글모음/i;
  const excludedChannel = /드라마|movie|music|kpop|k-pop|뮤직|타로|사주|점술|신점|숏폼드라마|웹드|대본/i;
  const adviceIntent = /상담|고민|사연|심리|조언|질문|방법|이유|어떻게|왜|해야|할까|할까요|연락|붙잡|관계|마음|비법|대처|기준|신호|회피형|좋아하|연애법|연애하는법/i;
  return fortune.test(visibleText) || media.test(visibleText)
    || excludedChannel.test(channelName) || isExcludedChannel(channel)
    || !adviceIntent.test(headline);
}
function relevanceScore(title: string, description: string, keywords: string[]): number {
  const titleMatches = keywords.filter((term) => title.includes(term)).length;
  const hashtagMatches = keywords.filter((term) => `${title}\n${description}`.includes(`#${term}`)).length;
  const adviceCues = ['상담', '고민', '사연', '심리', '조언', '질문'];
  const adviceMatches = adviceCues.filter((term) => title.includes(term)).length;
  return Math.min(titleMatches, 3) * 4 + Math.min(hashtagMatches, 2) * 2
    + keywords.length + Math.min(adviceMatches, 2) * 20;
}

function trendFor(history: Snapshot[], now: number, viewCount: number | null) {
  if (viewCount === null) return { viewsPerHour: null, isRising: false };
  const baseline = [...history].reverse().find((sample) => {
    const age = now - Date.parse(sample.sampledAt);
    return age >= hour && age <= hour * 1.5;
  });
  if (!baseline) return { viewsPerHour: null, isRising: false };
  const elapsedHours = (now - Date.parse(baseline.sampledAt)) / hour;
  const viewsPerHour = Math.round((viewCount - baseline.viewCount) / elapsedHours);
  return {
    viewsPerHour,
    isRising: viewCount >= 1000 && viewCount <= 5000 && viewsPerHour >= 150,
  };
}

async function saveViewHistory(history: ViewHistory, videos: VideoCandidate[], now: number): Promise<void> {
  for (const video of videos) {
    if (video.viewCount === null) continue;
    const existing = history[video.videoId] ?? [];
    history[video.videoId] = [
      ...existing.filter((sample) => now - Date.parse(sample.sampledAt) <= 48 * hour),
      { sampledAt: new Date(now).toISOString(), viewCount: video.viewCount },
    ].slice(-24);
  }
  await mkdir(dataDir, { recursive: true });
  const temporaryPath = `${viewHistoryPath}.${process.pid}.tmp`;
  await writeFile(temporaryPath, JSON.stringify(history), 'utf8');
  await rename(temporaryPath, viewHistoryPath);
}

type SearchSource = 'date' | 'relevance' | 'viewCount' | 'hashtags';
type SearchCursor = { pageToken?: string; exhausted: boolean };
export type VideoBatch = { videos: VideoCandidate[]; hasMore: boolean };
const searchSources: SearchSource[] = ['date', 'relevance', 'viewCount', 'hashtags'];

let cursors: Record<SearchSource, SearchCursor> | null = null;
let seenVideoIds = new Set<string>();
let cached: { loadedAt: number; measuredAt: number; batch: VideoBatch } | null = null;
let activeLoad: Promise<VideoBatch> | null = null;
let trendCheck: Promise<void> | null = null;
let trendTimer: NodeJS.Timeout | null = null;
let lastTrendAttemptAt = 0;
let searchRound = 0;

export function currentTrendSnapshot(): { measuredAt: number | null; videos: VideoCandidate[] } {
  return { measuredAt: cached?.measuredAt ?? null, videos: cached?.batch.videos ?? [] };
}

function startTrendMonitoring(apiKey: string): void {
  if (trendTimer) return;
  trendTimer = setInterval(() => {
    if (!cached || activeLoad || trendCheck || Date.now() - lastTrendAttemptAt < trendCheckInterval) return;
    lastTrendAttemptAt = Date.now();
    trendCheck = measureCandidateViews(apiKey)
      .catch((error: unknown) => {
        console.warn('후보 영상 조회수 갱신 실패:', error instanceof Error ? error.message : String(error));
      })
      .finally(() => { trendCheck = null; });
  }, 60_000);
  trendTimer.unref();
}

async function measureCandidateViews(apiKey: string): Promise<void> {
  const previous = cached;
  if (!previous?.batch.videos.length) return;
  const videos = previous.batch.videos;
  const ids = [...new Set(videos.map((video) => video.videoId))];
  const pages = await Promise.all(Array.from({ length: Math.ceil(ids.length / 50) }, (_, index) =>
    youtubeGet<DetailsResponse>('videos', {
      part: 'statistics', id: ids.slice(index * 50, (index + 1) * 50).join(','),
    }, apiKey),
  ));
  const counts = new Map(pages.flatMap((page) => page.items ?? [])
    .map((video) => [video.id, count(video.statistics?.viewCount)]));
  const history = await readJsonFile<ViewHistory>(viewHistoryPath, {});
  const now = Date.now();
  const updated = videos.map((video) => {
    const viewCount = counts.get(video.videoId);
    if (viewCount === null || viewCount === undefined) return video;
    const trend = trendFor(history[video.videoId] ?? [], now, viewCount);
    return {
      ...video, viewCount, ...trend,
      recommendationScore: video.recommendationScore - (video.isRising ? 30 : 0) + (trend.isRising ? 30 : 0),
    };
  });
  await saveViewHistory(history, updated.filter((video) => counts.get(video.videoId) !== null && counts.get(video.videoId) !== undefined), now);
  if (cached === previous) {
    cached = { ...previous, measuredAt: now, batch: { ...previous.batch, videos: updated } };
  }
}

export function loadVideos(apiKey: string, next = false, reset = false): Promise<VideoBatch> {
  if (!apiKey) throw new VideoLoadError(503, 'YOUTUBE_API_KEY가 설정되지 않았습니다.');
  if (trendCheck) return trendCheck.then(() => loadVideos(apiKey, next, reset));
  if (!next && !reset && cached && Date.now() - cached.loadedAt < 300_000) return Promise.resolve(cached.batch);
  if (next && cursors && searchSources.every((source) => cursors?.[source].exhausted)) {
    return Promise.resolve({ videos: [], hasMore: false });
  }
  if (activeLoad) return activeLoad;
  activeLoad = fetchVideos(apiKey, next, reset).finally(() => { activeLoad = null; });
  return activeLoad;
}

async function fetchVideos(apiKey: string, next: boolean, refresh: boolean): Promise<VideoBatch> {
  const continuing = (next || refresh) && cursors !== null
    && searchSources.some((source) => !cursors?.[source].exhausted);
  if (refresh && !continuing) searchRound++;
  const previous = refresh ? [...(cached?.batch.videos ?? [])]
    .sort((a, b) => b.recommendationScore - a.recommendationScore)
    .slice(0, Math.ceil((cached?.batch.videos.length ?? 0) * .3)) : [];
  const nextCursors: Record<SearchSource, SearchCursor> = continuing && cursors
    ? structuredClone(cursors)
    : { date: { exhausted: false }, relevance: { exhausted: false }, viewCount: { exhausted: false }, hashtags: { exhausted: false } };

  const searches = (await Promise.all(searchSources.map(async (source) => {
    const pages: SearchResponse[] = [];
    const cursor = nextCursors[source];
    for (let page = 0; page < (source === 'hashtags' ? 1 : 2) && !cursor.exhausted; page++) {
      const result = await youtubeGet<SearchResponse>('search', {
        part: 'snippet', q: (source === 'hashtags' ? hashtagTerms : searchTerms)
          .filter((_, index, terms) => searchRound === 0 || (index + searchRound * 3) % terms.length < Math.min(terms.length, source === 'hashtags' ? 4 : 7))
          .join('|'),
        type: 'video', order: source === 'hashtags' ? 'relevance' : source,
        maxResults: '50', regionCode: 'KR', relevanceLanguage: 'ko',
        ...(cursor.pageToken ? { pageToken: cursor.pageToken } : {}),
      }, apiKey);
      pages.push(result);
      cursor.pageToken = result.nextPageToken;
      cursor.exhausted = !result.nextPageToken;
    }
    return pages;
  }))).flat();
  const ids = [...new Set(searches.flatMap((search) => search.items ?? [])
    .map((item) => item.id?.videoId).filter((id): id is string => Boolean(id)))]
    .filter((id) => !continuing || !seenVideoIds.has(id));

  const detailPages = await Promise.all(Array.from({ length: Math.ceil(ids.length / 50) }, (_, index) =>
    youtubeGet<DetailsResponse>('videos', {
      part: 'snippet,contentDetails,statistics,liveStreamingDetails,player,status',
      maxWidth: '400', maxHeight: '400',
      id: ids.slice(index * 50, (index + 1) * 50).join(','),
    }, apiKey),
  ));
  const details = detailPages.flatMap((page) => page.items ?? []);
  const channelIds = [...new Set(details.map((detail) => detail.snippet?.channelId).filter((id): id is string => Boolean(id)))];
  const channelPages = await Promise.all(Array.from({ length: Math.ceil(channelIds.length / 50) }, (_, index) =>
    youtubeGet<ChannelsResponse>('channels', {
      part: 'snippet,topicDetails,brandingSettings',
      id: channelIds.slice(index * 50, (index + 1) * 50).join(','),
    }, apiKey),
  ));
  const channels = new Map(channelPages.flatMap((page) => page.items ?? []).map((channel) => [channel.id, channel]));
  const now = Date.now();
  const [viewHistory, postStatuses] = await Promise.all([
    readJsonFile<ViewHistory>(viewHistoryPath, {}), readPostStatuses(),
  ]);
  const videos: VideoCandidate[] = [];

  for (const detail of details) {
    const snippet = detail.snippet;
    if (!snippet?.title || !snippet.publishedAt) continue;
    if (isExcludedContent(snippet, channels.get(snippet.channelId ?? ''))) continue;
    if (detail.liveStreamingDetails || (snippet.liveBroadcastContent && snippet.liveBroadcastContent !== 'none')) continue;
    const duration = durationSeconds(detail.contentDetails?.duration);
    if (duration === null || duration > maxVideoDurationSeconds) continue;
    const keywords = matchingKeywords(snippet.title, snippet.description ?? '');
    if (keywords.length === 0) continue;

    const viewCount = count(detail.statistics?.viewCount);
    const likeCount = count(detail.statistics?.likeCount);
    const commentCount = count(detail.statistics?.commentCount);
    const trend = trendFor(viewHistory[detail.id] ?? [], now, viewCount);
    const relevance = relevanceScore(snippet.title, snippet.description ?? '', keywords);
    const recommendationScore = relevance * 10
      + (likeCount === null ? 0 : Math.log1p(likeCount) * 5)
      + (commentCount === null ? 0 : Math.log1p(commentCount) * 4)
      + (trend.isRising ? 30 : 0);

    videos.push({
      videoId: detail.id,
      url: `https://www.youtube.com/watch?v=${detail.id}`,
      title: snippet.title,
      channelTitle: snippet.channelTitle ?? '채널 정보 없음',
      publishedAt: snippet.publishedAt,
      thumbnailUrl: snippet.thumbnails?.medium?.url ?? snippet.thumbnails?.default?.url ?? '',
      durationSeconds: duration,
      format: videoFormat(detail, duration),
      keywords,
      viewCount,
      likeCount,
      commentCount,
      ...trend,
      postStatus: postStatuses.get(detail.id) ?? 'none',
      recommendationScore,
      embeddable: detail.status?.embeddable !== false,
    });
  }

  await saveViewHistory(viewHistory, videos, now);
  cursors = nextCursors;
  seenVideoIds = continuing ? new Set([...seenVideoIds, ...ids]) : new Set(ids);
  const blended = refresh
    ? [...previous.map((video) => ({ ...video, postStatus: postStatuses.get(video.videoId) ?? 'none' as PostStatus })),
      ...videos.filter((video) => !previous.some((item) => item.videoId === video.videoId))
        .sort((a, b) => b.recommendationScore - a.recommendationScore)]
      .slice(0, Math.max(cached?.batch.videos.length ?? 0, 90))
    : videos;
  const batch = { videos: blended, hasMore: searchSources.some((source) => !nextCursors[source].exhausted) };
  cached = { loadedAt: now, measuredAt: now, batch };
  lastTrendAttemptAt = now;
  startTrendMonitoring(apiKey);
  return batch;
}
