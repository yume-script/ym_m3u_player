// plugins/metadata/m3u_player/script.js
(function () {
    // m3u_player.py의 id와 반드시 일치해야 한다 (API 경로에 사용)
    const PLUGIN_ID = 'ym_m3u_player';
    // 이 플러그인 설정은 라이브러리 스코프와 무관한 전역 값이므로 조회/저장 모두
    // 항상 "general"로 고정한다 (m3u_player.py의 CONFIG_SCOPE와 반드시 일치해야 함).
    const CONFIG_SCOPE = 'general';

    let isInitialized = false;
    // 소스 저장(POST /api/media/books/0/apply-metadata)은 서버에서 @admin_required이지만,
    // 이 카테고리탭 자체는 관리자가 아닌 사용자에게도 권한 매트릭스로 노출될 수 있다.
    // 그런 경우 예전에는 "소스 관리" 버튼이 무조건 노출되어, 일반 사용자가 값을 입력하고
    // 저장을 누른 뒤에야 403으로 실패하는 것을 알 수 있었다. 아래 플래그로 관리자 여부를
    // 미리 가볍게 판별해 버튼을 비활성화하고 이유를 안내한다.
    // 판별 자체가 실패(네트워크 오류 등)하면 기존 동작을 그대로 유지하기 위해 기본값은 true로 둔다.
    let isAdmin = true;
    let hlsInstance = null;
    let mpegtsPlayer = null;
    let allChannels = [];
    let activeChannel = null;
    let epgProgrammes = {};
    let favorites = new Set(JSON.parse(localStorage.getItem('m3u_fav_channels') || '[]'));

    let channelHealth = JSON.parse(sessionStorage.getItem('m3u_channel_health') || '{}');
    let isHealthChecking = false;

    let timerInterval = null;
    let osdTimeout = null;

    // 🪟 미니창(Document Picture-in-Picture) 상태.
    // - docPipWindow: window.documentPictureInPicture.requestWindow()로 연 별도 창.
    //   비디오 엘리먼트 자체를 이 창의 document로 옮겨서(reparent) hls.js/mpegts.js
    //   인스턴스를 새로 만들지 않고 그대로 이어서 재생한다.
    // - miniChannelBarEl: 미니창 안에 표시하는 채널명 바 (채널 전환 시 갱신됨).
    // - 브라우저가 documentPictureInPicture API를 지원하지 않으면 videoEl의
    //   네이티브 requestPictureInPicture()로 자동 대체한다.
    let docPipWindow = null;
    let miniChannelBarEl = null;

    // 직전 채널이 프록시까지 실패해서 최종 오프라인 판정이 났을 때 true로 세팅된다.
    // 실제 <video> 엘리먼트 교체(recreateVideoElement)는 여기서 바로 하지 않고, 다음
    // playStream() 시작 시점에 동기적으로(그 채널의 어떤 재생 시도보다도 먼저) 수행해서
    // "교체 타이밍과 다음 채널 선택 타이밍이 꼬이는" 레이스를 원천적으로 없앤다.
    let videoNeedsRecreate = false;

    // 이 카테고리탭 화면이 DOM에서 제거되는 순간(다른 사이드바 메뉴로 이동)을 감시하는 옵저버.
    let navigationObserver = null;

    // 재생을 시도할 때마다 1씩 증가하는 토큰. HLS 에러/프록시 재시도 같은 비동기 콜백이
    // 나중에 뒤늦게 도착했을 때, 그 사이 채널이 바뀌어 이미 낡은 시도가 됐는지 판별하는 데 쓴다.
    // (activeChannel 객체 비교만으로는 전역 hlsInstance/mpegtsPlayer를 공유하는 콜백들의
    // 경합을 완전히 막지 못해, 실패한 이전 채널의 뒤늦은 콜백이 방금 재생을 시작한
    // 새 채널의 인스턴스를 잘못 건드리는 버그가 있었다.)
    let playToken = 0;

    // 기본 5개 세트 정의 (서버/로컬 모두 조회 실패할 때의 최종 폴백)
    let sourceSlots = [
        { enabled: true, name: '개인', m3u: '', epg: '' },
        { enabled: false, name: 'iptv-org', m3u: 'https://iptv-org.github.io/iptv/countries/kr.m3u', epg: 'https://iptv-org.github.io/epg/guides/kr.xml' },
        { enabled: false, name: 'FAST', m3u: '', epg: '' },
        { enabled: false, name: '세트 4', m3u: '', epg: '' },
        { enabled: false, name: '세트 5', m3u: '', epg: '' }
    ];

    // DOM Elements
    let videoEl = document.getElementById('m3uVideoPlayer');
    const videoWrapperEl = document.getElementById('m3uVideoWrapper');
    const overlayEl = document.getElementById('m3uPlayerOverlay');
    const overlayText = document.getElementById('m3uOverlayText');
    const channelListEl = document.getElementById('m3uChannelList');
    const channelCountEl = document.getElementById('m3uChannelCount');
    const groupSelectEl = document.getElementById('m3uGroupSelect');
    const searchInput = document.getElementById('m3uSearchInput');
    const epgStatusEl = document.getElementById('m3uEpgStatus');
    const activeSourcesBar = document.getElementById('m3uActiveSourcesBar');
    const onlyOnlineToggle = document.getElementById('m3uOnlyOnlineToggle');
    const healthCheckBtn = document.getElementById('m3uHealthCheckBtn');

    // Modals
    const openSourceModalBtn = document.getElementById('m3uOpenSourceModalBtn');
    const closeSourceModalBtn = document.getElementById('m3uCloseSourceModalBtn');
    const sourceModal = document.getElementById('m3uSourceModal');
    const sourceSlotsContainer = document.getElementById('m3uSourceSlotsContainer');
    const saveSourcesBtn = document.getElementById('m3uSaveSourcesBtn');
    const reloadAllBtn = document.getElementById('m3uReloadAllBtn');

    // Playing Info Elements
    const currentTitleEl = document.getElementById('m3uCurrentChannelTitle');
    const currentGroupEl = document.getElementById('m3uCurrentChannelGroup');
    const engineBadgeEl = document.getElementById('m3uStreamEngineBadge');
    const currentProgTitleEl = document.getElementById('m3uCurrentProgramTitle');
    const currentProgTimeEl = document.getElementById('m3uCurrentProgramTime');
    const progressBarEl = document.getElementById('m3uProgressBar');
    const progressPercentEl = document.getElementById('m3uProgressPercent');
    const remainingTimeEl = document.getElementById('m3uRemainingTime');
    const nextProgTextEl = document.getElementById('m3uNextProgramText');
    const currentFavIcon = document.getElementById('m3uCurrentFavIcon');
    const favCurrentBtn = document.getElementById('m3uFavCurrentBtn');
    const miniWindowBtn = document.getElementById('m3uMiniWindowBtn');

    // TV OSD Elements
    const tvOsdEl = document.getElementById('m3uTvOsd');
    const osdLogoEl = document.getElementById('m3uOsdLogo');
    const osdFallbackIcon = document.getElementById('m3uOsdFallbackIcon');
    const osdChannelName = document.getElementById('m3uOsdChannelName');
    const osdGroupName = document.getElementById('m3uOsdGroupName');
    const osdProgTitle = document.getElementById('m3uOsdProgTitle');
    const osdProgTime = document.getElementById('m3uOsdProgTime');
    const osdProgressBar = document.getElementById('m3uOsdProgressBar');
    const osdProgressMeta = document.getElementById('m3uOsdProgressMeta');
    const osdNextProg = document.getElementById('m3uOsdNextProg');

    // Schedule Modal
    const scheduleModal = document.getElementById('m3uScheduleModal');
    const openScheduleBtn = document.getElementById('m3uOpenScheduleBtn');
    const closeModalBtn = document.getElementById('m3uCloseModalBtn');
    const scheduleListEl = document.getElementById('m3uScheduleList');
    const scheduleTitleEl = document.getElementById('m3uScheduleTitle');

    async function init() {
        if (isInitialized) return;
        isInitialized = true;

        bindEvents();
        updateMiniWindowButtonState();
        setupNavigationCleanupObserver();
        detectAdminAccess(); // 결과가 오는 대로 비동기로 버튼 상태를 갱신 (초기 렌더를 막지 않음)

        if (timerInterval) clearInterval(timerInterval);
        timerInterval = setInterval(updateLiveProgress, 1000);

        // 1순위: 서버(관리자 설정 화면 = config_schema)에 저장된 값을 우선 사용
        const serverSlots = await loadSourceSlotsFromServer();
        if (serverSlots) {
            sourceSlots = serverSlots;
        } else {
            // 서버 조회 자체가 실패했을 때만 브라우저 로컬 백업값으로 폴백
            const saved = localStorage.getItem('m3u_source_slots_v2');
            if (saved) {
                try {
                    const parsed = JSON.parse(saved);
                    if (Array.isArray(parsed) && parsed.length > 0) {
                        sourceSlots = parsed;
                    }
                } catch (e) {}
            }
        }

        // 전체 소스 로드
        loadAllSources();
    }

    // 관리자 설정 화면(config_schema)과 동일한 저장소를 GET /api/media/dashboard/widgets/{id}/data 로 조회
    async function loadSourceSlotsFromServer() {
        try {
            const res = await fetch(`/api/media/dashboard/widgets/${PLUGIN_ID}/data?type=${CONFIG_SCOPE}`);
            if (!res.ok) throw new Error(`HTTP ${res.status}`);
            const data = await res.json();
            if (data && data.success === false) throw new Error(data.error || 'success:false');
            if (data && Array.isArray(data.slots) && data.slots.length > 0) {
                return data.slots;
            }
            return null;
        } catch (e) {
            console.warn('[M3UPlayer] 서버 설정 조회 실패, 로컬 백업값을 사용합니다:', e.message);
            return null;
        }
    }

    // 관리자 세션인지 가볍게 판별한다. 전용 "내가 관리자인지" API가 코어에 없어서,
    // 이미 admin_required로 보호된 기존 엔드포인트(/api/media/metadata/plugins/manage,
    // GET) 하나를 프로브로 재사용한다 — 데이터를 쓰지 않는 조회이고 이 플러그인의
    // 소스 설정 저장 API(/api/media/books/0/apply-metadata)와 동일한 admin_required
    // 데코레이터를 쓰므로, 이 프로브가 성공/실패하는지가 곧 소스 저장 가능 여부와 같다.
    async function detectAdminAccess() {
        try {
            const res = await fetch('/api/media/metadata/plugins/manage', { method: 'GET' });
            isAdmin = !(res.status === 401 || res.status === 403);
        } catch (e) {
            // 판별 자체가 실패(네트워크 오류 등)했다면 기존 동작을 유지한다(버튼 노출 유지).
        }
        applyAdminUiState();
    }

    function applyAdminUiState() {
        if (!openSourceModalBtn) return;
        openSourceModalBtn.disabled = !isAdmin;
        openSourceModalBtn.title = isAdmin ? '' : '소스 설정 변경은 관리자 계정만 가능합니다.';
        openSourceModalBtn.classList.toggle('m3u-disabled-hint', !isAdmin);
    }

    // 방송사 로고/썸네일 등 외부 도메인 이미지를 로컬 캐시 경유로 서빙하는 URL을 만든다.
    // /api/webview/logo-cache는 화이트리스트 등록이 필요 없고(위험도가 낮은 이미지 전용),
    // 서버가 URL당 최초 1회만 원본을 받아 WebP로 변환해 로컬 캐싱한 뒤 그대로 서빙한다.
    // mixed-content(https 페이지에서 http 이미지)나 로고 도메인의 hotlink 차단도 함께 우회된다.
    function logoCacheUrl(rawUrl) {
        if (!rawUrl) return '';
        return `/api/webview/logo-cache?url=${encodeURIComponent(rawUrl)}`;
    }

    // 📺 다른 사이드바 메뉴로 이동하면(=이 카테고리탭이 DOM에서 제거되거나, class/style로 숨겨지면)
    // 재생을 정지한다. 단, 사용자가 PIP(Picture-in-Picture)로 이 영상을 띄워둔 상태라면 정지하지 않고
    // 그대로 유지하며, 사용자가 PIP 창을 직접 닫는 시점(leavepictureinpicture)에 비로소 정리한다.
    // BookOasis SPA가 탭을 전환할 때 이 컨테이너를 정확히 어떻게 처리하는지(완전 제거 vs class/style로
    // 숨김) 문서화돼 있지 않아, 두 가지 경우를 모두 잡는 범용적인 방식을 쓴다:
    //  1) childList 변화 -> 컨테이너 자체가 DOM에서 완전히 제거되는 경우
    //  2) class/style 속성 변화 -> 컨테이너 자신 또는 조상 엘리먼트에 hidden 처리(예: display:none,
    //     visibility:hidden, "hidden" 류 클래스)가 적용되는 경우
    function isHiddenFromView(el) {
        if (!document.body.contains(el)) return true; // 완전히 제거됨

        let node = el;
        while (node && node !== document.body) {
            const cs = getComputedStyle(node);
            if (cs.display === 'none' || cs.visibility === 'hidden') return true;
            node = node.parentElement;
        }
        // display:none/visibility:hidden이 아니어도 offsetParent가 null이면(대부분의 경우)
        // 화면에 렌더링되지 않는 상태로 간주한다 (position:fixed 엘리먼트는 예외 처리).
        if (el.offsetParent === null && getComputedStyle(el).position !== 'fixed') return true;
        return false;
    }

    function setupNavigationCleanupObserver() {
        const rootEl = document.querySelector('.m3u-root');
        if (!rootEl || !rootEl.parentNode) return;

        const checkAndHandle = () => {
            if (isHiddenFromView(rootEl)) {
                handleContainerRemoved();
            }
        };

        navigationObserver = new MutationObserver(checkAndHandle);
        navigationObserver.observe(document.body, {
            childList: true,
            subtree: true,
            attributes: true,
            attributeFilter: ['class', 'style']
        });
    }

    function handleContainerRemoved() {
        if (navigationObserver) { navigationObserver.disconnect(); navigationObserver = null; }

        if (document.pictureInPictureElement === videoEl) {
            // 네이티브 PIP로 재생 중이면 그대로 유지하고, 사용자가 PIP를 닫는 시점에 정리한다.
            videoEl.addEventListener('leavepictureinpicture', stopPlaybackForNavigation, { once: true });
            return;
        }

        if (docPipWindow && !docPipWindow.closed) {
            // 미니창(Document PIP)이 열려있는 동안은 다른 사이드바 메뉴로 이동해도 재생을
            // 유지한다. 미니창을 닫을 때의 뒷정리는 attachDocPipCloseHandler()의
            // pagehide 리스너가 담당한다(그 시점에 이 컨테이너가 여전히 숨겨져 있다면
            // stopPlaybackForNavigation()을 호출한다).
            return;
        }

        stopPlaybackForNavigation();
    }

    // 🩹 알려진 브라우저 MSE(hls.js/mpegts.js) 버그 대응: 어떤 <video> 엘리먼트에 붙였던
    // MediaSource가 네트워크 오류(예: /api/webview/hls-proxy가 403/차단으로 스트림을 내려주지
    // 못하는 경우) 등으로 fatal 상태에 빠지면, 일부 브라우저는 그 "같은" video 엘리먼트에
    // 새 소스를 다시 붙여도 디코더 파이프라인이 복구되지 않고 계속 재생에 실패한다
    // (destroy()/removeAttribute('src')/load()로 우리 쪽 상태는 다 정리해도, 브라우저 내부
    // 디코더 자체가 망가진 채로 남는 경우). 지금까지 보고된 "실패한 채널을 고르면 그 다음부터
    // 잘 나오던 채널도 안 나오고 Ctrl+F5를 해야 풀리는" 증상이 바로 이 케이스로 보인다.
    // 근본 대응으로, 최종 실패(프록시까지 실패해 완전히 오프라인 판정)가 나면 <video> 엘리먼트
    // 자체를 새 노드로 교체해 다음 채널 재생부터는 깨끗한 디코더로 시작하게 한다.
    // 네이티브 PIP나 미니창(Document PIP)에 올라가 있는 동안은 노드를 통째로 바꾸면 그 세션
    // 자체가 끊어지므로 건드리지 않는다.
    function recreateVideoElement() {
        if (!videoEl || !videoEl.parentNode) return;
        if (document.pictureInPictureElement === videoEl) return;
        if (docPipWindow && !docPipWindow.closed) return;

        const parent = videoEl.parentNode;
        const nextSibling = videoEl.nextSibling;
        const wasMuted = videoEl.muted;

        const fresh = document.createElement('video');
        fresh.id = videoEl.id;
        fresh.controls = true;
        fresh.playsInline = true;
        fresh.muted = wasMuted;

        parent.insertBefore(fresh, nextSibling);
        parent.removeChild(videoEl);
        videoEl = fresh;
    }

    // hlsInstance/mpegtsPlayer 인스턴스를 안전하게 정리한다. 각 단계를 개별 try/catch로 감싸서,
    // 이전 재생 시도가 실패로 반쯤 깨진 상태로 남겨둔 인스턴스를 정리하다가 예외가 나더라도
    // 호출자(playStream/stopPlaybackForNavigation)가 절대 중간에 멈추지 않도록 보장한다.
    // (과거에는 이 정리 코드가 예외를 던지면 playStream() 전체가 멈춰서, 이후 어떤 채널을
    // 선택해도 재생이 시작되지 않고 하드 리프레시를 해야만 풀리는 문제가 있었다.)
    function destroyPlayers() {
        if (hlsInstance) {
            try { hlsInstance.destroy(); } catch (e) { console.warn('[M3UPlayer] hlsInstance 정리 중 오류(무시하고 계속 진행):', e); }
            hlsInstance = null;
        }
        if (mpegtsPlayer) {
            try { mpegtsPlayer.pause(); } catch (e) { /* ignore */ }
            try { mpegtsPlayer.unload(); } catch (e) { /* ignore */ }
            try { mpegtsPlayer.detachMediaElement(); } catch (e) { /* ignore */ }
            try { mpegtsPlayer.destroy(); } catch (e) { console.warn('[M3UPlayer] mpegtsPlayer 정리 중 오류(무시하고 계속 진행):', e); }
            mpegtsPlayer = null;
        }
    }

    function stopPlaybackForNavigation() {
        destroyPlayers();
        try { videoEl.pause(); } catch (e) {}
        videoEl.removeAttribute('src');
        videoEl.load();

        if (timerInterval) { clearInterval(timerInterval); timerInterval = null; }

        playToken++; // 진행 중이던 재생/프록시 재시도 시도를 전부 무효화
        activeChannel = null;
    }

    function bindEvents() {
        openSourceModalBtn.addEventListener('click', openSourceModal);
        closeSourceModalBtn.addEventListener('click', () => sourceModal.classList.add('hidden'));
        saveSourcesBtn.addEventListener('click', saveSourcesFromModal);
        reloadAllBtn.addEventListener('click', loadAllSources);
        healthCheckBtn.addEventListener('click', startHealthCheckBatch);

        searchInput.addEventListener('input', renderFilteredChannels);
        groupSelectEl.addEventListener('change', renderFilteredChannels);
        onlyOnlineToggle.addEventListener('change', renderFilteredChannels);

        favCurrentBtn.addEventListener('click', toggleCurrentFavorite);
        miniWindowBtn.addEventListener('click', toggleMiniWindow);
        openScheduleBtn.addEventListener('click', openScheduleView);
        closeModalBtn.addEventListener('click', () => scheduleModal.classList.add('hidden'));

        window.addEventListener('keydown', handleKeyboardShortcuts);
    }

    function handleKeyboardShortcuts(e) {
        if (['INPUT', 'SELECT', 'TEXTAREA'].includes(document.activeElement.tagName)) return;
        if (e.key === 'ArrowDown') { e.preventDefault(); switchChannelRelative(1); }
        else if (e.key === 'ArrowUp') { e.preventDefault(); switchChannelRelative(-1); }
        else if (e.key === 'f' || e.key === 'F') {
            if (!document.fullscreenElement) videoEl.requestFullscreen().catch(() => {});
            else document.exitFullscreen().catch(() => {});
        }
    }

    function switchChannelRelative(offset) {
        if (!allChannels.length || !activeChannel) return;
        const curIdx = allChannels.findIndex(c => c === activeChannel);
        if (curIdx === -1) return;
        let newIdx = (curIdx + offset + allChannels.length) % allChannels.length;
        // 키보드 조작은 사용자 제스처이므로 음소거 없이 재생
        playStream(allChannels[newIdx], false);
    }

    function toggleCurrentFavorite() {
        if (!activeChannel) return;
        const id = activeChannel.id || activeChannel.name;
        if (favorites.has(id)) favorites.delete(id);
        else favorites.add(id);
        localStorage.setItem('m3u_fav_channels', JSON.stringify(Array.from(favorites)));
        updateFavIcon();
        renderFilteredChannels();
    }

    function updateFavIcon() {
        if (!activeChannel) return;
        const id = activeChannel.id || activeChannel.name;
        currentFavIcon.className = favorites.has(id) ? 'fa-solid fa-star' : 'fa-regular fa-star';
    }

    // ------------------------------------------------------------------
    // 🪟 미니창(Document Picture-in-Picture)
    // ------------------------------------------------------------------
    // 버튼 클릭 시: 이미 열려있으면 닫고, 아니면 새로 연다.
    async function toggleMiniWindow() {
        if (docPipWindow && !docPipWindow.closed) {
            docPipWindow.close(); // 뒷정리는 attachDocPipCloseHandler()의 pagehide에서 처리
            return;
        }
        if (!activeChannel) {
            alert('먼저 채널을 선택해주세요.');
            return;
        }
        await openMiniWindow();
    }

    async function openMiniWindow() {
        if (!videoWrapperEl) return;

        // Document Picture-in-Picture API (Chromium 116+ 등): 비디오뿐 아니라 채널명
        // 같은 임의의 DOM도 함께 담을 수 있는 항상-위(always-on-top) 미니창을 만든다.
        // 지원하지 않는 브라우저에서는 네이티브 <video> PIP로 자동 대체한다.
        if (window.documentPictureInPicture && typeof window.documentPictureInPicture.requestWindow === 'function') {
            try {
                const pipWindow = await window.documentPictureInPicture.requestWindow({
                    width: 400,
                    height: 260,
                });

                // 미니창은 호스트 페이지의 CSS를 상속하지 않으므로 최소한의 인라인
                // 스타일만 직접 주입한다 (플레이어 전체 스타일시트를 옮기는 대신
                // 검게 채우기 + 하단 채널명 바 + 좌우 채널 이동 버튼만 구성).
                const style = pipWindow.document.createElement('style');
                style.textContent = `
                    html, body { margin: 0; padding: 0; height: 100%; background: #000; overflow: hidden; }
                    #m3uMiniVideoWrap { position: relative; width: 100%; height: 100%; }
                    #m3uMiniVideoWrap video { width: 100%; height: 100%; object-fit: contain; background: #000; }
                    #m3uMiniChannelBar {
                        position: absolute; left: 0; right: 0; bottom: 0;
                        padding: 4px 44px; font: 12px -apple-system, BlinkMacSystemFont, sans-serif;
                        color: #fff; background: rgba(0, 0, 0, 0.55);
                        white-space: nowrap; overflow: hidden; text-overflow: ellipsis;
                        text-align: center;
                    }
                    .m3u-mini-nav-btn {
                        position: absolute; top: 50%; transform: translateY(-50%);
                        width: 32px; height: 32px; border-radius: 50%; border: none;
                        background: rgba(0, 0, 0, 0.4); color: #fff; font-size: 14px;
                        cursor: pointer; opacity: 0.35; transition: opacity 0.15s ease;
                        display: flex; align-items: center; justify-content: center;
                    }
                    #m3uMiniVideoWrap:hover .m3u-mini-nav-btn { opacity: 0.85; }
                    .m3u-mini-nav-btn:hover { opacity: 1 !important; background: rgba(0, 0, 0, 0.65); }
                    .m3u-mini-prev { left: 6px; }
                    .m3u-mini-next { right: 6px; }
                `;
                pipWindow.document.head.appendChild(style);

                const wrap = pipWindow.document.createElement('div');
                wrap.id = 'm3uMiniVideoWrap';
                const bar = pipWindow.document.createElement('div');
                bar.id = 'm3uMiniChannelBar';
                bar.textContent = activeChannel ? activeChannel.name : '';
                wrap.appendChild(bar);

                // 좌/우 채널 이동 버튼: 미니창에는 채널 목록이 안 보이므로 최소한
                // 위/아래(이전/다음) 채널 전환만이라도 가능하게 한다. 기존
                // switchChannelRelative()를 그대로 재사용한다 (JS 실행 컨텍스트는
                // 미니창이 아니라 원래 문서의 것이므로 클로저 함수를 그대로 쓸 수 있다).
                const prevBtn = pipWindow.document.createElement('button');
                prevBtn.type = 'button';
                prevBtn.className = 'm3u-mini-nav-btn m3u-mini-prev';
                prevBtn.setAttribute('aria-label', '이전 채널');
                prevBtn.textContent = '◀';
                prevBtn.addEventListener('click', () => switchChannelRelative(-1));

                const nextBtn = pipWindow.document.createElement('button');
                nextBtn.type = 'button';
                nextBtn.className = 'm3u-mini-nav-btn m3u-mini-next';
                nextBtn.setAttribute('aria-label', '다음 채널');
                nextBtn.textContent = '▶';
                nextBtn.addEventListener('click', () => switchChannelRelative(1));

                wrap.appendChild(prevBtn);
                wrap.appendChild(nextBtn);
                pipWindow.document.body.appendChild(wrap);

                // 미니창이 포커스를 가진 상태에서는 키 입력이 원래 문서(main window)로
                // 전달되지 않으므로, 미니창 자체에도 ↑/↓ 채널 전환 단축키를 별도로 건다.
                pipWindow.addEventListener('keydown', (e) => {
                    if (e.key === 'ArrowDown') { e.preventDefault(); switchChannelRelative(1); }
                    else if (e.key === 'ArrowUp') { e.preventDefault(); switchChannelRelative(-1); }
                });

                // 실제 <video> 엘리먼트를 미니창으로 옮긴다. 새로 만들지 않고 노드
                // 자체를 reparent하므로 붙어있던 hls.js/mpegts.js 인스턴스가 끊기지
                // 않고 그대로 이어서 재생된다.
                wrap.prepend(videoEl);

                miniChannelBarEl = bar;
                docPipWindow = pipWindow;
                updateMiniWindowButtonState();
                attachDocPipCloseHandler(pipWindow);
                setOverlay('🎬 미니창에서 재생 중입니다.', true);
            } catch (e) {
                console.warn('[M3UPlayer] 미니창 열기 실패, 네이티브 PIP로 대체합니다:', e && e.message);
                await fallbackToNativePip();
            }
            return;
        }

        await fallbackToNativePip();
    }

    async function fallbackToNativePip() {
        if (!videoEl.requestPictureInPicture) {
            alert('이 브라우저는 미니창(PIP) 기능을 지원하지 않습니다.');
            return;
        }
        try {
            await videoEl.requestPictureInPicture();
        } catch (e) {
            alert('미니창을 여는 데 실패했습니다: ' + (e && e.message ? e.message : e));
        }
    }

    // 미니창이 닫힐 때(사용자가 창을 직접 닫거나 close()를 호출한 경우) 비디오를
    // 원래 자리로 되돌린다. 이 시점에 카테고리탭 자체가 이미 화면에서 사라진
    // 상태였다면(=다른 사이드바 메뉴로 이동한 뒤 미니창만 닫은 경우) 재생을 완전히
    // 정리하고, 여전히 화면에 보이는 상태라면 이어서 일반 인라인 재생으로 보여준다.
    function attachDocPipCloseHandler(pipWindow) {
        pipWindow.addEventListener('pagehide', () => {
            if (videoWrapperEl && videoEl.parentNode !== videoWrapperEl) {
                videoWrapperEl.prepend(videoEl);
            }
            docPipWindow = null;
            miniChannelBarEl = null;
            updateMiniWindowButtonState();

            const rootEl = document.querySelector('.m3u-root');
            if (!rootEl || isHiddenFromView(rootEl)) {
                stopPlaybackForNavigation();
            } else if (activeChannel) {
                setOverlay('', false);
            }
        }, { once: true });
    }

    function updateMiniWindowButtonState() {
        if (!miniWindowBtn) return;
        const isOpen = !!(docPipWindow && !docPipWindow.closed);
        miniWindowBtn.innerHTML = isOpen
            ? '<i class="fa-solid fa-window-close"></i> 미니창 닫기'
            : '<i class="fa-solid fa-clone"></i> 미니창';
        miniWindowBtn.title = isOpen ? '미니창을 닫고 원래 화면으로 되돌리기' : '미니창(PIP)으로 분리해서 보기';
    }

    // 소스 관리 모달 열기
    function openSourceModal() {
        if (!isAdmin) {
            alert('소스 설정 변경은 관리자 계정만 가능합니다.');
            return;
        }
        sourceSlotsContainer.innerHTML = '';
        sourceSlots.forEach((slot, i) => {
            const card = document.createElement('div');
            card.className = 'm3u-source-slot-card';
            card.innerHTML = `
                <div class="m3u-slot-header">
                    <label class="m3u-slot-enable-wrap">
                        <input type="checkbox" id="slot_enable_${i}" ${slot.enabled ? 'checked' : ''}>
                        <span>세트 ${i + 1}</span>
                    </label>
                    <input type="text" id="slot_name_${i}" class="m3u-input m3u-slot-name-input" value="${escapeHtml(slot.name || `세트 ${i+1}`)}" placeholder="태그">
                </div>
                <div class="m3u-slot-url-row">
                    <input type="text" id="slot_m3u_${i}" class="m3u-input" value="${escapeHtml(slot.m3u || '')}" placeholder="M3U URL (http://...)">
                </div>
                <div class="m3u-slot-url-row">
                    <input type="text" id="slot_epg_${i}" class="m3u-input" value="${escapeHtml(slot.epg || '')}" placeholder="EPG XML URL (선택)">
                </div>
            `;
            sourceSlotsContainer.appendChild(card);
        });
        sourceModal.classList.remove('hidden');
    }

    function escapeHtml(str) {
        // '&'를 가장 먼저 치환해야 한다 (뒤에서 만든 &quot; 등의 엔티티를 다시
        // 이스케이프해버리는 것을 방지).
        return (str || '')
            .replace(/&/g, '&amp;')
            .replace(/"/g, '&quot;')
            .replace(/</g, '&lt;')
            .replace(/>/g, '&gt;');
    }

    // 소스 관리 모달 저장: 관리자 설정 화면(config_schema)과 동일한 저장소에
    // POST /api/media/books/0/apply-metadata -> apply() 를 통해 반영한다.
    async function saveSourcesFromModal() {
        if (!isAdmin) {
            alert('소스 설정 변경은 관리자 계정만 가능합니다.');
            return;
        }
        for (let i = 0; i < 5; i++) {
            const enableEl = document.getElementById(`slot_enable_${i}`);
            const nameEl = document.getElementById(`slot_name_${i}`);
            const m3uEl = document.getElementById(`slot_m3u_${i}`);
            const epgEl = document.getElementById(`slot_epg_${i}`);

            sourceSlots[i] = {
                enabled: enableEl ? enableEl.checked : false,
                name: nameEl ? nameEl.value.trim() : `세트 ${i + 1}`,
                m3u: m3uEl ? m3uEl.value.trim() : '',
                epg: epgEl ? epgEl.value.trim() : ''
            };
        }

        // 서버 저장 실패 시를 대비한 로컬 백업
        localStorage.setItem('m3u_source_slots_v2', JSON.stringify(sourceSlots));

        const originalBtnHtml = saveSourcesBtn.innerHTML;
        saveSourcesBtn.disabled = true;
        saveSourcesBtn.innerHTML = '<i class="fa-solid fa-spinner fa-spin"></i> 저장 중...';

        try {
            const res = await fetch('/api/media/books/0/apply-metadata', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({
                    type: CONFIG_SCOPE,
                    source: PLUGIN_ID,
                    item_data: { action: 'save_sources', slots: sourceSlots }
                })
            });
            if (res.status === 401 || res.status === 403) {
                isAdmin = false;
                applyAdminUiState();
                throw new Error('권한이 없습니다 (관리자 계정만 소스 설정을 저장할 수 있습니다).');
            }
            const result = await res.json().catch(() => null);
            if (!res.ok || (result && result.success === false)) {
                throw new Error((result && result.message) || `HTTP ${res.status}`);
            }
            sourceModal.classList.add('hidden');
            loadAllSources();
            alert('M3U 소스 설정이 저장되었습니다. (관리자 설정 화면에도 동일하게 반영됩니다)');
        } catch (e) {
            console.error('[M3UPlayer] 서버 설정 저장 실패:', e.message);
            sourceModal.classList.add('hidden');
            loadAllSources();
            alert(`서버 저장에 실패했습니다 (${e.message}).\n이 브라우저에만 임시로 저장된 상태이니, 다른 기기/새로고침 후에는 사라질 수 있습니다.`);
        } finally {
            saveSourcesBtn.disabled = false;
            saveSourcesBtn.innerHTML = originalBtnHtml;
        }
    }

    // fetch에 타임아웃을 건다. 브라우저 fetch()는 기본적으로 타임아웃이 없어서, 응답이
    // 없는(사설 IP라 연결은 되는데 응답이 없는 등) 소스 하나가 전체 로딩을 수십 초~수 분간
    // 붙잡고 있을 수 있다 — "화면이 늦게 뜬다"는 문제의 주 원인 중 하나였다.
    async function fetchWithTimeout(url, options, timeoutMs) {
        const controller = new AbortController();
        const timer = setTimeout(() => controller.abort(), timeoutMs);
        try {
            return await fetch(url, { ...options, signal: controller.signal });
        } finally {
            clearTimeout(timer);
        }
    }

    const TEXT_FETCH_TIMEOUT_MS = 8000; // M3U/EPG 텍스트 조회 1회 시도당 최대 대기 시간

    // 📄 텍스트 파일(M3U/EPG) 조회: 직접 fetch를 우선 시도하고, 실패하면
    // 코어가 제공하는 window.BookOasisPlugin.getProxyUrl()(/api/webview/proxy 경유)로 재시도한다.
    // (공개 CORS 우회 프록시를 쓰지 않는다 — 등록한 URL이 외부 제3자 서버로 전달되지 않도록
    // 코어 자체 프록시만 사용한다.)
    // /api/webview/proxy는 응답 전체를 메모리에 15MB까지만 캡해서 읽으므로, 아주 큰(수십MB) EPG XML은
    // 직접 fetch가 안 되는 환경에서 프록시로도 잘릴 수 있다(413 응답 초과 에러).
    // getProxyUrl 자체는 화이트리스트 검증에 실패하면 자체적으로 토스트 안내를 띄우고 null을 반환하므로
    // 여기서는 별도 알림 없이 실패로 처리하되, 프록시가 반환하는 {"success":false,"error":...,"message":...}
    // 형태의 에러 본문이 있으면 그 메시지를 그대로 노출한다(사설 IP 차단/응답 초과 등 원인을 알 수 있게).
    //
    // ⚠️ /api/webview/proxy는 이제 GET뿐 아니라 POST(바디 릴레이)도 지원한다(guide_plugins.md 갱신
    // 내용 참고, 요청 256KB/응답 1MB 캡). 원래 DRM 라이선스 요청처럼 "바디가 있는 POST가 필요한
    // 외부 API"를 위한 기능이라 대부분의 M3U/EPG 서버에는 해당되지 않지만, GET을 아예 거부(405)하는
    // 일부 사설 IPTV 패널(Xtream-Codes 계열 커스텀 API 등)을 위해 최후 수단으로 POST 릴레이도
    // 시도한다. 화이트리스트 차단(403)/응답 초과(413) 등 메서드와 무관한 오류는 POST로 바꿔도
    // 해결되지 않으므로 그 경우엔 즉시 원래 에러로 실패 처리한다.
    //
    // ⏱️ 각 시도(직접/GET 프록시/POST 프록시)마다 최대 TEXT_FETCH_TIMEOUT_MS(8초)만 기다린다.
    // 응답 없는(hang) 소스 하나 때문에 loadAllSources()의 Promise.allSettled 전체가 늦게
    // 끝나서 카테고리탭 진입 시 채널 목록이 늦게 뜨는 문제를 막기 위함이다.
    async function fetchTextWithCorsFallback(url) {
        try {
            const res = await fetchWithTimeout(url, undefined, TEXT_FETCH_TIMEOUT_MS);
            if (res.ok) return await res.text();
        } catch (e) {
            console.warn(`[M3UPlayer] Direct fetch failed for ${url}, trying core proxy (getProxyUrl)...`);
        }

        if (!(window.BookOasisPlugin && typeof window.BookOasisPlugin.getProxyUrl === 'function')) {
            throw new Error('CORS 차단 또는 서버 응답 없음');
        }

        const proxyUrl = await window.BookOasisPlugin.getProxyUrl(url);
        if (!proxyUrl) {
            throw new Error('CORS 차단 또는 서버 응답 없음');
        }

        // 1차: GET 릴레이 — 대부분의 M3U/EPG 서버는 이걸로 충분하다.
        let getStatus = null;
        let getErrBody = null;
        try {
            const res = await fetchWithTimeout(proxyUrl, undefined, TEXT_FETCH_TIMEOUT_MS);
            if (res.ok) return await res.text();
            getStatus = res.status;
            getErrBody = await res.json().catch(() => null);
        } catch (e) {
            getStatus = null; // 네트워크 자체 실패(타임아웃 포함) - 아래에서 POST로 계속 시도한다
        }

        // 메서드와 무관한 오류(화이트리스트 차단 403, 응답 초과 413, scheme 오류 400 등)는
        // POST로 재시도해도 동일하게 실패하므로 즉시 실패 처리한다.
        if (getStatus !== null && getStatus !== 405) {
            throw new Error((getErrBody && getErrBody.message) || `HTTP ${getStatus}`);
        }

        // 2차: POST 릴레이 (최후 수단)
        console.warn(`[M3UPlayer] GET 프록시 실패(status=${getStatus}), POST 릴레이로 재시도합니다: ${url}`);
        const postRes = await fetchWithTimeout(proxyUrl, { method: 'POST' }, TEXT_FETCH_TIMEOUT_MS);
        if (postRes.ok) return await postRes.text();
        const postErrBody = await postRes.json().catch(() => null);
        throw new Error((postErrBody && postErrBody.message) || `HTTP ${postRes.status}`);
    }

    // 전체 활성 소스 로드
    async function loadAllSources() {
        setOverlay('전체 M3U 소스를 불러오는 중...', true);
        activeSourcesBar.innerHTML = '';
        allChannels = [];
        epgProgrammes = {};

        const activeSlots = sourceSlots.filter(s => s.enabled && s.m3u && s.m3u.trim());

        if (activeSlots.length === 0) {
            setOverlay('활성화된 M3U 소스가 없습니다.\n[⚙️ 소스 관리]에서 주소를 등록하고 체크를 켜주세요.', true);
            channelCountEl.textContent = '0';
            channelListEl.innerHTML = '<div class="m3u-empty-state">활성화된 소스가 없습니다.</div>';
            return;
        }

        // 활성 뱃지
        activeSlots.forEach(s => {
            const badge = document.createElement('span');
            badge.className = 'm3u-source-tag';
            badge.textContent = `[${s.name}]`;
            activeSourcesBar.appendChild(badge);
        });

        // 1. EPG 병렬 로드
        const epgPromises = activeSlots.filter(s => s.epg && s.epg.trim()).map(s => loadEPGFile(s.epg.trim(), s.name));
        Promise.allSettled(epgPromises).then(results => {
            const successCount = results.filter(r => r.status === 'fulfilled' && r.value).length;
            epgStatusEl.textContent = successCount > 0 ? `EPG ${successCount}개 적용됨` : 'EPG 미적용';
            epgStatusEl.style.color = successCount > 0 ? '#10b981' : '#94a3b8';
            renderFilteredChannels();
            updateLiveProgress();
        });

        // 2. M3U 재생목록 로드 — 소스가 도착하는 대로 즉시 목록에 반영한다.
        // 예전에는 Promise.allSettled로 "모든" 소스가 끝날 때까지 기다린 뒤에야 화면에 한 번에
        // 렌더링했는데, 응답이 느리거나 없는(hang) 소스 하나 때문에 이미 다 받아온 다른 소스의
        // 채널까지 함께 늦게 표시되는 문제가 있었다(카테고리탭 진입 시 "화면이 늦게 뜬다"는 원인).
        let firstChannelAutoplayed = false;
        const rebuildGroupOptions = () => {
            const groups = new Set();
            allChannels.forEach(c => { if (c.group) groups.add(c.group); });
            const currentSelection = groupSelectEl.value;
            groupSelectEl.innerHTML = `
                <option value="">전체 그룹 (All)</option>
                <option value="__FAVORITES__">⭐ 즐겨찾기 채널</option>
            `;
            Array.from(groups).sort().forEach(g => {
                const opt = document.createElement('option');
                opt.value = g;
                opt.textContent = g;
                groupSelectEl.appendChild(opt);
            });
            // 다시 그리는 동안 사용자가 골라둔 그룹 필터가 남아있으면 유지한다.
            if (Array.from(groupSelectEl.options).some(o => o.value === currentSelection)) {
                groupSelectEl.value = currentSelection;
            }
        };

        const m3uPromises = activeSlots.map(s =>
            loadM3UFile(s.m3u.trim(), s.name).then(channels => {
                if (channels.length > 0) {
                    allChannels = allChannels.concat(channels);
                    channelCountEl.textContent = allChannels.length;
                    rebuildGroupOptions();
                    renderFilteredChannels();
                    setOverlay('채널을 선택하세요.', true);

                    if (!firstChannelAutoplayed && !activeChannel) {
                        firstChannelAutoplayed = true;
                        // 페이지 로드 직후의 자동재생은 사용자 제스처가 없으므로 음소거 상태로 시작
                        playStream(allChannels[0], true);
                    }
                }
                return channels;
            })
        );

        await Promise.allSettled(m3uPromises);

        if (allChannels.length === 0) {
            setOverlay('활성화된 소스에서 채널을 찾지 못했습니다.\n[⚙️ 소스 관리]에서 M3U 주소를 확인해주세요.', true);
        }
    }

    async function loadM3UFile(url, sourceName) {
        try {
            const text = await fetchTextWithCorsFallback(url);
            return parseM3U(text, sourceName);
        } catch (e) {
            console.error(`[M3UPlayer] M3U 로드 실패 (${sourceName}):`, e.message);
            return [];
        }
    }

    async function loadEPGFile(url, sourceName) {
        try {
            const xmlText = await fetchTextWithCorsFallback(url);
            parseXMLTV(xmlText);
            return true;
        } catch (e) {
            console.error(`[M3UPlayer] EPG 로드 실패 (${sourceName}):`, e.message);
            return false;
        }
    }

    function parseM3U(content, sourceName) {
        const lines = content.split(/\r?\n/);
        const channels = [];
        let currentInfo = null;

        for (let i = 0; i < lines.length; i++) {
            const line = lines[i].trim();
            if (!line) continue;

            if (line.startsWith('#EXTINF:')) {
                currentInfo = {
                    id: '',
                    name: '이름 없는 채널',
                    logo: '',
                    group: `[${sourceName}] 기타`,
                    sourceName: sourceName,
                    url: ''
                };

                const idMatch = line.match(/tvg-id="([^"]+)"/i);
                if (idMatch) currentInfo.id = idMatch[1].trim();

                const groupMatch = line.match(/group-title="([^"]+)"/i);
                if (groupMatch) currentInfo.group = `[${sourceName}] ${groupMatch[1]}`;

                const logoMatch = line.match(/tvg-logo="([^"]+)"/i);
                if (logoMatch) currentInfo.logo = logoMatch[1];

                const commaIdx = line.lastIndexOf(',');
                if (commaIdx !== -1) {
                    const name = line.substring(commaIdx + 1).trim();
                    if (name) currentInfo.name = name;
                }
                if (!currentInfo.id) currentInfo.id = `${sourceName}_${currentInfo.name}`;
            } else if (!line.startsWith('#') && currentInfo) {
                currentInfo.url = line;
                channels.push(currentInfo);
                currentInfo = null;
            }
        }
        return channels;
    }

    function parseXMLTV(xmlText) {
        const parser = new DOMParser();
        const xmlDoc = parser.parseFromString(xmlText, 'text/xml');
        const programmes = xmlDoc.getElementsByTagName('programme');

        for (let i = 0; i < programmes.length; i++) {
            const p = programmes[i];
            const chId = p.getAttribute('channel');
            const startStr = p.getAttribute('start');
            const stopStr = p.getAttribute('stop');
            const titleEl = p.getElementsByTagName('title')[0];
            const title = titleEl ? titleEl.textContent : '제목 없음';

            if (!chId || !startStr) continue;

            const start = parseXMLTVDate(startStr);
            const stop = stopStr ? parseXMLTVDate(stopStr) : null;

            if (!epgProgrammes[chId]) epgProgrammes[chId] = [];
            epgProgrammes[chId].push({ start, stop, title });
        }

        for (const k in epgProgrammes) {
            epgProgrammes[k].sort((a, b) => a.start - b.start);
        }
    }

    // XMLTV 날짜 파싱: "YYYYMMDDHHMMSS" 뒤에 옵션으로 "+HHMM"/"-HHMM" 타임존 오프셋이 붙을 수 있음.
    // 오프셋이 명시돼 있으면 그 값을 쓰고, 없으면 기존 동작(KST, +09:00)을 그대로 가정한다.
    function parseXMLTVDate(str) {
        if (!str) return new Date();
        const m = String(str).trim().match(/^(\d{4})(\d{2})(\d{2})(\d{2})(\d{2})(\d{2})(?:\s*([+-])(\d{2})(\d{2}))?$/);
        if (!m) return new Date();

        const [, y, mo, d, h, mi, s, sign, offH, offM] = m;
        const offsetMinutes = sign
            ? (parseInt(offH, 10) * 60 + parseInt(offM, 10)) * (sign === '-' ? -1 : 1)
            : 9 * 60; // 오프셋 미기재 시 기존과 동일하게 KST로 가정

        const utcMs = Date.UTC(
            Number(y), Number(mo) - 1, Number(d),
            Number(h), Number(mi), Number(s)
        ) - offsetMinutes * 60000;

        return new Date(utcMs);
    }

    function getEPGInfo(channel) {
        if (!channel) return { current: null, next: null, progress: 0, timeText: '', remainText: '' };
        const list = epgProgrammes[channel.id] || epgProgrammes[channel.name] || [];
        if (!list.length) return { current: null, next: null, progress: 0, timeText: '', remainText: '' };

        const now = new Date();
        let curIdx = list.findIndex(p => p.start <= now && (!p.stop || p.stop > now));
        if (curIdx === -1 && list.length > 0) curIdx = 0;

        const current = list[curIdx] || null;
        const next = list[curIdx + 1] || null;

        let progress = 0;
        let timeText = '--:-- ~ --:--';
        let remainText = '';

        if (current && current.start && current.stop) {
            const total = current.stop - current.start;
            const elapsed = now - current.start;
            progress = Math.max(0, Math.min(100, (elapsed / total) * 100));

            const sH = String(current.start.getHours()).padStart(2, '0');
            const sM = String(current.start.getMinutes()).padStart(2, '0');
            const eH = String(current.stop.getHours()).padStart(2, '0');
            const eM = String(current.stop.getMinutes()).padStart(2, '0');
            timeText = `${sH}:${sM} ~ ${eH}:${eM}`;

            const remainMin = Math.max(0, Math.round((current.stop - now) / 60000));
            remainText = `종료까지 약 ${remainMin}분 남음`;
        }

        return { current, next, progress, timeText, remainText };
    }

    // 🩺 사전 스트림 헬스체크: 직접 Range 조회를 우선 시도하고, CORS 등으로 실패하면
    // window.BookOasisPlugin.getStreamProxyUrl()을 통해 한 번 더 확인한다.
    // (직접 fetch만으로는 실제로는 재생 가능한 채널도 CORS 미허용 때문에 오프라인으로
    // 오탐될 수 있어서, 실제 재생 경로와 동일한 프록시 경유 확인을 추가한다.)
    async function checkChannelHealth(ch) {
        try {
            const controller = new AbortController();
            const timeoutId = setTimeout(() => controller.abort(), 2500);
            const res = await fetch(ch.url, { method: 'GET', signal: controller.signal, headers: { 'Range': 'bytes=0-50' } });
            clearTimeout(timeoutId);
            if (res.ok || res.status === 206) return 'online';
        } catch (e) {}

        if (window.BookOasisPlugin && typeof window.BookOasisPlugin.getStreamProxyUrl === 'function') {
            try {
                const proxyUrl = await window.BookOasisPlugin.getStreamProxyUrl(ch.url);
                if (!proxyUrl) return 'offline';
                const controller = new AbortController();
                const timeoutId = setTimeout(() => controller.abort(), 2500);
                const res = await fetch(proxyUrl, { method: 'GET', signal: controller.signal, headers: { 'Range': 'bytes=0-50' } });
                clearTimeout(timeoutId);
                if (res.ok || res.status === 206) return 'online';
            } catch (e) {}
        }

        return 'offline';
    }

    async function startHealthCheckBatch() {
        if (isHealthChecking || allChannels.length === 0) return;
        isHealthChecking = true;
        healthCheckBtn.innerHTML = '<i class="fa-solid fa-spinner fa-spin"></i> 점검 중...';

        const queue = [...allChannels];
        const concurrency = 4;

        async function worker() {
            while (queue.length > 0) {
                const ch = queue.shift();
                const key = ch.id || ch.url;
                channelHealth[key] = 'checking';
                renderFilteredChannels();

                channelHealth[key] = await checkChannelHealth(ch);
            }
        }

        const workers = Array(concurrency).fill(null).map(() => worker());
        await Promise.all(workers);

        isHealthChecking = false;
        healthCheckBtn.innerHTML = '<i class="fa-solid fa-stethoscope"></i> 상태 점검';
        sessionStorage.setItem('m3u_channel_health', JSON.stringify(channelHealth));
        renderFilteredChannels();
    }

    function setChannelStatus(channel, status) {
        if (!channel) return;
        const key = channel.id || channel.url;
        channelHealth[key] = status;
        sessionStorage.setItem('m3u_channel_health', JSON.stringify(channelHealth));
        renderFilteredChannels();
    }

    function renderFilteredChannels() {
        const keyword = searchInput.value.toLowerCase().trim();
        const selectedGroup = groupSelectEl.value;
        const onlyOnline = onlyOnlineToggle.checked;

        const filtered = allChannels.filter(c => {
            const chId = c.id || c.name;
            const statusKey = c.id || c.url;
            const status = channelHealth[statusKey] || 'unknown';

            if (onlyOnline && status === 'offline') return false;

            if (selectedGroup === '__FAVORITES__' && !favorites.has(chId)) return false;
            const matchesGroup = !selectedGroup || selectedGroup === '__FAVORITES__' || c.group === selectedGroup;
            const epg = getEPGInfo(c);
            const progTitle = epg.current ? epg.current.title.toLowerCase() : '';
            const matchesKeyword = !keyword || c.name.toLowerCase().includes(keyword) || c.group.toLowerCase().includes(keyword) || progTitle.includes(keyword);
            return matchesGroup && matchesKeyword;
        });

        channelListEl.innerHTML = '';
        if (filtered.length === 0) {
            channelListEl.innerHTML = '<div class="m3u-empty-state">검색/필터 결과가 없습니다.</div>';
            return;
        }

        filtered.forEach(ch => {
            const statusKey = ch.id || ch.url;
            const status = channelHealth[statusKey] || 'unknown';
            const isOffline = status === 'offline';

            const item = document.createElement('div');
            item.className = 'm3u-channel-item' +
                             (activeChannel === ch ? ' active' : '') +
                             (isOffline ? ' is-offline' : '');

            const dot = document.createElement('span');
            dot.className = `m3u-status-dot ${status}`;
            dot.title = isOffline ? '재생 불가/오프라인' : (status === 'online' ? '정상 스트림' : '미확인');
            item.appendChild(dot);

            const logoBox = document.createElement('div');
            logoBox.className = 'm3u-logo-box';
            if (ch.logo) {
                const img = document.createElement('img');
                img.className = 'm3u-ch-logo';
                // 방송사 로고는 도메인이 제각각이라 로컬 캐시 프록시(/api/webview/logo-cache)를 경유한다
                img.src = logoCacheUrl(ch.logo);
                img.loading = 'lazy';
                img.onerror = () => { logoBox.innerHTML = '<i class="fa-solid fa-tv m3u-fallback-icon"></i>'; };
                logoBox.appendChild(img);
            } else {
                logoBox.innerHTML = '<i class="fa-solid fa-tv m3u-fallback-icon"></i>';
            }

            const epg = getEPGInfo(ch);
            const info = document.createElement('div');
            info.className = 'm3u-ch-info';

            const name = document.createElement('div');
            name.className = 'm3u-ch-name';
            name.textContent = ch.name;

            const epgRow = document.createElement('div');
            epgRow.className = 'm3u-ch-epg-row';

            const epgText = document.createElement('span');
            epgText.className = 'm3u-ch-epg';
            epgText.textContent = isOffline ? '⚠️ 재생 불가 (오프라인)' : (epg.current ? epg.current.title : (ch.group || 'Live'));

            const epgTime = document.createElement('span');
            epgTime.className = 'm3u-ch-time';
            epgTime.textContent = epg.current ? `${Math.round(epg.progress)}%` : '';

            epgRow.appendChild(epgText);
            epgRow.appendChild(epgTime);

            const miniBar = document.createElement('div');
            miniBar.className = 'm3u-ch-mini-bar';
            const miniFill = document.createElement('div');
            miniFill.className = 'm3u-ch-mini-fill';
            miniFill.style.width = `${epg.progress}%`;
            miniBar.appendChild(miniFill);

            info.appendChild(name);
            info.appendChild(epgRow);
            if (epg.current && !isOffline) info.appendChild(miniBar);

            const chId = ch.id || ch.name;
            const star = document.createElement('i');
            star.className = `m3u-fav-star fa-star ${favorites.has(chId) ? 'fa-solid active' : 'fa-regular'}`;
            star.addEventListener('click', (e) => {
                e.stopPropagation();
                if (favorites.has(chId)) favorites.delete(chId);
                else favorites.add(chId);
                localStorage.setItem('m3u_fav_channels', JSON.stringify(Array.from(favorites)));
                renderFilteredChannels();
                updateFavIcon();
            });

            item.appendChild(logoBox);
            item.appendChild(info);
            item.appendChild(star);

            // 채널 목록 클릭은 사용자 제스처이므로 음소거 없이 재생
            item.addEventListener('click', () => playStream(ch, false));
            channelListEl.appendChild(item);
        });
    }

    function updateLiveProgress() {
        if (!activeChannel) return;
        const info = getEPGInfo(activeChannel);

        if (info.current) {
            currentProgTitleEl.textContent = info.current.title;
            currentProgTimeEl.textContent = info.timeText;
            progressBarEl.style.width = `${info.progress.toFixed(1)}%`;
            progressPercentEl.textContent = `${Math.round(info.progress)}%`;
            remainingTimeEl.textContent = info.remainText;
        } else {
            currentProgTitleEl.textContent = '편성표 정보 없음';
            currentProgTimeEl.textContent = '--:-- ~ --:--';
            progressBarEl.style.width = '0%';
            progressPercentEl.textContent = '0%';
            remainingTimeEl.textContent = '';
        }

        if (info.next) {
            const nH = String(info.next.start.getHours()).padStart(2, '0');
            const nM = String(info.next.start.getMinutes()).padStart(2, '0');
            nextProgTextEl.textContent = `[${nH}:${nM}] ${info.next.title}`;
        } else {
            nextProgTextEl.textContent = '다음 방영 예정 없음';
        }
    }

    function showTvOSD(channel) {
        if (!channel) return;
        const epg = getEPGInfo(channel);

        osdChannelName.textContent = channel.name;
        osdGroupName.textContent = channel.group || 'Live';
        if (channel.logo) {
            // 방송사 로고는 도메인이 제각각이라 로컬 캐시 프록시(/api/webview/logo-cache)를 경유한다
            osdLogoEl.src = logoCacheUrl(channel.logo);
            osdLogoEl.style.display = 'block';
            osdFallbackIcon.style.display = 'none';
        } else {
            osdLogoEl.style.display = 'none';
            osdFallbackIcon.style.display = 'block';
        }

        if (epg.current) {
            osdProgTitle.textContent = epg.current.title;
            osdProgTime.textContent = epg.timeText;
            osdProgressBar.style.width = `${epg.progress.toFixed(1)}%`;
            osdProgressMeta.textContent = `${Math.round(epg.progress)}% (${epg.remainText})`;
        } else {
            osdProgTitle.textContent = '편성표 정보 없음';
            osdProgTime.textContent = '--:-- ~ --:--';
            osdProgressBar.style.width = '0%';
            osdProgressMeta.textContent = '';
        }

        if (epg.next) {
            const nH = String(epg.next.start.getHours()).padStart(2, '0');
            const nM = String(epg.next.start.getMinutes()).padStart(2, '0');
            osdNextProg.textContent = `NEXT: [${nH}:${nM}] ${epg.next.title}`;
        } else {
            osdNextProg.textContent = '';
        }

        tvOsdEl.classList.remove('hidden');
        if (osdTimeout) clearTimeout(osdTimeout);
        osdTimeout = setTimeout(() => { tvOsdEl.classList.add('hidden'); }, 3500);
    }

    // isAutoplay: 사용자 제스처 없이(페이지 로드 직후 등) 자동 재생되는 경우 true.
    // 브라우저 자동재생 정책에 걸려 재생이 막히고 채널이 오프라인으로 오탐되는 것을 막기 위해
    // 이 경우에는 음소거 상태로 재생을 시작한다. 사용자는 플레이어 컨트롤로 언제든 음소거를 해제할 수 있다.
    function playStream(channel, isAutoplay) {
        activeChannel = channel;
        const myToken = ++playToken; // 이번 재생 시도의 고유 토큰

        // 직전 채널이 최종 실패(프록시까지 실패)했던 경우, 그 채널의 실패 처리 코드가 세워둔
        // videoNeedsRecreate 플래그를 여기서 — 이번 채널의 그 어떤 재생 시도(destroyPlayers,
        // attachMedia 등)보다도 먼저 — 동기적으로 처리한다. 순서를 여기서 강제하기 때문에
        // "실패 처리 중 비동기로 교체하다가 그 사이 다음 채널이 낡은 엘리먼트를 먼저 잡아버리는"
        // 레이스가 생기지 않는다. (네이티브 PIP/미니창 중이면 recreateVideoElement가 스스로 무시한다.)
        if (videoNeedsRecreate) {
            videoNeedsRecreate = false;
            recreateVideoElement();
        }

        currentTitleEl.textContent = channel.name;
        currentGroupEl.textContent = channel.group || 'Live';
        updateFavIcon();
        updateLiveProgress();
        showTvOSD(channel);
        if (miniChannelBarEl) miniChannelBarEl.textContent = channel.name; // 미니창이 열려있다면 채널명도 갱신

        // ⚠️ 버그 수정: 이전 채널이 실패해서 오버레이에 "스트림 연결 실패 (오프라인 / CORS 차단)"
        // 메시지가 떠 있는 상태로 새 채널을 선택하면, 새 채널의 재생 성공/실패가 확정되기 전까지
        // (특히 HLS 매니페스트 파싱처럼 몇백ms~몇 초 걸리는 경우) 그 오래된 실패 메시지가 화면에
        // 그대로 남아있어서 "방금 전 실패했던 채널과 똑같이 이 채널도 CORS에 막혔다"고 오인하게
        // 만들었다. 새 채널 재생을 시작하는 시점에 즉시 중립적인 "연결 중..." 상태로 덮어써서
        // 이전 채널의 결과가 새 채널에 잘못 이어져 보이지 않게 한다.
        setOverlay(`"${channel.name}" 연결 중...`, true);

        destroyPlayers();

        // 이전 채널이 DIRECT(video.src) 방식으로 재생/실패했던 잔여 상태가 남아있으면
        // 다음 채널의 hls.js/mpegts.js attachMedia가 방해받을 수 있어 완전히 초기화한다.
        videoEl.removeAttribute('src');
        videoEl.load();

        videoEl.muted = !!isAutoplay;

        const streamUrl = channel.url.trim();
        // 포맷 판별(TS 여부)은 항상 "원본" URL 기준으로 딱 한 번만 계산해서 프록시
        // 재시도까지 그대로 들고 다닌다. 예전에는 이 판별을 attemptPlayUrl() 안에서
        // 매번(프록시로 바뀐 URL에 대해서도) 다시 계산했는데, /api/webview/hls-proxy?url=...
        // 형태의 프록시 URL은 인코딩 결과가 우연히 ".ts"로 안 끝나면 TS 스트림이
        // 아닌 것으로 오판되어 mpegts.js 대신 hls.js/DIRECT로 잘못 재생을 시도하는
        // 문제가 있었다. 또한 인증 토큰이 붙은 원본 URL(예: stream.ts?token=...)도
        // endsWith('.ts')만으로는 놓칠 수 있어 쿼리스트링을 뗀 경로 부분만으로 판별한다.
        const isTs = detectIsTs(streamUrl);
        attemptPlayUrl(channel, streamUrl, false, myToken, isTs);
        renderFilteredChannels();
    }

    // URL의 path 부분(쿼리스트링/해시 제외)만 보고 .ts 확장자인지, 또는
    // output=ts 같은 쿼리 파라미터로 TS 포맷을 명시하고 있는지 판별한다.
    // 프록시로 치환되기 전, 원본 스트림 URL에 대해서만 호출해야 한다.
    function detectIsTs(rawUrl) {
        let pathPart = rawUrl;
        try {
            const u = new URL(rawUrl, window.location.href);
            pathPart = u.pathname;
            const outputParam = (u.searchParams.get('output') || '').toLowerCase();
            if (outputParam === 'ts') return true;
        } catch (e) {
            // URL 파싱 실패 시(상대경로 등) 원본 문자열 그대로 폴백
            const qIdx = rawUrl.indexOf('?');
            pathPart = qIdx === -1 ? rawUrl : rawUrl.substring(0, qIdx);
        }
        return pathPart.toLowerCase().endsWith('.ts');
    }

    // url: 실제로 재생을 시도할 URL (원본 또는 프록시로 치환된 URL)
    // isViaProxy: getStreamProxyUrl로 이미 한 번 치환된 URL인지 여부.
    // token: 이 시도가 시작될 때의 playToken 스냅샷. 실행 중 playToken이 바뀌었다면(다른 채널로 전환됨)
    //        이 시도에서 파생된 모든 비동기 콜백은 아무 것도 하지 않고 조용히 무시한다.
    // isTs: 원본 URL 기준으로 미리 판별해둔 TS 포맷 여부 (playStream()/retryViaStreamProxy()에서 전달).
    function attemptPlayUrl(channel, url, isViaProxy, token, isTs) {
        if (token !== playToken) return; // 이미 낡은 시도라 시작조차 하지 않는다
        const isStale = () => token !== playToken;

        const onFailure = () => {
            if (isStale()) return;
            if (isViaProxy) {
                setChannelStatus(channel, 'offline');
                setOverlay('스트림 연결 실패 (오프라인 / CORS 차단)', true);
                // 여기서 곧바로 recreateVideoElement()를 호출하지 않는다. hls.js/mpegts.js의
                // destroy()가 이 이벤트 콜스택 안에서 아직 내부 정리 중일 수 있어 DOM을 바로
                // 교체하면 충돌할 위험이 있고, setTimeout으로 미루면 사용자가 그 사이 빠르게
                // 다음 채널을 눌렀을 때 "교체 전(낡은) 비디오 엘리먼트로 새 채널이 재생을
                // 시작해버리는" 레이스가 생긴다. 대신 플래그만 세워두고, 실제 교체는 다음
                // playStream() 시작 시점에 그 채널의 어떤 재생 시도보다도 먼저 동기적으로
                // 수행한다(아래 videoNeedsRecreate 참고) — 순서가 항상 보장된다.
                videoNeedsRecreate = true;
            } else {
                retryViaStreamProxy(channel, url, token, isTs);
            }
        };

        if (isTs && window.mpegts && window.mpegts.isSupported()) {
            engineBadgeEl.textContent = isViaProxy ? 'MPEG-TS (프록시)' : 'MPEG-TS';

            // ⚠️ 버그 수정: 예전에는 이 분기에서 실패해도(createPlayer/attachMediaElement/load 예외,
            // play() 프라미스 거부) 실패한 thisPlayer 인스턴스를 destroy()하지 않고 그대로 전역
            // mpegtsPlayer에 남겨뒀다. 그 "반쯤 깨진" 인스턴스를 다음 채널 선택 시 playStream()의
            // 정리 코드가 다시 건드리면서 내부적으로 예외를 던지고, 그 예외가 playStream() 자체를
            // 중간에 멈춰버려 이후로는 어떤 채널을 눌러도 재생이 시작되지 않는(하드 리프레시 전까지)
            // 문제가 있었다. HLS 분기처럼 실패 시 반드시 destroy() + 참조 해제하도록 통일한다.
            let thisPlayer = null;
            const cleanupThisPlayer = () => {
                if (thisPlayer) {
                    try { thisPlayer.destroy(); } catch (e) { /* 이미 깨진 인스턴스일 수 있어 무시 */ }
                }
                if (mpegtsPlayer === thisPlayer) mpegtsPlayer = null;
            };

            try {
                thisPlayer = window.mpegts.createPlayer({ type: 'mse', isLive: true, url });
                mpegtsPlayer = thisPlayer;

                // 초기 play() 실패뿐 아니라 재생 중간에 발생하는 네트워크 오류 등도 잡아서
                // 정리하고 onFailure()로 넘긴다 (예전에는 이 리스너가 아예 없어서 재생 도중
                // 스트림이 끊겨도 아무 처리 없이 화면만 멈춰 있었다).
                if (window.mpegts.Events && window.mpegts.Events.ERROR) {
                    thisPlayer.on(window.mpegts.Events.ERROR, () => {
                        cleanupThisPlayer();
                        if (!isStale()) onFailure();
                    });
                }

                thisPlayer.attachMediaElement(videoEl);
                thisPlayer.load();
                thisPlayer.play().then(() => {
                    if (isStale()) return;
                    setOverlay('', false);
                    setChannelStatus(channel, 'online');
                }).catch(() => {
                    cleanupThisPlayer();
                    if (!isStale()) onFailure();
                });
            } catch (e) {
                cleanupThisPlayer();
                if (!isStale()) onFailure();
            }
        } else if (window.Hls && window.Hls.isSupported()) {
            engineBadgeEl.textContent = isViaProxy ? 'HLS (프록시)' : 'HLS';
            const thisHls = new window.Hls({ enableWorker: true, lowLatencyMode: true });
            hlsInstance = thisHls;
            thisHls.loadSource(url);
            thisHls.attachMedia(videoEl);

            thisHls.on(window.Hls.Events.MANIFEST_PARSED, () => {
                if (isStale()) return;
                setOverlay('', false);
                setChannelStatus(channel, 'online');
                videoEl.play().catch(() => {});
            });

            thisHls.on(window.Hls.Events.ERROR, (event, data) => {
                if (!data.fatal) return;
                // 이 인스턴스(thisHls) 자신만 정리한다. 전역 hlsInstance가 이미 다른(새) 인스턴스로
                // 교체된 뒤라면(=낡은 시도) 그 새 인스턴스를 건드리지 않도록 반드시 참조가 같을 때만 null로 되돌린다.
                thisHls.destroy();
                if (hlsInstance === thisHls) hlsInstance = null;
                if (!isStale()) onFailure();
            });
        } else {
            engineBadgeEl.textContent = isViaProxy ? 'DIRECT (프록시)' : 'DIRECT';
            videoEl.src = url;
            videoEl.play().then(() => {
                if (isStale()) return;
                setOverlay('', false);
                setChannelStatus(channel, 'online');
            }).catch(() => { if (!isStale()) onFailure(); });
        }
    }

    // 직접 재생이 실패했을 때(CORS/mixed-content 등) 코어의 스트림 프록시로 한 번 더 시도한다.
    // getStreamProxyUrl은 .m3u8은 내부 세그먼트 URL까지 프록시로 재작성해 돌려주고,
    // 그 외 스트림은 버퍼링 없는 pass-through로 중계한다(/api/webview/hls-proxy).
    // ⚠️ 이 프록시는 서버 쪽에서 사설/루프백 IP로 해석되는 URL을 403으로 차단한다(SSRF 방지).
    // 즉 사용자의 개인 M3U 서버가 사설 IP(예: 192.168.x.x)이고 직접 접근이 CORS로 막혀 있다면
    // 이 프록시로도 재생이 안 될 수 있다 — 이 경우 개인 서버 쪽에서 CORS 헤더를 열어주는 것이
    // 근본 해결책이다(README 참고).
    // 화이트리스트 실패 시 getStreamProxyUrl 자체가 토스트 안내를 띄우고 null을 반환하므로
    // 여기서는 별도 알림 없이 오프라인 처리한다.
    // 참고: /api/webview/hls-proxy도 이제 GET 외에 POST(바디 릴레이)를 지원하지만, 이는
    // Widevine/PlayReady 같은 DASH DRM 라이선스 서버용이다. 이 플러그인은 DRM 없는 순수
    // HLS/MPEG-TS 채널만 다루므로 스트림 재생 경로에서는 항상 GET만 사용한다.
    async function retryViaStreamProxy(channel, originalUrl, token, isTs) {
        if (token !== playToken) return; // 대기 중 다른 채널로 전환됐으면 아무 것도 하지 않는다


        if (!window.BookOasisPlugin || typeof window.BookOasisPlugin.getStreamProxyUrl !== 'function') {
            setChannelStatus(channel, 'offline');
            setOverlay('스트림 연결 실패 (오프라인 / CORS 차단)', true);
            return;
        }

        let proxyUrl = null;
        try {
            proxyUrl = await window.BookOasisPlugin.getStreamProxyUrl(originalUrl);
        } catch (e) {}

        if (token !== playToken) return; // await 도중 채널이 바뀌었으면 재생하지 않는다

        if (!proxyUrl) {
            setChannelStatus(channel, 'offline');
            return;
        }

        // 프록시 URL(/api/webview/hls-proxy?url=...)은 인코딩된 원본 URL을 쿼리스트링에
        // 담고 있어 그 자체로는 포맷을 신뢰성 있게 판별할 수 없다. 원본 URL에서 이미
        // 계산해둔 isTs 판정을 그대로 사용한다.
        attemptPlayUrl(channel, proxyUrl, true, token, isTs);
    }

    function openScheduleView() {
        if (!activeChannel) return;
        scheduleTitleEl.textContent = `📺 ${activeChannel.name} 오늘의 편성표`;
        scheduleListEl.innerHTML = '';

        const list = epgProgrammes[activeChannel.id] || epgProgrammes[activeChannel.name] || [];
        if (!list.length) {
            scheduleListEl.innerHTML = '<div class="m3u-empty-state">해당 채널의 편성표 데이터가 없습니다.</div>';
        } else {
            const now = new Date();
            list.forEach(p => {
                const isCurrent = p.start <= now && (!p.stop || p.stop > now);
                const sH = String(p.start.getHours()).padStart(2, '0');
                const sM = String(p.start.getMinutes()).padStart(2, '0');
                const eH = p.stop ? String(p.stop.getHours()).padStart(2, '0') : '--';
                const eM = p.stop ? String(p.stop.getMinutes()).padStart(2, '0') : '--';

                const item = document.createElement('div');
                item.className = 'm3u-schedule-item' + (isCurrent ? ' current' : '');

                // ⚠️ 보안: EPG 소스에서 온 p.title은 신뢰할 수 없는 외부 데이터이므로
                // innerHTML이 아니라 textContent로 안전하게 삽입한다.
                const timeEl = document.createElement('div');
                timeEl.className = 'm3u-sched-time';
                timeEl.textContent = `${sH}:${sM} ~ ${eH}:${eM}`;

                const titleEl = document.createElement('div');
                titleEl.className = 'm3u-sched-title';
                titleEl.textContent = p.title;
                if (isCurrent) {
                    const liveTag = document.createElement('b');
                    liveTag.textContent = ' (방송중)';
                    titleEl.appendChild(liveTag);
                }

                item.appendChild(timeEl);
                item.appendChild(titleEl);
                scheduleListEl.appendChild(item);
            });
        }
        scheduleModal.classList.remove('hidden');
    }

    function setOverlay(msg, isVisible) {
        if (isVisible) {
            overlayText.textContent = msg;
            overlayEl.classList.remove('hidden');
        } else {
            overlayEl.classList.add('hidden');
        }
    }

    if (document.readyState === 'complete' || document.readyState === 'interactive') {
        init();
    } else {
        document.addEventListener('DOMContentLoaded', init);
    }
})();
