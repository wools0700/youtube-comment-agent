import { randomUUID } from 'node:crypto';
import { mkdir, readFile, rename, writeFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import { getTodayPostCount, getVideoPostStatus } from './videos.js';
import { listProfiles } from './profiles.js';

const dataDir = fileURLToPath(new URL('../../data/', import.meta.url));
const assignmentPath = path.join(dataDir, 'assignment.json');
const historyPath = path.join(dataDir, 'history.jsonl');

type Assignment = {
  id: string;
  videoId: string;
  profileId: string;
  profileName: string;
  assignedAt: string;
};

export class AssignmentError extends Error {
  constructor(public status: number, message: string) { super(message); }
}

async function currentAssignment(): Promise<Assignment | null> {
  try { return JSON.parse(await readFile(assignmentPath, 'utf8')) as Assignment; }
  catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return null;
    throw error;
  }
}

async function lastPostedProfileId(): Promise<string | null> {
  let content: string;
  try { content = await readFile(historyPath, 'utf8'); }
  catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return null;
    throw error;
  }
  for (const line of content.trim().split(/\r?\n/).reverse()) {
    if (!line) continue;
    const event = JSON.parse(line) as { status?: string; profileId?: string };
    if (event.status === 'posted' && event.profileId) return event.profileId;
  }
  return null;
}

export async function assignProfileToVideo(videoId: unknown): Promise<Assignment> {
  if (typeof videoId !== 'string' || !/^[A-Za-z0-9_-]{11}$/.test(videoId)) {
    throw new AssignmentError(400, '먼저 게시할 영상을 선택하세요.');
  }
  const today = await getTodayPostCount();
  if (today.posted >= today.dailyMax) throw new AssignmentError(409, '오늘 댓글 10개를 모두 게시했습니다.');
  if (await getVideoPostStatus(videoId) !== 'none') {
    throw new AssignmentError(409, '이 영상은 이미 게시했거나 게시 여부 확인이 필요합니다.');
  }
  const profiles = (await listProfiles()).filter((profile) => profile.connection === 'connected');
  if (!profiles.length) throw new AssignmentError(409, '먼저 계정 등록에서 Google 계정을 연동하고 상태 확인을 누르세요.');
  const previousProfileId = await lastPostedProfileId();
  const previousIndex = profiles.findIndex((profile) => profile.id === previousProfileId);
  const profile = profiles[(previousIndex + 1) % profiles.length];
  const assignment: Assignment = {
    id: randomUUID(), videoId, profileId: profile.id,
    profileName: profile.name, assignedAt: new Date().toISOString(),
  };
  await mkdir(dataDir, { recursive: true });
  const tempPath = `${assignmentPath}.${assignment.id}.tmp`;
  await writeFile(tempPath, JSON.stringify(assignment, null, 2), 'utf8');
  await rename(tempPath, assignmentPath);
  return assignment;
}

export async function assignedProfileForPost(assignmentId: unknown, videoId: string): Promise<string> {
  const assignment = await currentAssignment();
  if (typeof assignmentId !== 'string' || !assignment || assignment.id !== assignmentId || assignment.videoId !== videoId) {
    throw new AssignmentError(409, '자동배정 정보가 변경됐습니다. 영상을 다시 배정하세요.');
  }
  const profile = (await listProfiles()).find((item) => item.id === assignment.profileId);
  if (!profile || profile.connection !== 'connected') {
    throw new AssignmentError(409, '배정된 계정의 로그인 상태를 다시 확인한 뒤 재배정하세요.');
  }
  return profile.id;
}
