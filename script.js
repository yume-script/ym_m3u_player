// plugins/metadata/m3u_player/script.js
(function () {
    // m3u_player.py의 id와 반드시 일치해야 한다 (API 경로에 사용)
    const PLUGIN_ID = 'm3u_player';
    // 이 플러그인 설정은 라이브러리 스코프와 무관한 전역 값이므로 조회/저장 모두
    // 항상 "general"로 고정한다 (m3u_player.py의 CONFIG_SCOPE와 반드시 일치해야 함).
    const CONFIG_SCOPE = 'general';

    let isInitialized = false;
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

    // 기본 5개 세트 정의 (서버/로컬 모두 조회 실패할 때의 최종 폴백)
    let sourceSlots = [
        { enabled: true, name: '개인', m3u: '', epg: '' },
        { enabled: false, name: 'iptv-org', m3u: 'https://iptv-org.github.io/iptv/countries/kr.m3u', epg: 'https://iptv-org.github.io/epg/guides/kr.xml' },
        { enabled: false, name: 'FAST', m3u: '', epg: '' },
        { enabled: false, name: '세트 4', m3u: '', epg: '' },
        { enabled: false, name: '세트 5', m3u: '', epg: '' }
    ];

    // DOM Elements
    const videoEl = document.getElementById('m3uVideoPlayer');
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
            if (data && Array.isArray(data.slots) && data.slots.length > 0) {
                return data.slots;
            }
            return null;
        } catch (e) {
            console.warn('[M3UPlayer] 서버 설정 조회 실패, 로컬 백업값을 사용합니다:', e.message);
            return null;
        }
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

    // 소스 관리 모달 열기
    function openSourceModal() {
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
        return (str || '').replace(/"/g, '&quot;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
    }

    // 소스 관리 모달 저장: 관리자 설정 화면(config_schema)과 동일한 저장소에
    // POST /api/media/books/0/apply-metadata -> apply() 를 통해 반영한다.
    async function saveSourcesFromModal() {
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

    // 🌐 [핵심] CORS 차단 자동 우회 fetch 함수
    async function fetchTextWithCorsFallback(url) {
        // 1차: 직접 fetch 시도
        try {
            const res = await fetch(url);
            if (res.ok) return await res.text();
        } catch (e) {
            console.warn(`[M3UPlayer] Direct fetch failed for ${url} (CORS/Mixed Content), trying fallback proxy...`);
        }

        // 2차: allorigins 프록시 시도
        try {
            const proxyUrl1 = `https://api.allorigins.win/raw?url=${encodeURIComponent(url)}`;
            const res1 = await fetch(proxyUrl1);
            if (res1.ok) return await res1.text();
        } catch (e) {}

        // 3차: corsproxy.io 시도
        try {
            const proxyUrl2 = `https://corsproxy.io/?${encodeURIComponent(url)}`;
            const res2 = await fetch(proxyUrl2);
            if (res2.ok) return await res2.text();
        } catch (e) {}

        throw new Error('CORS 차단 또는 서버 응답 없음');
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

        // 2. M3U 재생목록 병렬 로드
        const m3uPromises = activeSlots.map(s => loadM3UFile(s.m3u.trim(), s.name));
        const m3uResults = await Promise.allSettled(m3uPromises);

        let mergedChannels = [];
        m3uResults.forEach(res => {
            if (res.status === 'fulfilled' && Array.isArray(res.value)) {
                mergedChannels = mergedChannels.concat(res.value);
            }
        });

        allChannels = mergedChannels;
        channelCountEl.textContent = allChannels.length;

        const groups = new Set();
        allChannels.forEach(c => { if (c.group) groups.add(c.group); });

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

        renderFilteredChannels();
        setOverlay('채널을 선택하세요.', true);

        if (allChannels.length > 0 && !activeChannel) {
            // 페이지 로드 직후의 자동재생은 사용자 제스처가 없으므로 음소거 상태로 시작
            playStream(allChannels[0], true);
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

    // 사전 스트림 헬스체크
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

                try {
                    const controller = new AbortController();
                    const timeoutId = setTimeout(() => controller.abort(), 2500);
                    const res = await fetch(ch.url, { method: 'GET', signal: controller.signal, headers: { 'Range': 'bytes=0-50' } });
                    clearTimeout(timeoutId);

                    if (res.ok || res.status === 206) {
                        channelHealth[key] = 'online';
                    } else {
                        channelHealth[key] = 'offline';
                    }
                } catch (e) {
                    channelHealth[key] = 'offline';
                }
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
                img.src = ch.logo;
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
            osdLogoEl.src = channel.logo;
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
        currentTitleEl.textContent = channel.name;
        currentGroupEl.textContent = channel.group || 'Live';
        updateFavIcon();
        updateLiveProgress();
        showTvOSD(channel);

        if (hlsInstance) { hlsInstance.destroy(); hlsInstance = null; }
        if (mpegtsPlayer) { mpegtsPlayer.pause(); mpegtsPlayer.unload(); mpegtsPlayer.detachMediaElement(); mpegtsPlayer.destroy(); mpegtsPlayer = null; }

        videoEl.muted = !!isAutoplay;

        const streamUrl = channel.url.trim();
        const lowerUrl = streamUrl.toLowerCase();
        const isTs = lowerUrl.endsWith('.ts') || lowerUrl.includes('output=ts');

        if (isTs && window.mpegts && window.mpegts.isSupported()) {
            engineBadgeEl.textContent = 'MPEG-TS';
            try {
                mpegtsPlayer = window.mpegts.createPlayer({ type: 'mse', isLive: true, url: streamUrl });
                mpegtsPlayer.attachMediaElement(videoEl);
                mpegtsPlayer.load();
                mpegtsPlayer.play().then(() => {
                    setOverlay('', false);
                    setChannelStatus(channel, 'online');
                }).catch(() => {
                    setChannelStatus(channel, 'offline');
                });
            } catch (e) {
                setChannelStatus(channel, 'offline');
                fallbackPlay(streamUrl, channel);
            }
        } else if (window.Hls && window.Hls.isSupported()) {
            engineBadgeEl.textContent = 'HLS';
            hlsInstance = new window.Hls({ enableWorker: true, lowLatencyMode: true });
            hlsInstance.loadSource(streamUrl);
            hlsInstance.attachMedia(videoEl);

            hlsInstance.on(window.Hls.Events.MANIFEST_PARSED, () => {
                setOverlay('', false);
                setChannelStatus(channel, 'online');
                videoEl.play().catch(() => {});
            });

            hlsInstance.on(window.Hls.Events.ERROR, (event, data) => {
                if (data.fatal) {
                    setChannelStatus(channel, 'offline');
                    setOverlay('스트림 연결 실패 (오프라인 / CORS 차단)', true);
                }
            });
        } else {
            fallbackPlay(streamUrl, channel);
        }

        renderFilteredChannels();
    }

    function fallbackPlay(url, channel) {
        engineBadgeEl.textContent = 'DIRECT';
        videoEl.src = url;
        videoEl.play().then(() => {
            setOverlay('', false);
            setChannelStatus(channel, 'online');
        }).catch(() => {
            setChannelStatus(channel, 'offline');
            setOverlay('재생할 수 없는 스트림입니다.', true);
        });
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
