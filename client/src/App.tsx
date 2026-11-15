import { useEffect, useMemo, useRef, useState } from 'react'
import './App.css'

type SortMode = 'recommended' | 'likes' | 'views' | 'latest'
type PostStatus = 'none' | 'posted' | 'needs_review'

type VideoCandidate = {
    videoId: string
    url: string
    title: string
    channelTitle: string
    publishedAt: string
    thumbnailUrl: string
    durationSeconds: number
    format: 'shorts' | 'video' | 'unknown'
    keywords: string[]
    viewCount: number | null
    likeCount: number | null
    commentCount: number | null
    viewsPerHour: number | null
    isRising: boolean
    postStatus: PostStatus
    recommendationScore: number
    embeddable: boolean
}

type DraftResult = {
    videoId: string
    persona: string
    concern: string
    evidence: {
        source: 'video' | 'title' | 'description'
        excerpt: string
        timestampSeconds: number
    }
    videoNotes: string[]
    comment: string
    confidence: 'medium' | 'insufficient'
    issues: string[]
    fromCache: boolean
    commentsAvailable: boolean
}

type TodayCount = { date: string; posted: number; dailyMax: number }
type CommentTestStatus = {
    phase:
        | 'idle'
        | 'opening'
        | 'waiting_account'
        | 'typing'
        | 'posting'
        | 'posted'
        | 'needs_review'
        | 'failed'
    message: string
    videoId?: string
    screenshot?: string
}
type ManagedProfile = {
    id: string
    name: string
    connection: 'unverified' | 'connected' | 'disconnected'
    checkedAt?: string
}
type VideoAssignment = {
    id: string
    videoId: string
    profileId: string
    profileName: string
}
type ActivityEntry = {
    time: string
    message: string
    tone: 'info' | 'success' | 'error'
}

const numberFormatter = new Intl.NumberFormat('ko-KR')
const dateFormatter = new Intl.DateTimeFormat('ko-KR', {
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    timeZone: 'Asia/Seoul',
})

function countLabel(value: number | null) {
    return value === null ? '정보 없음' : numberFormatter.format(value)
}

function compareNumberDescending(a: number | null, b: number | null) {
    if (a === null) return b === null ? 0 : 1
    if (b === null) return -1
    return b - a
}

