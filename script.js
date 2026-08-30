// plugins/metadata/m3u_player/script.js
(function () {
    let hlsInstance = null;
    let allChannels = [];
    let activeChannel = null;
    let epgProgrammes = {}; // { [channelId]: [ { start, stop, title } ] }

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

    async function init() {
        // 1. 저장된 M3U & EPG URL 불러오기 (서버 설정 또는 로컬스토리지)
        const defaultM3u = localStorage.getItem('m3u_default_url') || '';
        const defaultEpg = localStorage.getItem('m3u_default_epg_url') || '';

        if (defaultM3u) urlInput.value = defaultM3u;
        if (defaultEpg) epgInput.value = defaultEpg;

        // 2. 이벤트 바인딩
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
            alert('기본 M3U 및 EPG 주소가 저장되었습니다.\n다음 접속 시 자동으로 로드됩니다.');
        });

        urlInput.addEventListener('keydown', (e) => {
            if (e.key === 'Enter' && urlInput.value.trim()) loadM3UFromUrl(urlInput.value.trim());
        });

        fileInput.addEventListener('change', handleFileUpload);
        searchInput.addEventListener('input', renderFilteredChannels);
        groupSelectEl.addEventListener('change', renderFilteredChannels);

        // 3. 기본 URL이 있으면 자동 로드 실행
        if (defaultEpg) {
            loadEPGFromUrl(defaultEpg);
        }
        if (defaultM3u) {
            loadM3UFromUrl(defaultM3u);
        }
    }

    // M3U 파서 (EXTINF에서 tvg-id, tvg-name, tvg-logo 추출)
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

    // EPG (XMLTV) 파서
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
        // YYYYMMDDHHMMSS 형식 파싱
        const clean = str.replace(/[^0-9]/g, '');
        if (clean.length < 14) return new Date();
        const y = clean.substr(0, 4);
        const m = clean.substr(4, 2) - 1;
        const d = clean.substr(6, 2);
        const h = clean.substr(8, 2);
        const min = clean.substr(10, 2);
        const s = clean.substr(12, 2);
        return new Date(Date.UTC(y, m, d, h - 9, min, s)); // KST 기준 보정
    }

    function getCurrentProgram(channel) {
        if (!channel) return null;
        const list = epgProgrammes[channel.id] || epgProgrammes[channel.name];
        if (!list || list.length === 0) return null;

        const now = new Date();
        return list.find(p => p.start <= now && (!p.stop || p.stop >= now)) || list[0];
    }

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

        // 첫 번째 채널 자동 재생 (선택)
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

            // 로고
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

            // 채널명 및 실시간 EPG 프로그램
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

    function playStream(channel) {
        activeChannel = channel;
        currentTitleEl.textContent = channel.name;
        currentGroupEl.textContent = channel.group || 'Live';
        updateCurrentChannelEPG();

        if (hlsInstance) {
            hlsInstance.destroy();
            hlsInstance = null;
        }

        const streamUrl = channel.url;

        if (window.Hls && window.Hls.isSupported()) {
            hlsInstance = new window.Hls({
                enableWorker: true,
                lowLatencyMode: true,
                backBufferLength: 30
            });

            hlsInstance.loadSource(streamUrl);
            hlsInstance.attachMedia(videoEl);

            hlsInstance.on(window.Hls.Events.MANIFEST_PARSED, () => {
                setOverlay('', false);
                videoEl.play().catch(e => console.log('[M3UPlayer] Play:', e));
            });

            hlsInstance.on(window.Hls.Events.ERROR, (event, data) => {
                if (data.fatal) {
                    switch (data.type) {
                        case window.Hls.ErrorTypes.NETWORK_ERROR:
                            setOverlay('스트림 연결 실패 (스트림 오프라인 또는 CORS)', true);
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
            videoEl.src = streamUrl;
            videoEl.addEventListener('loadedmetadata', () => {
                setOverlay('', false);
                videoEl.play().catch(e => console.log('[M3UPlayer] Play:', e));
            });
        }

        renderFilteredChannels();
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