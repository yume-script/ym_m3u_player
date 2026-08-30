// plugins/metadata/m3u_player/script.js
(function () {
    let isInitialized = false;
    let hlsInstance = null;
    let mpegtsPlayer = null;
    let allChannels = [];
    let activeChannel = null;
    let epgProgrammes = {};

    const videoEl = document.getElementById('m3uVideoPlayer');
    const overlayEl = document.getElementById('m3uPlayerOverlay');
    const overlayText = document.getElementById('m3uOverlayText');
    const channelListEl = document.getElementById('m3uChannelList');
    const channelCountEl = document.getElementById('m3uChannelCount');
    const groupSelectEl = document.getElementById('m3uGroupSelect');
    const searchInput = document.getElementById('m3uSearchInput');
    const urlInput = document.getElementById('m3uUrlInput');
    const loadBtn = document.getElementById('m3uLoadBtn');
    const epgInput = document.getElementById('m3uEpgInput');
    const epgLoadBtn = document.getElementById('m3uEpgLoadBtn');
    const saveDefaultBtn = document.getElementById('m3uSaveDefaultBtn');
    const fileInput = document.getElementById('m3uFileInput');
    const epgStatusEl = document.getElementById('m3uEpgStatus');

    const currentTitleEl = document.getElementById('m3uCurrentChannelTitle');
    const currentGroupEl = document.getElementById('m3uCurrentChannelGroup');
    const currentEpgTextEl = document.getElementById('m3uCurrentEpgText');
    const engineBadgeEl = document.getElementById('m3uStreamEngineBadge');

    // 1. 초기화 및 기본값(서버 설정 + 브라우저 로컬 스토리지) 로드
    async function init() {
        if (isInitialized) return;
        isInitialized = true;

        // UI 이벤트 바인딩
        loadBtn.addEventListener('click', () => {
            const url = urlInput.value.trim();
            if (url) loadM3UFromUrl(url);
        });

        epgLoadBtn.addEventListener('click', () => {
            const url = epgInput.value.trim();
            if (url) loadEPGFromUrl(url);
        });

        saveDefaultBtn.addEventListener('click', () => {
            const m3uUrl = urlInput.value.trim();
            const epgUrl = epgInput.value.trim();
            localStorage.setItem('m3u_default_url', m3uUrl);
            localStorage.setItem('m3u_default_epg_url', epgUrl);
            alert('기본 M3U 및 EPG 주소가 저장되었습니다.');
        });

        urlInput.addEventListener('keydown', (e) => {
            if (e.key === 'Enter' && urlInput.value.trim()) loadM3UFromUrl(urlInput.value.trim());
        });

        fileInput.addEventListener('change', handleFileUpload);
        searchInput.addEventListener('input', renderFilteredChannels);
        groupSelectEl.addEventListener('change', renderFilteredChannels);

        // 기본값 복구: 1순위(브라우저 저장값) -> 2순위(서버 config_schema 설정값)
        let defaultM3u = localStorage.getItem('m3u_default_url') || '';
        let defaultEpg = localStorage.getItem('m3u_default_epg_url') || '';

        if (!defaultM3u || !defaultEpg) {
            try {
                // 북오아시스 플러그인 서버 설정 동기화 시도
                const res = await fetch('/api/media/plugins');
                if (res.ok) {
                    const data = await res.json();
                    const plugins = data.plugins || [];
                    const myPlugin = plugins.find(p => p.id === 'm3u_player');
                    if (myPlugin && myPlugin.config) {
                        if (!defaultM3u && myPlugin.config.DEFAULT_M3U_URL) {
                            defaultM3u = myPlugin.config.DEFAULT_M3U_URL;
                        }
                        if (!defaultEpg && myPlugin.config.DEFAULT_EPG_URL) {
                            defaultEpg = myPlugin.config.DEFAULT_EPG_URL;
                        }
                    }
                }
            } catch (e) {
                console.log('[M3UPlayer] Server config fetch ignored:', e);
            }
        }

        if (defaultM3u) urlInput.value = defaultM3u;
        if (defaultEpg) epgInput.value = defaultEpg;

        // EPG 및 M3U 자동 로드
        if (defaultEpg) loadEPGFromUrl(defaultEpg);
        if (defaultM3u) loadM3UFromUrl(defaultM3u);
    }

    // 2. 스트림 엔진 해제 헬퍼
    function destroyCurrentPlayers() {
        if (hlsInstance) {
            hlsInstance.destroy();
            hlsInstance = null;
        }
        if (mpegtsPlayer) {
            mpegtsPlayer.pause();
            mpegtsPlayer.unload();
            mpegtsPlayer.detachMediaElement();
            mpegtsPlayer.destroy();
            mpegtsPlayer = null;
        }
    }

    // 3. 하이브리드 미디어 재생 (HLS.js / MPEGTS.js / Safari Native)
    function playStream(channel) {
        activeChannel = channel;
        currentTitleEl.textContent = channel.name;
        currentGroupEl.textContent = channel.group || 'Live';
        updateCurrentChannelEPG();

        destroyCurrentPlayers();

        const streamUrl = channel.url.trim();
        const lowerUrl = streamUrl.toLowerCase();

        // 스트림 형식 판별: TS 직접 스트림 / FLV 여부 확인
        const isTsOrFlv = lowerUrl.endsWith('.ts') || lowerUrl.endsWith('.flv') || lowerUrl.includes('output=ts') || lowerUrl.includes('type=ts');

        if (isTsOrFlv && window.mpegts && window.mpegts.isSupported()) {
            // [Engine 1] mpegts.js (MPEG-TS direct stream)
            engineBadgeEl.textContent = 'MPEG-TS';
            engineBadgeEl.style.display = 'inline-block';

            try {
                mpegtsPlayer = window.mpegts.createPlayer({
                    type: lowerUrl.endsWith('.flv') ? 'flv' : 'mse',
                    isLive: true,
                    url: streamUrl
                }, {
                    enableWorker: true,
                    lazyLoad: false,
                    liveBufferLatencyChasing: true
                });

                mpegtsPlayer.attachMediaElement(videoEl);
                mpegtsPlayer.load();
                mpegtsPlayer.play().then(() => {
                    setOverlay('', false);
                }).catch(e => console.log('[M3UPlayer] TS Autoplay:', e));

                mpegtsPlayer.on(window.mpegts.Events.ERROR, (errorType, errorDetail) => {
                    console.error('[M3UPlayer] MPEGTS Error:', errorType, errorDetail);
                    setOverlay('TS 스트림 연결 실패 (CORS 또는 스트림 오프라인)', true);
                });
            } catch (err) {
                console.error('[M3UPlayer] MPEGTS init error:', err);
                fallbackDirectPlay(streamUrl);
            }
        } else if (window.Hls && window.Hls.isSupported()) {
            // [Engine 2] HLS.js (m3u8 stream)
            engineBadgeEl.textContent = 'HLS';
            engineBadgeEl.style.display = 'inline-block';

            hlsInstance = new window.Hls({
                enableWorker: true,
                lowLatencyMode: true,
                backBufferLength: 30
            });

            hlsInstance.loadSource(streamUrl);
            hlsInstance.attachMedia(videoEl);

            hlsInstance.on(window.Hls.Events.MANIFEST_PARSED, () => {
                setOverlay('', false);
                videoEl.play().catch(e => console.log('[M3UPlayer] HLS Autoplay:', e));
            });

            hlsInstance.on(window.Hls.Events.ERROR, (event, data) => {
                if (data.fatal) {
                    switch (data.type) {
                        case window.Hls.ErrorTypes.NETWORK_ERROR:
                            setOverlay('스트림 연결 실패 (CORS 또는 스트림 오프라인)', true);
                            hlsInstance.startLoad();
                            break;
                        case window.Hls.ErrorTypes.MEDIA_ERROR:
                            hlsInstance.recoverMediaError();
                            break;
                        default:
                            hlsInstance.destroy();
                            setOverlay('재생할 수 없는 스트림입니다.', true);
                            break;
                    }
                }
            });
        } else if (videoEl.canPlayType('application/vnd.apple.mpegurl')) {
            // [Engine 3] Safari / iOS Native
            engineBadgeEl.textContent = 'NATIVE';
            engineBadgeEl.style.display = 'inline-block';

            videoEl.src = streamUrl;
            videoEl.addEventListener('loadedmetadata', () => {
                setOverlay('', false);
                videoEl.play().catch(e => console.log('[M3UPlayer] Native Play:', e));
            });
        } else {
            fallbackDirectPlay(streamUrl);
        }

        renderFilteredChannels();
    }

    function fallbackDirectPlay(url) {
        engineBadgeEl.textContent = 'DIRECT';
        videoEl.src = url;
        videoEl.play().then(() => setOverlay('', false)).catch(() => {
            setOverlay('지원되지 않는 미디어 형식이거나 재생할 수 없습니다.', true);
        });
    }

    // 4. M3U 파서
    function parseM3U(content) {
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
                    group: '기타 (Etc)',
                    url: ''
                };

                const idMatch = line.match(/tvg-id="([^"]+)"/i);
                if (idMatch) currentInfo.id = idMatch[1].trim();

                const groupMatch = line.match(/group-title="([^"]+)"/i);
                if (groupMatch) currentInfo.group = groupMatch[1];

                const logoMatch = line.match(/tvg-logo="([^"]+)"/i);
                if (logoMatch) currentInfo.logo = logoMatch[1];

                const commaIdx = line.lastIndexOf(',');
                if (commaIdx !== -1) {
                    const name = line.substring(commaIdx + 1).trim();
                    if (name) currentInfo.name = name;
                }
                if (!currentInfo.id) currentInfo.id = currentInfo.name;
            } else if (!line.startsWith('#') && currentInfo) {
                currentInfo.url = line;
                channels.push(currentInfo);
                currentInfo = null;
            }
        }
        return channels;
    }

    // 5. EPG (XMLTV) 파서
    async function loadEPGFromUrl(url) {
        epgStatusEl.textContent = 'EPG 로딩 중...';
        epgStatusEl.style.color = 'var(--app-text-muted)';
        try {
            const res = await fetch(url);
            if (!res.ok) throw new Error(`HTTP ${res.status}`);
            const xmlText = await res.text();
            
            parseXMLTV(xmlText);
            epgStatusEl.textContent = 'EPG 적용됨';
            epgStatusEl.style.color = '#10b981';
            renderFilteredChannels();
            updateCurrentChannelEPG();
        } catch (err) {
            console.error('[M3UPlayer] EPG Load Error:', err);
            epgStatusEl.textContent = 'EPG 로드 실패';
            epgStatusEl.style.color = '#ef4444';
        }
    }

    function parseXMLTV(xmlText) {
        const parser = new DOMParser();
        const xmlDoc = parser.parseFromString(xmlText, 'text/xml');
        const programmes = xmlDoc.getElementsByTagName('programme');
        epgProgrammes = {};

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
    }

    function parseXMLTVDate(str) {
        const clean = str.replace(/[^0-9]/g, '');
        if (clean.length < 14) return new Date();
        const y = clean.substr(0, 4);
        const m = clean.substr(4, 2) - 1;
        const d = clean.substr(6, 2);
        const h = clean.substr(8, 2);
        const min = clean.substr(10, 2);
        const s = clean.substr(12, 2);
        return new Date(Date.UTC(y, m, d, h - 9, min, s));
    }

    function getCurrentProgram(channel) {
        if (!channel) return null;
        const list = epgProgrammes[channel.id] || epgProgrammes[channel.name];
        if (!list || list.length === 0) return null;

        const now = new Date();
        return list.find(p => p.start <= now && (!p.stop || p.stop >= now)) || list[0];
    }

    // 6. M3U 로드 및 데이터 처리
    async function loadM3UFromUrl(url) {
        setOverlay('M3U 목록을 불러오는 중...', true);
        try {
            const response = await fetch(url);
            if (!response.ok) throw new Error(`HTTP ${response.status}`);
            const text = await response.text();
            processM3UData(text);
        } catch (err) {
            console.error('[M3UPlayer] Failed to load M3U:', err);
            alert(`M3U 목록 로드 실패: ${err.message}\n(CORS 차단 또는 URL을 확인하세요)`);
            setOverlay('M3U 로드 실패. 주소를 확인하세요.', true);
        }
    }

    function handleFileUpload(e) {
        const file = e.target.files[0];
        if (!file) return;

        const reader = new FileReader();
        reader.onload = function (event) {
            processM3UData(event.target.result);
        };
        reader.readAsText(file);
    }

    function processM3UData(m3uText) {
        allChannels = parseM3U(m3uText);
        channelCountEl.textContent = allChannels.length;

        const groups = new Set();
        allChannels.forEach(c => { if (c.group) groups.add(c.group); });

        groupSelectEl.innerHTML = '<option value="">전체 그룹 (All)</option>';
        Array.from(groups).sort().forEach(g => {
            const opt = document.createElement('option');
            opt.value = g;
            opt.textContent = g;
            groupSelectEl.appendChild(opt);
        });

        renderFilteredChannels();
        setOverlay('채널을 선택하세요.', true);

        // 첫 번째 채널 자동 재생
        if (allChannels.length > 0 && !activeChannel) {
            playStream(allChannels[0]);
        }
    }

    function renderFilteredChannels() {
        const keyword = searchInput.value.toLowerCase().trim();
        const selectedGroup = groupSelectEl.value;

        const filtered = allChannels.filter(c => {
            const matchesGroup = !selectedGroup || c.group === selectedGroup;
            const curProg = getCurrentProgram(c);
            const progTitle = curProg ? curProg.title.toLowerCase() : '';
            const matchesKeyword = !keyword || 
                                   c.name.toLowerCase().includes(keyword) || 
                                   c.group.toLowerCase().includes(keyword) ||
                                   progTitle.includes(keyword);
            return matchesGroup && matchesKeyword;
        });

        channelListEl.innerHTML = '';
        if (filtered.length === 0) {
            channelListEl.innerHTML = '<div class="m3u-empty-state">검색 결과가 없습니다.</div>';
            return;
        }

        filtered.forEach(ch => {
            const item = document.createElement('div');
            item.className = 'm3u-channel-item' + (activeChannel === ch ? ' active' : '');

            const logoBox = document.createElement('div');
            logoBox.className = 'm3u-logo-box';

            if (ch.logo) {
                const img = document.createElement('img');
                img.className = 'm3u-ch-logo';
                img.src = ch.logo;
                img.loading = 'lazy';
                img.onerror = () => {
                    logoBox.innerHTML = '<i class="fa-solid fa-tv m3u-fallback-icon"></i>';
                };
                logoBox.appendChild(img);
            } else {
                logoBox.innerHTML = '<i class="fa-solid fa-tv m3u-fallback-icon"></i>';
            }

            const info = document.createElement('div');
            info.className = 'm3u-ch-info';

            const name = document.createElement('div');
            name.className = 'm3u-ch-name';
            name.textContent = ch.name;

            const curProg = getCurrentProgram(ch);
            const epgDiv = document.createElement('div');
            epgDiv.className = 'm3u-ch-epg';
            epgDiv.textContent = curProg ? `▶ ${curProg.title}` : (ch.group || 'Live');

            info.appendChild(name);
            info.appendChild(epgDiv);

            item.appendChild(logoBox);
            item.appendChild(info);

            item.addEventListener('click', () => playStream(ch));
            channelListEl.appendChild(item);
        });
    }

    function updateCurrentChannelEPG() {
        if (!activeChannel) return;
        const curProg = getCurrentProgram(activeChannel);
        if (curProg) {
            currentEpgTextEl.textContent = curProg.title;
        } else {
            currentEpgTextEl.textContent = '편성표 정보 없음';
        }
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