function commentIssues(comment: string) {
    const text = comment.trim()
    const issues: string[] = []
    const length = [...text].length
    if (length < 40 || length > 120) issues.push('댓글은 40~120자여야 합니다.')
    if (/https?:\/\/|www\.|\b[a-z0-9-]+\.[a-z]{2,}\b/i.test(text))
        issues.push('링크를 넣을 수 없습니다.')
    if (/#\S+/.test(text)) issues.push('해시태그를 넣을 수 없습니다.')
    if (text.split('운명원').length - 1 !== 1)
        issues.push('운명원은 한 번만 언급해야 합니다.')
    const laughter = text.match(/[ㅋㄱㅎ]+/g) ?? []
    const longLaugh = laughter.some(
        (run) => run.includes('ㅋ') && run.length >= 8,
    )
    if (laughter.some((run) => run.includes('ㅋ') && run.length < 8))
        issues.push(
            'ㅋㅋ는 8자 이상 길게 쓰거나 ㅋㄱ·ㅋㅎ를 섞어 자연스럽게 쓰세요.',
        )
    if (!/[ㅠㅜ]{2,}|ㅎㅎ|\p{Extended_Pictographic}/u.test(text) && !longLaugh)
        issues.push('내용에 어울리는 감정 표현 하나를 넣어주세요.')
    if (/[,，]/.test(text)) issues.push('쉼표 없이 자연스럽게 이어 쓰세요.')
    if (
        /운명원.{0,24}(?:보려고|봐야겠|봐볼까|볼까|보고 싶)(?:요|네요|다|[.!?~ㅠㅜ])*$/u.test(
            text,
        )
    )
        issues.push('운명원에서 보겠다는 같은 끝맺음을 반복하지 마세요.')
    if (
        /운명원.{0,16}(?:가봤|다녀왔|상담받|사주\s*봐봤|효과\s*봤|정확했|맞았)/.test(
            text,
        )
    )
        issues.push('운명원을 이용한 것처럼 쓰지 마세요.')
    return issues
}

function formatTime(seconds: number) {
    return `${Math.floor(seconds / 60)}:${String(seconds % 60).padStart(2, '0')}`
}

function App() {
    const [videos, setVideos] = useState<VideoCandidate[]>([])
    const videoListRef = useRef<HTMLUListElement>(null)
    const lastTrendSeenAt = useRef<number | null>(null)
    const [sortMode, setSortMode] = useState<SortMode>('recommended')
    const [isLoading, setIsLoading] = useState(false)
    const [hasLoaded, setHasLoaded] = useState(false)
    const [error, setError] = useState<string | null>(null)
    const [sourceTab, setSourceTab] = useState<'search' | 'link'>('search')
    const [previewVideo, setPreviewVideo] = useState<VideoCandidate | null>(
        null,
    )
    const [previewStart, setPreviewStart] = useState(0)
    const [today, setToday] = useState<TodayCount | null>(null)
    const [selectedVideo, setSelectedVideo] = useState<VideoCandidate | null>(
        null,
    )
    const [assignment, setAssignment] = useState<VideoAssignment | null>(null)
    const [assigning, setAssigning] = useState(false)
    const [linkInput, setLinkInput] = useState('')
    const [linkLoading, setLinkLoading] = useState(false)
    const [selectionError, setSelectionError] = useState<string | null>(null)
    const [draft, setDraft] = useState<DraftResult | null>(null)
    const [comment, setComment] = useState('')
    const [approvedComment, setApprovedComment] = useState<string | null>(null)
    const [draftDialogOpen, setDraftDialogOpen] = useState(false)
    const draftDialogRef = useRef<HTMLDivElement>(null)
    const draftCloseRef = useRef<HTMLButtonElement>(null)
    const [draftLoading, setDraftLoading] = useState(false)
    const [draftProgress, setDraftProgress] = useState('')
    const [draftError, setDraftError] = useState<string | null>(null)
    const [sceneVerified, setSceneVerified] = useState(false)
    const [testStatus, setTestStatus] = useState<CommentTestStatus | null>(null)
    const [testError, setTestError] = useState<string | null>(null)
    const [testRequestLoading, setTestRequestLoading] = useState(false)
    const [accountDialogOpen, setAccountDialogOpen] = useState(false)
    const accountButtonRef = useRef<HTMLButtonElement>(null)
    const accountCloseRef = useRef<HTMLButtonElement>(null)
    const accountDialogRef = useRef<HTMLDivElement>(null)
    const [profiles, setProfiles] = useState<ManagedProfile[]>([])
    const [profilesLoading, setProfilesLoading] = useState(true)
    const [profileBusy, setProfileBusy] = useState<string | null>(null)
    const [profileError, setProfileError] = useState<string | null>(null)
    const [profileMessage, setProfileMessage] = useState<string | null>(null)
    const [newProfileName, setNewProfileName] = useState('')
    const [editingProfileId, setEditingProfileId] = useState<string | null>(
        null,
    )
    const [editingName, setEditingName] = useState('')
    const activityListRef = useRef<HTMLOListElement>(null)
    const [activity, setActivity] = useState<ActivityEntry[]>(() => {
        try {
            const chronological = localStorage.getItem(
                'marketing-agent-activity-chronological',
            )
            const saved: unknown = JSON.parse(
                chronological ??
                    localStorage.getItem('marketing-agent-activity') ??
                    '[]',
            )
            return Array.isArray(saved)
                ? chronological === null
                    ? (saved as ActivityEntry[]).reverse()
                    : (saved as ActivityEntry[])
                : []
        } catch {
            return []
        }
    })
    const lastStatusLog = useRef('')

    function addActivity(
        message: string,
        tone: ActivityEntry['tone'] = 'info',
    ) {
        setActivity((current) =>
            current[current.length - 1]?.message === message
                ? current
                : [
                      ...current,
                      {
                          time: new Date().toLocaleString('ko-KR', {
                              month: '2-digit',
                              day: '2-digit',
                              hour: '2-digit',
                              minute: '2-digit',
                          }),
                          message,
                          tone,
                      },
                  ].slice(-30),
        )
    }

    useEffect(() => {
        try {
            localStorage.setItem(
                'marketing-agent-activity-chronological',
                JSON.stringify(activity),
            )
        } catch {
            /* 기록 저장이 막혀도 작업은 계속할 수 있습니다. */
        }
    }, [activity])

    useEffect(() => {
        if (activityListRef.current) {
            activityListRef.current.scrollTop =
                activityListRef.current.scrollHeight
        }
    }, [activity])

    async function profileRequest<T>(
        url: string,
        method: string,
        body?: object,
    ): Promise<T> {
        const response = await fetch(url, {
            method,
            headers:
                method === 'GET'
                    ? undefined
                    : {
                          'X-Marketing-Agent-Request': '1',
                          ...(body
                              ? { 'Content-Type': 'application/json' }
                              : {}),
                      },
            body: body ? JSON.stringify(body) : undefined,
        })
        const result = (await response.json()) as T & { error?: string }
        if (!response.ok)
            throw new Error(result.error ?? '프로필 작업에 실패했습니다.')
        return result
    }

    async function refreshProfiles() {
        setProfilesLoading(true)
        try {
            const result = await profileRequest<{ profiles: ManagedProfile[] }>(
                '/api/profiles',
                'GET',
            )
            setProfiles(result.profiles)
        } catch (error) {
            setProfileError(
                error instanceof Error
                    ? error.message
                    : '프로필 목록을 읽지 못했습니다.',
            )
        } finally {
            setProfilesLoading(false)
        }
    }

    async function addAccountProfile(event: React.FormEvent) {
        event.preventDefault()
        setProfileBusy('add')
        setProfileError(null)
        setProfileMessage(null)
        try {
            const profile = await profileRequest<ManagedProfile>(
                '/api/profiles',
                'POST',
                { name: newProfileName },
            )
            setProfiles((current) => [...current, profile])
            setNewProfileName('')
            await profileRequest(`/api/profiles/${profile.id}/login`, 'POST')
            setProfileMessage(
                `${profile.name} 전용 크롬 창을 열었습니다. YouTube에 로그인한 뒤 창을 완전히 닫고 상태 확인을 누르세요.`,
            )
        } catch (error) {
            setProfileError(
                error instanceof Error
                    ? error.message
                    : '프로필을 추가하지 못했습니다.',
            )
        } finally {
            setProfileBusy(null)
        }
    }

    async function saveProfileName(event: React.FormEvent, id: string) {
        event.preventDefault()
        setProfileBusy(id)
        setProfileError(null)
        setProfileMessage(null)
        try {
            const updated = await profileRequest<ManagedProfile>(
                `/api/profiles/${id}`,
                'PATCH',
                { name: editingName },
            )
            setProfiles((current) =>
                current.map((profile) =>
                    profile.id === id ? updated : profile,
                ),
            )
            setEditingProfileId(null)
        } catch (error) {
            setProfileError(
                error instanceof Error
                    ? error.message
                    : '이름을 수정하지 못했습니다.',
            )
        } finally {
            setProfileBusy(null)
        }
    }

    async function removeAccountProfile(profile: ManagedProfile) {
        if (
            !window.confirm(
                `${profile.name} 프로필과 이 PC의 Chrome 로그인 데이터를 삭제할까요?\nGoogle 계정과 기존 댓글 기록은 삭제되지 않습니다.`,
            )
        ) {
            return
        }
        setProfileBusy(profile.id)
        setProfileError(null)
        setProfileMessage(null)
        try {
            await profileRequest(`/api/profiles/${profile.id}`, 'DELETE')
            setProfiles((current) =>
                current.filter((item) => item.id !== profile.id),
            )
            if (editingProfileId === profile.id) setEditingProfileId(null)
            setProfileMessage(`${profile.name} 프로필을 삭제했습니다.`)
        } catch (error) {
            setProfileError(
                error instanceof Error
                    ? error.message
                    : '프로필을 삭제하지 못했습니다.',
            )
        } finally {
            setProfileBusy(null)
        }
    }

    async function openProfileConnection(profile: ManagedProfile) {
        const changingAccount = profile.connection === 'connected'
        if (
            changingAccount &&
            !window.confirm(
                `${profile.name}의 기존 Google 로그인 정보가 이 전용 Chrome 프로필에서 삭제되어 로그아웃됩니다. 새 계정으로 로그인하려면 계속하시겠습니까?`,
            )
        )
            return
        setProfileBusy(profile.id)
        setProfileError(null)
        setProfileMessage(null)
        try {
            await profileRequest(`/api/profiles/${profile.id}/login`, 'POST', {
                reset: changingAccount,
            })
            setProfiles((current) =>
                current.map((item) =>
                    item.id === profile.id
                        ? {
                              ...item,
                              connection: 'unverified',
                              checkedAt: undefined,
                          }
                        : item,
                ),
            )
            setProfileMessage(
                changingAccount
                    ? `${profile.name}의 기존 로그인을 해제했습니다. 열린 크롬 창에서 새 Google 계정으로 로그인한 뒤 창을 완전히 닫고 상태 확인을 누르세요.`
                    : `${profile.name} 전용 크롬 창을 열었습니다. 로그인 후 창을 완전히 닫고 상태 확인을 누르세요.`,
            )
        } catch (error) {
            setProfileError(
                error instanceof Error
                    ? error.message
                    : '로그인 창을 열지 못했습니다.',
            )
        } finally {
            setProfileBusy(null)
        }
    }

    async function checkProfileConnection(profile: ManagedProfile) {
        setProfileBusy(profile.id)
        setProfileError(null)
        setProfileMessage(null)
        try {
            const updated = await profileRequest<ManagedProfile>(
                `/api/profiles/${profile.id}/verify`,
                'POST',
            )
            setProfiles((current) =>
                current.map((item) =>
                    item.id === profile.id ? updated : item,
                ),
            )
            setProfileMessage(
                updated.connection === 'connected'
                    ? `${profile.name}의 YouTube 로그인을 확인했습니다.`
                    : `${profile.name}에서 YouTube 로그인을 확인하지 못했습니다.`,
            )
        } catch (error) {
            setProfileError(
                error instanceof Error
                    ? error.message
                    : '연동 상태를 확인하지 못했습니다.',
            )
        } finally {
            setProfileBusy(null)
        }
    }

    useEffect(() => {
        void refreshProfiles()
    }, [])

    useEffect(() => {
        if (accountDialogOpen) void refreshProfiles()
    }, [accountDialogOpen])

    useEffect(() => {
        if (!accountDialogOpen) return
        const previousOverflow = document.body.style.overflow
        document.body.style.overflow = 'hidden'
        accountCloseRef.current?.focus()
        const closeOnEscape = (event: KeyboardEvent) => {
            if (event.key === 'Escape') setAccountDialogOpen(false)
            if (event.key === 'Tab') {
                const focusable =
                    accountDialogRef.current?.querySelectorAll<HTMLElement>(
                        'button:not([disabled]), input:not([disabled])',
                    )
                if (!focusable?.length) return
                const first = focusable[0],
                    last = focusable[focusable.length - 1]
                if (event.shiftKey && document.activeElement === first) {
                    event.preventDefault()
                    last.focus()
                } else if (!event.shiftKey && document.activeElement === last) {
                    event.preventDefault()
                    first.focus()
                }
            }
        }
        document.addEventListener('keydown', closeOnEscape)
        return () => {
            document.body.style.overflow = previousOverflow
            document.removeEventListener('keydown', closeOnEscape)
            accountButtonRef.current?.focus()
        }
    }, [accountDialogOpen])

    useEffect(() => {
        const refresh = () => {
            fetch('/api/comment-test/status')
                .then((response) => response.json())
                .then((value: CommentTestStatus) => setTestStatus(value))
                .catch(() => {})
        }
        refresh()
        const interval = window.setInterval(refresh, 1500)
        return () => window.clearInterval(interval)
    }, [])

    useEffect(() => {
        if (!hasLoaded) return
        let cancelled = false
        const refreshTrends = async () => {
            try {
                const response = await fetch('/api/videos/trends')
                if (!response.ok) return
                const snapshot = (await response.json()) as {
                    measuredAt: number | null
                    videos: VideoCandidate[]
                }
                if (
                    cancelled ||
                    !snapshot.measuredAt ||
                    snapshot.measuredAt === lastTrendSeenAt.current
                )
                    return
                lastTrendSeenAt.current = snapshot.measuredAt
                const updates = new Map(
                    snapshot.videos.map((video) => [video.videoId, video]),
                )
                const updateVideo = (video: VideoCandidate) => {
                    const updated = updates.get(video.videoId)
                    return updated
                        ? {
                              ...video,
                              viewCount: updated.viewCount,
                              viewsPerHour: updated.viewsPerHour,
                              isRising: updated.isRising,
                              recommendationScore: updated.recommendationScore,
                          }
                        : video
                }
                setVideos((current) => current.map(updateVideo))
                setSelectedVideo((current) =>
                    current ? updateVideo(current) : current,
                )
            } catch {
                /* 조회수 갱신에 실패해도 기존 영상 목록은 유지합니다. */
            }
        }
        const onFocus = () => void refreshTrends()
        void refreshTrends()
        window.addEventListener('focus', onFocus)
        const interval = window.setInterval(refreshTrends, 60_000)
        return () => {
            cancelled = true
            window.removeEventListener('focus', onFocus)
            window.clearInterval(interval)
        }
    }, [hasLoaded])

    async function runCommentTest() {
        if (!selectedVideo || !approvedComment) return
        setTestRequestLoading(true)
        setTestError(null)
        try {
            const response = await fetch('/api/comment-test/post', {
                method: 'POST',
                headers: {
                    'Content-Type': 'application/json',
                    'X-Marketing-Agent-Request': '1',
                },
                body: JSON.stringify({
                    url: selectedVideo.url,
                    comment: approvedComment,
                    confirmed: true,
                    ...(assignment?.videoId === selectedVideo.videoId
                        ? { assignmentId: assignment.id }
                        : {}),
                }),
            })
            const result = (await response.json()) as CommentTestStatus & {
                error?: string
            }
            if (!response.ok)
                throw new Error(
                    result.error ?? '댓글 테스트를 시작하지 못했습니다.',
                )
            setTestStatus(result)
        } catch (cause) {
            const message =
                cause instanceof Error
                    ? cause.message
                    : '댓글 작업을 시작하지 못했습니다.'
            setTestError(message)
            addActivity(message, 'error')
        } finally {
            setTestRequestLoading(false)
        }
    }

    useEffect(() => {
        const refresh = () => {
            fetch('/api/today')
                .then((response) => (response.ok ? response.json() : null))
                .then((data: TodayCount | null) => {
                    if (data) setToday(data)
                })
                .catch(() => {})
        }
        refresh()
        window.addEventListener('focus', refresh)
        const interval = window.setInterval(refresh, 60_000)
        return () => {
            window.removeEventListener('focus', refresh)
            window.clearInterval(interval)
        }
    }, [])

    useEffect(() => {
        if (
            !testStatus?.videoId ||
            !['posted', 'needs_review'].includes(testStatus.phase)
        )
            return
        const postStatus = testStatus.phase as PostStatus
        const videoId = testStatus.videoId
        setVideos((current) =>
            current.map((video) =>
                video.videoId === videoId ? { ...video, postStatus } : video,
            ),
        )
        setSelectedVideo((current) =>
            current && current.videoId === videoId
                ? { ...current, postStatus }
                : current,
        )
        if (postStatus === 'posted') {
            fetch('/api/today')
                .then((response) => (response.ok ? response.json() : null))
                .then((data: TodayCount | null) => {
                    if (data) setToday(data)
                })
                .catch(() => {})
        }
    }, [testStatus?.phase, testStatus?.videoId])

    useEffect(() => {
        if (!testStatus || testStatus.phase === 'idle' || !testStatus.videoId)
            return
        const key = `${testStatus.phase}:${testStatus.videoId}:${testStatus.message}`
        if (lastStatusLog.current === key) return
        lastStatusLog.current = key
        addActivity(
            testStatus.screenshot
                ? `${testStatus.message} 오류 화면: ${testStatus.screenshot}`
                : testStatus.message,
            testStatus.phase === 'posted'
                ? 'success'
                : ['failed', 'needs_review'].includes(testStatus.phase)
                  ? 'error'
                  : 'info',
        )
    }, [
        testStatus?.phase,
        testStatus?.videoId,
        testStatus?.message,
        testStatus?.screenshot,
    ])

    useEffect(() => {
        if (!previewVideo) return
        const previousOverflow = document.body.style.overflow
        document.body.style.overflow = 'hidden'
        const closeOnEscape = (event: KeyboardEvent) => {
            if (event.key === 'Escape') setPreviewVideo(null)
        }
        document.addEventListener('keydown', closeOnEscape)
        return () => {
            document.body.style.overflow = previousOverflow
            document.removeEventListener('keydown', closeOnEscape)
        }
    }, [previewVideo])

    useEffect(() => {
        if (!draftDialogOpen) return
        const previousOverflow = document.body.style.overflow
        document.body.style.overflow = 'hidden'
        draftCloseRef.current?.focus()
        const onKeyDown = (event: KeyboardEvent) => {
            if (document.querySelector('.preview-backdrop')) return
            if (event.key === 'Escape' && !draftLoading)
                setDraftDialogOpen(false)
            if (event.key === 'Tab') {
                const focusable =
                    draftDialogRef.current?.querySelectorAll<HTMLElement>(
                        'button:not([disabled]), textarea:not([disabled]), input:not([disabled])',
                    )
                if (!focusable?.length) return
                const first = focusable[0],
                    last = focusable[focusable.length - 1]
                if (event.shiftKey && document.activeElement === first) {
                    event.preventDefault()
                    last.focus()
                } else if (!event.shiftKey && document.activeElement === last) {
                    event.preventDefault()
                    first.focus()
                }
            }
        }
        document.addEventListener('keydown', onKeyDown)
        return () => {
            document.body.style.overflow = previousOverflow
            document.removeEventListener('keydown', onKeyDown)
        }
    }, [draftDialogOpen, draftLoading])

    const sortedVideos = useMemo(
        () =>
            [...videos].sort((a, b) => {
                if (sortMode === 'likes')
                    return compareNumberDescending(a.likeCount, b.likeCount)
                if (sortMode === 'views')
                    return compareNumberDescending(a.viewCount, b.viewCount)
                if (sortMode === 'latest')
                    return Date.parse(b.publishedAt) - Date.parse(a.publishedAt)
                if (a.isRising !== b.isRising)
                    return a.isRising ? -1 : 1
                return b.recommendationScore - a.recommendationScore
            }),
        [videos, sortMode],
    )

    const draftIssues = draft
        ? [
              ...commentIssues(comment),
              ...draft.issues.filter((issue) => /근거|장면|시각/.test(issue)),
          ]
        : []
    const accountReady = profiles.some(
        (profile) => profile.connection === 'connected',
    )
    const accountGate = profilesLoading || !accountReady
    const nextStep =
        profilesLoading
            ? '계정을 확인하고 있어요. 잠시만 기다려 주세요.'
            : !accountReady
              ? '시작하려면 오른쪽 ‘계정 등록’을 눌러 유튜브 계정을 연결해 주세요.'
              : (today?.posted ?? 0) >= (today?.dailyMax ?? 10)
                ? '오늘 댓글 10개를 모두 올렸어요. 내일 다시 이용해 주세요.'
            : error || selectionError || draftError || testError
              ? '문제가 생겼어요. 아래에서 이유를 확인하고 다시 시도해 주세요.'
              : isLoading || linkLoading
                ? '영상을 확인하고 있어요. 잠시만 기다려 주세요.'
                : draftLoading
                  ? '영상을 읽고 댓글을 만들고 있어요. 완성되면 내용을 확인해 주세요.'
                  : [
                          'opening',
                          'waiting_account',
                          'typing',
                          'posting',
                      ].includes(testStatus?.phase ?? '')
                    ? assignment
                        ? '열린 크롬 창에서 댓글이 올라가는지 확인해 주세요.'
                        : '열린 크롬 창에서 계정을 고른 뒤 댓글이 올라가는지 확인해 주세요.'
                    : testStatus?.phase === 'needs_review' &&
                        testStatus.videoId === selectedVideo?.videoId
                      ? '댓글이 올라갔는지 확인하지 못했어요. 열린 크롬 창을 확인해 주세요.'
                      : testStatus?.phase === 'failed' &&
                          testStatus.videoId === selectedVideo?.videoId
                        ? '댓글을 올리지 못했어요. 아래에서 이유를 확인해 주세요.'
                        : !selectedVideo
                          ? '왼쪽에서 영상을 불러오거나 링크를 넣고 영상을 골라 주세요.'
                          : selectedVideo.postStatus === 'needs_review'
                            ? '이 영상은 댓글이 올라갔는지 확인이 필요해요. 크롬 창을 확인해 주세요.'
                            : selectedVideo.postStatus === 'posted'
                              ? '댓글이 올라갔어요. 다음 영상을 골라 주세요.'
                              : !draft
                                ? '오른쪽의 ‘AI 초안 작성’을 눌러 댓글을 만들어 주세요.'
                                : !approvedComment
                                  ? '팝업에서 댓글을 읽고 확인한 뒤 ‘확정’을 눌러 주세요.'
                                  : '댓글을 올릴 준비가 됐어요. ‘댓글 작성’을 눌러 주세요.'
    const currentStatus =
        error ??
        selectionError ??
        draftError ??
        testError ??
        (isLoading
            ? '영상을 불러오는 중입니다.'
            : linkLoading
              ? '영상 링크를 확인하는 중입니다.'
              : draftLoading
                ? draftProgress
                : [
                        'opening',
                        'waiting_account',
                        'typing',
                        'posting',
                        'posted',
                        'needs_review',
                        'failed',
                    ].includes(testStatus?.phase ?? '')
                  ? testStatus?.message
                  : null) ??
        '지금 진행 중인 작업이 없어요.'
    const statusIsError = Boolean(
        error ||
            selectionError ||
            draftError ||
            testError ||
            ['failed', 'needs_review'].includes(testStatus?.phase ?? ''),
    )

    function selectVideo(video: VideoCandidate) {
        setSelectedVideo(video)
        setAssignment(null)
        setSelectionError(null)
        setDraft(null)
        setComment('')
        setApprovedComment(null)
        setDraftDialogOpen(false)
        setDraftError(null)
        setSceneVerified(false)
        setTestError(null)
        setError(null)
        addActivity(`영상 선택: ${video.title.slice(0, 65)}`)
    }

    async function assignProfile() {
        if (!selectedVideo) return
        setAssigning(true)
        setTestError(null)
        try {
            const response = await fetch('/api/assignments', {
                method: 'POST',
                headers: {
                    'Content-Type': 'application/json',
                    'X-Marketing-Agent-Request': '1',
                },
                body: JSON.stringify({ videoId: selectedVideo.videoId }),
            })
            const result = (await response.json()) as VideoAssignment & {
                error?: string
            }
            if (!response.ok)
                throw new Error(result.error ?? '게시 계정을 자동배정하지 못했습니다.')
            setAssignment(result)
            addActivity(`${result.profileName} 계정을 자동배정했습니다.`, 'success')
        } catch (cause) {
            const message = cause instanceof Error ? cause.message : '게시 계정을 자동배정하지 못했습니다.'
            setTestError(message)
            addActivity(message, 'error')
        } finally {
            setAssigning(false)
        }
    }

    async function selectFromLink(event: React.FormEvent<HTMLFormElement>) {
        event.preventDefault()
        setLinkLoading(true)
        setSelectionError(null)
        addActivity('입력한 영상 링크를 확인하는 중입니다.')
        try {
            const response = await fetch('/api/videos/resolve', {
                method: 'POST',
                headers: {
                    'Content-Type': 'application/json',
                    'X-Marketing-Agent-Request': '1',
                },
                body: JSON.stringify({ url: linkInput }),
            })
            const payload = (await response.json()) as {
                video?: VideoCandidate
                error?: string
            }
            if (!response.ok || !payload.video)
                throw new Error(
                    payload.error ?? '영상 링크를 확인하지 못했습니다.',
                )
            selectVideo(payload.video)
        } catch (cause) {
            const message =
                cause instanceof Error
                    ? cause.message
                    : '영상 링크를 확인하지 못했습니다.'
            setSelectionError(message)
            addActivity(message, 'error')
        } finally {
            setLinkLoading(false)
        }
    }

    async function generateDraft(regenerate = false) {
        if (!selectedVideo) return
        setDraftLoading(true)
        setDraftProgress('영상 분석 요청 중…')
        setDraftError(null)
        addActivity(
            regenerate
                ? '영상 근거를 유지하며 다른 초안을 작성하는 중입니다.'
                : '영상 분석과 댓글 초안을 시작했습니다.',
        )
        try {
            const response = await fetch('/api/drafts', {
                method: 'POST',
                headers: {
                    'Content-Type': 'application/json',
                    'X-Marketing-Agent-Request': '1',
                },
                body: JSON.stringify({
                    videoId: selectedVideo.videoId,
                    regenerate,
                }),
            })
            const payload = (await response.json()) as {
                jobId?: string
                error?: string
            }
            if (!response.ok || !payload.jobId)
                throw new Error(
                    payload.error ?? 'AI 초안을 작성하지 못했습니다.',
                )
            let result: DraftResult | null = null
            for (;;) {
                await new Promise((resolve) => window.setTimeout(resolve, 4000))
                const check = await fetch(`/api/drafts/jobs/${payload.jobId}`)
                const job = (await check.json()) as {
                    status?: string
                    result?: DraftResult
                    error?: string
                }
                if (!check.ok || job.status === 'failed')
                    throw new Error(
                        job.error ?? 'AI 초안을 작성하지 못했습니다.',
                    )
                if (job.status === 'completed') {
                    result = job.result ?? null
                    break
                }
                setDraftProgress(
                    'Gemini가 영상을 분석 중입니다. 긴 영상은 몇 분 걸릴 수 있습니다…',
                )
            }
            if (!result) throw new Error('AI 초안 결과가 비어 있습니다.')
            setDraft(result)
            setComment(result.comment)
            setSceneVerified(false)
            setApprovedComment(null)
            setDraftDialogOpen(true)
            addActivity(
                result.fromCache
                    ? '저장된 초안을 불러왔습니다.'
                    : 'AI 초안이 작성됐습니다. 내용과 영상 근거를 확인하세요.',
                'success',
            )
        } catch (cause) {
            const message =
                cause instanceof Error
                    ? cause.message
                    : 'AI 초안을 작성하지 못했습니다.'
            setDraftError(message)
            addActivity(message, 'error')
        } finally {
            setDraftLoading(false)
            setDraftProgress('')
        }
    }

    function confirmDraft() {
        if (
            !draft ||
            !sceneVerified ||
            draftIssues.length ||
            draft.confidence === 'insufficient'
        )
            return
        setApprovedComment(comment.trim())
        setDraftDialogOpen(false)
        addActivity(
            '댓글 초안을 확정했습니다. 3단계에서 게시할 수 있습니다.',
            'success',
        )
    }

    function openPreview(video: VideoCandidate, start = 0) {
        setPreviewStart(start)
        setPreviewVideo(video)
    }

    async function loadVideos(refresh = false) {
        setIsLoading(true)
        setError(null)
        addActivity('연애 관련 영상을 불러오는 중입니다.')
        try {
            const query = refresh ? '?reset=1' : ''
            const response = await fetch(`/api/videos${query}`)
            const payload = (await response.json()) as {
                videos?: VideoCandidate[]
                measuredAt?: number | null
                error?: string
            }
            if (!response.ok)
                throw new Error(payload.error ?? '영상을 불러오지 못했습니다.')
            setVideos(payload.videos ?? [])
            lastTrendSeenAt.current = payload.measuredAt ?? null
            setHasLoaded(true)
            window.requestAnimationFrame(() =>
                videoListRef.current?.scrollTo({ top: 0 }),
            )
            addActivity(
                `${(payload.videos ?? []).length}개 영상을 불러왔습니다.`,
                'success',
            )
        } catch (cause) {
            const message =
                cause instanceof Error
                    ? cause.message
                    : '영상을 불러오지 못했습니다.'
            setError(message)
            addActivity(message, 'error')
        } finally {
            setIsLoading(false)
        }
    }

    return (
        <main className="dashboard">
            <header className="dashboard-header">
                <h1>유튜브 댓글 대시보드</h1>
            </header>

            <section className="activity-panel" aria-label="작업 안내">
                <div
                    className={`activity-guidance ${!accountReady && !profilesLoading ? 'is-setup' : ''}`}
                    role="status"
                >
                    <strong>{nextStep}</strong>
                </div>
                <div className="header-status">
                    <strong className="today-count">
                        오늘 단 댓글&nbsp;{' '}
                        {today
                            ? `${today.posted}/${today.dailyMax}`
                            : '확인 중…'}
                    </strong>
                    <button
                        type="button"
                        ref={accountButtonRef}
                        className={`account-button ${!accountReady && !profilesLoading ? 'is-required' : ''}`}
                        onClick={() => setAccountDialogOpen(true)}
                        aria-haspopup="dialog"
                    >
                        <svg
                            viewBox="0 0 24 24"
                            width="16"
                            height="16"
                            fill="currentColor"
                            aria-hidden="true"
                        >
                            <path d="M10 11a4 4 0 1 0 0-8 4 4 0 0 0 0 8Zm0 2c-4.4 0-8 2.2-8 5v2h16v-2c0-2.8-3.6-5-8-5Zm11-9h-2V2h-2v2h-2v2h2v2h2V6h2V4Z" />
                        </svg>
                        {accountReady ? '계정 등록' : '계정 등록하기'}
                    </button>
                </div>
            </section>

            <div
                className={`dashboard-grid ${accountGate ? 'is-locked' : ''}`}
                inert={accountGate}
                aria-disabled={accountGate}
            >
                <section
                    className="panel videos-panel"
                    aria-labelledby="videos-title"
                    aria-busy={isLoading}
                >
                    <div className="panel-heading">
                        <span className="step">1</span>
                        <h2 id="videos-title">영상 선택</h2>
                    </div>
                    <div
                        className="source-tabs"
                        role="tablist"
                        aria-label="영상 선택 방법"
                    >
                        <button
                            type="button"
                            role="tab"
                            aria-selected={sourceTab === 'search'}
                            className={
                                sourceTab === 'search' ? 'is-active' : ''
                            }
                            onClick={() => setSourceTab('search')}
                        >
                            영상 불러오기
                        </button>
                        <button
                            type="button"
                            role="tab"
                            aria-selected={sourceTab === 'link'}
                            className={sourceTab === 'link' ? 'is-active' : ''}
                            onClick={() => setSourceTab('link')}
                        >
                            링크로 선택
                        </button>
                    </div>
                    {sourceTab === 'link' ? (
                        <div className="link-tab-content" role="tabpanel">
                            <form
                                className="link-form"
                                onSubmit={selectFromLink}
                            >
                                <label className="field" htmlFor="video-link">
                                    <span className="field-label">
                                        유튜브 영상 링크
                                    </span>
                                    <input
                                        id="video-link"
                                        type="url"
                                        value={linkInput}
                                        onChange={(event) =>
                                            setLinkInput(event.target.value)
                                        }
                                        placeholder="https://www.youtube.com/watch?v=..."
                                        disabled={linkLoading || draftLoading}
                                        required
                                    />
                                </label>
                                <button
                                    type="submit"
                                    disabled={linkLoading || draftLoading}
                                >
                                    {linkLoading
                                        ? '링크 확인 중…'
                                        : '이 영상 선택'}
                                </button>
                            </form>
                            {selectedVideo && (
                                <p className="link-selected">
                                    선택한 영상은 오른쪽 2단계에서 확인할 수
                                    있습니다.
                                </p>
                            )}
                        </div>
                    ) : (
                        <div className="search-tab-content" role="tabpanel">
                            {!hasLoaded ? (
                                <div className="video-start">
                                    <button
                                        type="button"
                                        onClick={() => loadVideos()}
                                        disabled={isLoading}
                                    >
                                        {isLoading
                                            ? '영상 불러오는 중…'
                                            : '영상 불러오기'}
                                    </button>
                                </div>
                            ) : (
                                <div className="list-controls">
                                    <span>{videos.length}개 영상</span>
                                    <button
                                        type="button"
                                        className="refresh-button"
                                        onClick={() => loadVideos(true)}
                                        disabled={isLoading}
                                        title="조건에 맞는 영상을 새로 불러오기"
                                        aria-label="영상 새로고침"
                                    >
                                        <svg
                                            viewBox="0 0 24 24"
                                            width="17"
                                            height="17"
                                            fill="none"
                                            stroke="currentColor"
                                            strokeWidth="1.8"
                                            strokeLinecap="round"
                                            strokeLinejoin="round"
                                            aria-hidden="true"
                                        >
                                            <path d="M20 11a8 8 0 1 1-2.1-5.4" />
                                            <path d="M20 4v5h-5" />
                                        </svg>
                                        <span>새로고침</span>
                                    </button>
                                    <label htmlFor="video-sort">필터</label>
                                    <select
                                        id="video-sort"
                                        value={sortMode}
                                        onChange={(event) =>
                                            setSortMode(
                                                event.target.value as SortMode,
                                            )
                                        }
                                    >
                                        <option value="recommended">
                                            추천순
                                        </option>
                                        <option value="likes">
                                            인기순(좋아요)
                                        </option>
                                        <option value="views">조회수순</option>
                                        <option value="latest">최신순</option>
                                    </select>
                                </div>
                            )}
                            {hasLoaded && videos.length === 0 && (
                                <div className="empty-state">
                                    <strong>조건에 맞는 영상이 없습니다</strong>
                                    <span>
                                        새로고침으로 다른 후보를 확인하세요.
                                    </span>
                                </div>
                            )}
                            {sortedVideos.length > 0 && (
                                <ul ref={videoListRef} className="video-list">
                                    {sortedVideos.map((video) => (
                                        <li
                                            key={video.videoId}
                                            className="video-card"
                                        >
                                            {video.thumbnailUrl && (
                                                <img
                                                    className="video-thumbnail"
                                                    src={video.thumbnailUrl}
                                                    alt=""
                                                    loading="lazy"
                                                />
                                            )}
                                            <div className="video-body">
                                                <button
                                                    type="button"
                                                    className="video-title"
                                                    title={video.title}
                                                    onClick={() =>
                                                        openPreview(video)
                                                    }
                                                >
                                                    {video.title}
                                                </button>
                                                <p className="video-byline">
                                                    {video.channelTitle} ·{' '}
                                                    {dateFormatter.format(
                                                        new Date(
                                                            video.publishedAt,
                                                        ),
                                                    )}
                                                </p>
                                                <p className="video-stats">
                                                    조회수{' '}
                                                    {countLabel(
                                                        video.viewCount,
                                                    )}{' '}
                                                    · 좋아요{' '}
                                                    {countLabel(
                                                        video.likeCount,
                                                    )}{' '}
                                                    · 댓글{' '}
                                                    {countLabel(
                                                        video.commentCount,
                                                    )}
                                                </p>
                                                <div className="video-labels">
                                                    <span
                                                        className={`label ${video.format === 'shorts' ? 'label-shorts' : video.format === 'video' ? 'label-video' : 'label-unknown'}`}
                                                    >
                                                        {video.format ===
                                                        'shorts'
                                                            ? '쇼츠'
                                                            : video.format ===
                                                                'video'
                                                              ? '일반 영상'
                                                              : '형식 확인 필요'}
                                                    </span>
                                                    {video.keywords.map(
                                                        (keyword) => (
                                                            <span
                                                                key={keyword}
                                                                className="label label-keyword"
                                                            >
                                                                {keyword}
                                                            </span>
                                                        ),
                                                    )}
                                                </div>
                                                {((video.viewCount !== null &&
                                                    video.viewCount >= 1000 &&
                                                    video.viewCount <= 5000 &&
                                                    video.viewsPerHour === null) ||
                                                    video.isRising ||
                                                    video.postStatus !==
                                                        'none') && (
                                                    <div className="video-labels video-status-labels">
                                                        {video.viewCount !== null &&
                                                            video.viewCount >= 1000 &&
                                                            video.viewCount <= 5000 &&
                                                            video.viewsPerHour === null && (
                                                                <span className="label label-measuring">
                                                                    급상승 측정 중
                                                                </span>
                                                            )}
                                                        {video.isRising && (
                                                            <span className="label label-rising">
                                                                최근 1시간
                                                                급상승
                                                            </span>
                                                        )}
                                                        {video.postStatus ===
                                                            'posted' && (
                                                            <span className="label label-posted">
                                                                댓글 등록됨
                                                            </span>
                                                        )}
                                                        {video.postStatus ===
                                                            'needs_review' && (
                                                            <span className="label label-review">
                                                                확인 필요
                                                            </span>
                                                        )}
                                                    </div>
                                                )}
                                                <button
                                                    type="button"
                                                    className={`select-video ${selectedVideo?.videoId === video.videoId ? 'is-selected' : ''}`}
                                                    onClick={() =>
                                                        selectVideo(video)
                                                    }
                                                    disabled={
                                                        draftLoading ||
                                                        linkLoading
                                                    }
                                                >
                                                    {selectedVideo?.videoId ===
                                                    video.videoId
                                                        ? '선택됨'
                                                        : '이 영상 선택'}
                                                </button>
                                            </div>
                                        </li>
                                    ))}
                                </ul>
                            )}
                        </div>
                    )}
                </section>

                <div className="workflow-column">
                    <section
                        className="panel draft-panel"
                        aria-labelledby="draft-title"
                    >
                        <div className="panel-heading">
                            <span className="step">2</span>
                            <h2 id="draft-title">영상 선택 · 초안 작성</h2>
                        </div>
                        {selectedVideo ? (
                            <div className="selected-video">
                                {selectedVideo.thumbnailUrl && (
                                    <img
                                        src={selectedVideo.thumbnailUrl}
                                        alt=""
                                    />
                                )}
                                <div className="selected-video-info">
                                    <strong title={selectedVideo.title}>
                                        {selectedVideo.title}
                                    </strong>
                                    <span>
                                        {selectedVideo.channelTitle} ·{' '}
                                        {dateFormatter.format(
                                            new Date(selectedVideo.publishedAt),
                                        )}{' '}
                                        ·{' '}
                                        {formatTime(
                                            selectedVideo.durationSeconds,
                                        )}
                                    </span>
                                    <div className="video-labels">
                                        <span
                                            className={`label ${selectedVideo.format === 'shorts' ? 'label-shorts' : selectedVideo.format === 'video' ? 'label-video' : 'label-unknown'}`}
                                        >
                                            {selectedVideo.format === 'shorts'
                                                ? '쇼츠'
                                                : selectedVideo.format ===
                                                    'video'
                                                  ? '일반 영상'
                                                  : '형식 확인 필요'}
                                        </span>
                                        {selectedVideo.keywords.map(
                                            (keyword) => (
                                                <span
                                                    key={keyword}
                                                    className="label label-keyword"
                                                >
                                                    {keyword}
                                                </span>
                                            ),
                                        )}
                                        {selectedVideo.isRising && (
                                            <span className="label label-rising">
                                                최근 1시간 급상승
                                            </span>
                                        )}
                                        {selectedVideo.postStatus ===
                                            'posted' && (
                                            <span className="label label-posted">
                                                댓글 등록됨
                                            </span>
                                        )}
                                        {selectedVideo.postStatus ===
                                            'needs_review' && (
                                            <span className="label label-review">
                                                확인 필요
                                            </span>
                                        )}
                                    </div>
                                </div>
                            </div>
                        ) : (
                            <div className="selected-placeholder">
                                1단계에서 영상을 선택하세요.
                            </div>
                        )}
                        <div className="draft-actions">
                            <button
                                type="button"
                                className="preview-button"
                                onClick={() =>
                                    selectedVideo && openPreview(selectedVideo)
                                }
                                disabled={!selectedVideo}
                            >
                                미리보기
                            </button>
                            <button
                                type="button"
                                className="generate-button"
                                onClick={() =>
                                    draft
                                        ? setDraftDialogOpen(true)
                                        : generateDraft()
                                }
                                disabled={!selectedVideo || draftLoading}
                            >
                                {draftLoading
                                    ? 'AI 초안 작성 중…'
                                    : draft
                                      ? approvedComment
                                          ? '확정한 초안 보기'
                                          : '초안 확인 · 확정'
                                      : 'AI 초안 작성'}
                            </button>
                        </div>
                    </section>

                    <section
                        className="panel publish-panel"
                        aria-labelledby="publish-title"
                    >
                        <div className="panel-heading">
                            <span className="step">3</span>
                            <h2 id="publish-title">댓글 작성</h2>
                        </div>
                        <div className="field">
                            <span className="field-label">게시할 댓글</span>
                            <div className="draft-text">
                                {approvedComment ??
                                    '2단계에서 초안을 확인하고 확정하세요.'}
                            </div>
                        </div>
                        {assignment && assignment.videoId === selectedVideo?.videoId && (
                            <span className="assigned-profile-note">
                                배정 계정: {assignment.profileName} · 댓글 작성을 누르면 이 계정으로 열립니다.
                            </span>
                        )}
                        <div className="publish-actions">
                            <button
                                type="button"
                                className="auto-assign-button"
                                onClick={assignProfile}
                                disabled={
                                    !selectedVideo || !approvedComment ||
                                    selectedVideo.postStatus !== 'none' ||
                                    (today?.posted ?? 0) >= (today?.dailyMax ?? 10) ||
                                    assigning || testRequestLoading ||
                                    ['opening', 'waiting_account', 'typing', 'posting'].includes(testStatus?.phase ?? '')
                                }
                            >
                                {assigning ? '배정 중…' : '자동배정'}
                            </button>
                            <button
                                type="button"
                                onClick={runCommentTest}
                                disabled={
                                    !selectedVideo || !approvedComment ||
                                    selectedVideo.postStatus !== 'none' ||
                                    (today?.posted ?? 0) >= (today?.dailyMax ?? 10) ||
                                    assigning || testRequestLoading ||
                                    ['opening', 'waiting_account', 'typing', 'posting'].includes(testStatus?.phase ?? '')
                                }
                            >
                                댓글 작성
                            </button>
                        </div>
                    </section>
                </div>
            </div>
            <section className="status-panel" aria-label="진행 상태와 기록">
                <div
                    className={`status-current ${statusIsError ? 'has-error' : ''}`}
                    role="status"
                >
                    <span>현재 상태</span>
                    <strong>{currentStatus}</strong>
                </div>
                <div className="activity-history">
                    <span className="activity-label">기록</span>
                    <ol ref={activityListRef}>
                        {activity.length ? (
                            activity.map((entry, index) => (
                                <li
                                    key={`${entry.time}-${index}`}
                                    className={`activity-${entry.tone}`}
                                >
                                    <time>{entry.time}</time>
                                    <span>{entry.message}</span>
                                </li>
                            ))
                        ) : (
                            <li className="activity-empty">
                                아직 작업 기록이 없습니다.
                            </li>
                        )}
                    </ol>
                </div>
            </section>
            {draftDialogOpen && draft && (
                <div
                    className="draft-backdrop"
                    onMouseDown={(event) => {
                        if (
                            event.target === event.currentTarget &&
                            !draftLoading
                        )
                            setDraftDialogOpen(false)
                    }}
                >
                    <div
                        ref={draftDialogRef}
                        className="draft-dialog"
                        role="dialog"
                        aria-modal="true"
                        aria-labelledby="draft-dialog-title"
                    >
                        <div className="draft-dialog-header">
                            <div>
                                <span className="modal-eyebrow">
                                    2단계 · 초안 검토
                                </span>
                                <h2 id="draft-dialog-title">
                                    영상 분석과 댓글 초안
                                </h2>
                            </div>
                            <div className="draft-dialog-actions">
                                <button
                                    type="button"
                                    className="regenerate-button"
                                    onClick={() => generateDraft(true)}
                                    disabled={draftLoading}
                                >
                                    <svg
                                        viewBox="0 0 24 24"
                                        width="19"
                                        height="19"
                                        fill="none"
                                        stroke="currentColor"
                                        strokeWidth="1.8"
                                        strokeLinecap="round"
                                        strokeLinejoin="round"
                                        aria-hidden="true"
                                    >
                                        <path d="M4 8a8 8 0 1 1-1 6" />
                                        <path d="M4 3v5h5" />
                                    </svg>
                                    다른 표현으로 다시 생성
                                </button>
                                <button
                                    type="button"
                                    ref={draftCloseRef}
                                    className="draft-close"
                                    onClick={() => setDraftDialogOpen(false)}
                                    disabled={draftLoading}
                                    aria-label="초안 창 닫기"
                                >
                                    ×
                                </button>
                            </div>
                        </div>
                        {draftLoading && (
                            <p className="draft-loading" role="status">
                                {draftProgress}
                            </p>
                        )}
                        {draftError && (
                            <p className="load-error" role="alert">
                                {draftError}
                            </p>
                        )}
                        <div className="draft-dialog-grid">
                            <div className="draft-info-group">
                                <div className="draft-info">
                                    <span>영상 속 연애 고민</span>
                                    <p>{draft.concern}</p>
                                </div>
                                <div className="draft-info">
                                    <span>시청자 페르소나</span>
                                    <p>{draft.persona}</p>
                                </div>
                                <div className="draft-info">
                                    <span>
                                        댓글 근거 ·{' '}
                                        {draft.evidence.source === 'video'
                                            ? '영상 분석'
                                            : draft.evidence.source === 'title'
                                              ? '제목'
                                              : '설명'}
                                    </span>
                                    <p>
                                        {draft.evidence.excerpt ||
                                            '구체적 근거 없음'}
                                    </p>
                                    {draft.evidence.source === 'video' &&
                                        selectedVideo &&
                                        draft.evidence.timestampSeconds >=
                                            0 && (
                                            <button
                                                type="button"
                                                className="text-button"
                                                onClick={() =>
                                                    openPreview(
                                                        selectedVideo,
                                                        draft.evidence
                                                            .timestampSeconds,
                                                    )
                                                }
                                            >
                                                {formatTime(
                                                    draft.evidence
                                                        .timestampSeconds,
                                                )}
                                                부터 영상 확인
                                            </button>
                                        )}
                                </div>
                                {draft.videoNotes.length > 0 && (
                                    <div className="draft-info">
                                        <span>영상에서 확인한 내용</span>
                                        <ul>
                                            {draft.videoNotes.map(
                                                (note, index) => (
                                                    <li key={index}>{note}</li>
                                                ),
                                            )}
                                        </ul>
                                    </div>
                                )}
                            </div>
                            <div className="draft-review-group">
                                <label
                                    className="field"
                                    htmlFor="comment-draft"
                                >
                                    <span className="field-label">
                                        댓글 초안 · 40~120자
                                    </span>
                                    <textarea
                                        id="comment-draft"
                                        value={comment}
                                        onChange={(event) => {
                                            setComment(event.target.value)
                                            setSceneVerified(false)
                                            setApprovedComment(null)
                                        }}
                                        disabled={draftLoading}
                                    />
                                </label>
                                <p className="character-count">
                                    {[...comment.trim()].length} / 40~120자
                                </p>
                                {draftIssues.length > 0 ? (
                                    <ul className="draft-issues">
                                        {draftIssues.map((issue) => (
                                            <li key={issue}>{issue}</li>
                                        ))}
                                    </ul>
                                ) : (
                                    <p className="draft-valid">
                                        댓글 형식 조건을 충족했습니다.
                                    </p>
                                )}
                                {!draft.commentsAvailable && (
                                    <p className="draft-meta">
                                        인기 댓글을 읽지 못해 영상 자료로
                                        작성했습니다.
                                    </p>
                                )}
                                {draft.fromCache && (
                                    <p className="draft-meta">
                                        저장된 초안을 불러왔습니다.
                                    </p>
                                )}
                                {draft.confidence === 'insufficient' ? (
                                    <p className="load-error">
                                        영상 근거가 부족합니다. 다른 표현으로
                                        다시 생성해 확인하세요.
                                    </p>
                                ) : (
                                    <label className="verify-row">
                                        <input
                                            type="checkbox"
                                            checked={sceneVerified}
                                            onChange={(event) =>
                                                setSceneVerified(
                                                    event.target.checked,
                                                )
                                            }
                                            disabled={draftLoading}
                                        />{' '}
                                        영상 속 근거와 수정한 댓글을 직접
                                        확인했습니다.
                                    </label>
                                )}
                                <div className="draft-dialog-footer">
                                    <button
                                        type="button"
                                        className="confirm-button"
                                        onClick={confirmDraft}
                                        disabled={
                                            !sceneVerified ||
                                            draftIssues.length > 0 ||
                                            draft.confidence ===
                                                'insufficient' ||
                                            draftLoading
                                        }
                                    >
                                        확정
                                    </button>
                                </div>
                            </div>
                        </div>
                    </div>
                </div>
            )}
            {accountDialogOpen && (
                <div
                    className="account-backdrop"
                    onMouseDown={(event) => {
                        if (event.target === event.currentTarget)
                            setAccountDialogOpen(false)
                    }}
                >
                    <div
                        ref={accountDialogRef}
                        className="account-dialog"
                        role="dialog"
                        aria-modal="true"
                        aria-labelledby="account-title"
                        aria-describedby="account-description"
                    >
                        <div className="account-dialog-header">
                            <div>
                                <h2 id="account-title">Google 계정 연동</h2>
                                <p id="account-description">
                                    댓글을 게시할 전용 크롬 프로필에 Google
                                    계정을 연결합니다.
                                </p>
                            </div>
                            <button
                                type="button"
                                ref={accountCloseRef}
                                className="account-close"
                                onClick={() => setAccountDialogOpen(false)}
                                aria-label="계정 연동 창 닫기"
                            >
                                ×
                            </button>
                        </div>
                        <form
                            className="account-add-form"
                            onSubmit={addAccountProfile}
                        >
                            <label htmlFor="new-profile-name">
                                새 프로필 추가
                            </label>
                            <div>
                                <input
                                    id="new-profile-name"
                                    value={newProfileName}
                                    onChange={(event) =>
                                        setNewProfileName(event.target.value)
                                    }
                                    maxLength={30}
                                    placeholder="프로필 이름"
                                    required
                                />
                                <button
                                    type="submit"
                                    disabled={
                                        profileBusy !== null ||
                                        !newProfileName.trim()
                                    }
                                >
                                    추가하고 연동
                                </button>
                            </div>
                        </form>
                        {profilesLoading && (
                            <p className="account-note">
                                프로필을 불러오는 중…
                            </p>
                        )}
                        <div className="account-profile-list">
                            {profiles.map((profile) => (
                                <div
                                    className="account-profile"
                                    key={profile.id}
                                >
                                    <div className="account-profile-heading">
                                        <div>
                                            <div className="account-profile-name">
                                                <strong>{profile.name}</strong>
                                                {editingProfileId !==
                                                    profile.id && (
                                                    <div className="account-profile-controls">
                                                        <button
                                                            type="button"
                                                            className="account-edit-trigger"
                                                            onClick={() => {
                                                                setEditingProfileId(
                                                                    profile.id,
                                                                )
                                                                setEditingName(
                                                                    profile.name,
                                                                )
                                                            }}
                                                            disabled={
                                                                profileBusy !==
                                                                null
                                                            }
                                                            aria-label={`${profile.name} 이름 수정`}
                                                            title="이름 수정"
                                                        >
                                                            <svg
                                                                viewBox="0 0 24 24"
                                                                width="15"
                                                                height="15"
                                                                fill="currentColor"
                                                                aria-hidden="true"
                                                            >
                                                                <path d="m16.9 3.4 3.7 3.7a1.5 1.5 0 0 1 0 2.1l-10.9 10.9-5.1 1 1-5.1L16.5 3.4a.3.3 0 0 1 .4 0ZM5.7 17.3l-.4 1.4 1.4-.4 10.8-10.8-1-1L5.7 17.3Z" />
                                                            </svg>
                                                        </button>
                                                        <button
                                                            type="button"
                                                            className="account-delete-trigger"
                                                            onClick={() =>
                                                                removeAccountProfile(
                                                                    profile,
                                                                )
                                                            }
                                                            disabled={
                                                                profileBusy !==
                                                                null
                                                            }
                                                            aria-label={`${profile.name} 삭제`}
                                                            title="프로필 삭제"
                                                        >
                                                            <svg
                                                                viewBox="0 0 24 24"
                                                                width="15"
                                                                height="15"
                                                                fill="none"
                                                                stroke="currentColor"
                                                                strokeWidth="1.8"
                                                                strokeLinecap="round"
                                                                strokeLinejoin="round"
                                                                aria-hidden="true"
                                                            >
                                                                <path d="M4 7h16M9 7V4h6v3m3 0-1 13H7L6 7m4 4v6m4-6v6" />
                                                            </svg>
                                                        </button>
                                                    </div>
                                                )}
                                            </div>
                                            <span>전용 크롬 프로필</span>
                                        </div>
                                        <span
                                            className={`account-connection account-${profile.connection}`}
                                        >
                                            {profile.connection === 'connected'
                                                ? 'YouTube 로그인 확인'
                                                : profile.connection ===
                                                    'disconnected'
                                                  ? '로그인 필요'
                                                  : '상태 미확인'}
                                        </span>
                                    </div>
                                    {editingProfileId === profile.id ? (
                                        <form
                                            className="account-edit-form"
                                            onSubmit={(event) =>
                                                saveProfileName(
                                                    event,
                                                    profile.id,
                                                )
                                            }
                                        >
                                            <input
                                                aria-label={`${profile.name} 이름`}
                                                value={editingName}
                                                onChange={(event) =>
                                                    setEditingName(
                                                        event.target.value,
                                                    )
                                                }
                                                maxLength={30}
                                                required
                                            />
                                            <button
                                                type="submit"
                                                disabled={
                                                    profileBusy !== null ||
                                                    !editingName.trim()
                                                }
                                            >
                                                저장
                                            </button>
                                            <button
                                                type="button"
                                                onClick={() =>
                                                    setEditingProfileId(null)
                                                }
                                            >
                                                취소
                                            </button>
                                        </form>
                                    ) : null}
                                    <div className="account-profile-actions">
                                        <button
                                            type="button"
                                            onClick={() =>
                                                openProfileConnection(profile)
                                            }
                                            disabled={profileBusy !== null}
                                        >
                                            {profile.connection === 'connected'
                                                ? '계정 변경'
                                                : 'Google 계정 연동'}
                                        </button>
                                        <button
                                            type="button"
                                            onClick={() =>
                                                checkProfileConnection(profile)
                                            }
                                            disabled={profileBusy !== null}
                                        >
                                            상태 확인
                                        </button>
                                    </div>
                                </div>
                            ))}
                        </div>
                        {profileError && (
                            <p className="load-error" role="alert">
                                {profileError}
                            </p>
                        )}
                        {profileMessage && (
                            <p className="account-message" role="status">
                                {profileMessage}
                            </p>
                        )}
                        <p className="account-note account-help">
                            연동 창에서 기존 Google 계정으로 YouTube에
                            로그인하세요. 창을 완전히 닫은 뒤 상태 확인을 누르면
                            댓글 달기에서 해당 프로필을 사용할 수 있습니다.
                        </p>
                    </div>
                </div>
            )}
            {previewVideo && (
                <div
                    className="preview-backdrop"
                    onMouseDown={() => setPreviewVideo(null)}
                >
                    <div
                        className="preview-dialog"
                        role="dialog"
                        aria-modal="true"
                        aria-labelledby="preview-title"
                        onMouseDown={(event) => event.stopPropagation()}
                    >
                        <div className="preview-header">
                            <div>
                                <span className="field-label">
                                    영상 미리보기
                                </span>
                                <h2 id="preview-title">{previewVideo.title}</h2>
                            </div>
                            <button
                                type="button"
                                className="preview-close"
                                onClick={() => setPreviewVideo(null)}
                                aria-label="미리보기 닫기"
                            >
                                ×
                            </button>
                        </div>
                        {previewVideo.embeddable ? (
                            <div
                                className={`preview-frame ${previewVideo.format === 'shorts' ? 'preview-shorts' : ''}`}
                            >
                                <iframe
                                    src={`https://www.youtube-nocookie.com/embed/${previewVideo.videoId}?autoplay=1&start=${previewStart}`}
                                    title={previewVideo.title}
                                    allow="accelerometer; autoplay; encrypted-media; gyroscope; picture-in-picture; web-share"
                                    allowFullScreen
                                />
                            </div>
                        ) : (
                            <p className="preview-unavailable">
                                이 영상은 대시보드 안에서 재생할 수 없습니다.
                            </p>
                        )}
                        <div className="preview-actions">
                            <span>재생이 제한되면 유튜브에서 확인하세요.</span>
                            <a
                                href={previewVideo.url}
                                target="_blank"
                                rel="noreferrer"
                            >
                                유튜브에서 보기
                            </a>
                        </div>
                    </div>
                </div>
            )}
        </main>
    )
}

export default App
