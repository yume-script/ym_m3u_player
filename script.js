// plugins/metadata/m3u_player/script.js
(function () {
    let hlsInstance = null;
    let allChannels = [];
    let activeChannel = null;

    const videoEl = document.getElementById('m3uVideoPlayer');
    const overlayEl = document.getElementById('m3uPlayerOverlay');
    const overlayText = document.getElementById('m3uOverlayText');
    const channelListEl = document.getElementById('m3uChannelList');
    const channelCountEl = document.getElementById('m3uChannelCount');
    const groupSelectEl = document.getElementById('m3uGroupSelect');
    const searchInput = document.getElementById('m3uSearchInput');
    const urlInput = document.getElementById('m3uUrlInput');
    const loadBtn = document.getElementById('m3uLoadBtn');
    const fileInput = document.getElementById('m3uFileInput');
    const directPlayBtn = document.getElementById('m3uDirectPlayBtn');

    const currentTitleEl = document.getElementById('m3uCurrentChannelTitle');
    const currentGroupEl = document.getElementById('m3uCurrentChannelGroup');

    function init() {
        const savedUrl = localStorage.getItem('m3u_player_last_url') || '';
        if (savedUrl) {
            urlInput.value = savedUrl;
        }

        loadBtn.addEventListener('click', () => {
            const url = urlInput.value.trim();
            if (url) loadM3UFromUrl(url);
        });

        urlInput.addEventListener('keydown', (e) => {
            if (e.key === 'Enter') {
                const url = urlInput.value.trim();
                if (url) loadM3UFromUrl(url);
            }
        });

        fileInput.addEventListener('change', handleFileUpload);
        directPlayBtn.addEventListener('click', handleDirectPlay);
        searchInput.addEventListener('input', renderFilteredChannels);
        groupSelectEl.addEventListener('change', renderFilteredChannels);
    }

    // M3U 파서
    function parseM3U(content) {
        const lines = content.split(/\r?\n/);
        const channels = [];
        let currentInfo = null;

        for (let i = 0; i < lines.length; i++) {
            const line = lines[i].trim();
            if (!line) continue;

            if (line.startsWith('#EXTINF:')) {
                currentInfo = {
                    name: '이름 없는 채널',
                    logo: '',
                    group: '기타 (Etc)',
                    url: ''
                };

                const groupMatch = line.match(/group-title="([^"]+)"/i);
                if (groupMatch) currentInfo.group = groupMatch[1];

                const logoMatch = line.match(/tvg-logo="([^"]+)"/i);
                if (logoMatch) currentInfo.logo = logoMatch[1];

                const commaIdx = line.lastIndexOf(',');
                if (commaIdx !== -1) {
                    const name = line.substring(commaIdx + 1).trim();
                    if (name) currentInfo.name = name;
                }
            } else if (!line.startsWith('#') && currentInfo) {
                currentInfo.url = line;
                channels.push(currentInfo);
                currentInfo = null;
            }
        }
        return channels;
    }

    async function loadM3UFromUrl(url) {
        setOverlay('M3U 목록을 불러오는 중...', true);
        try {
            const response = await fetch(url);
            if (!response.ok) throw new Error(`HTTP ${response.status}`);
            const text = await response.text();
            processM3UData(text);
            localStorage.setItem('m3u_player_last_url', url);
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

    function handleDirectPlay() {
        const url = prompt('재생할 m3u8 또는 HLS 스트림 URL을 입력하세요:');
        if (!url) return;

        playStream({
            name: 'Direct Stream',
            group: 'Direct Play',
            logo: '',
            url: url.trim()
        });
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
    }

    // 채널 리스트 렌더링
    function renderFilteredChannels() {
        const keyword = searchInput.value.toLowerCase().trim();
        const selectedGroup = groupSelectEl.value;

        const filtered = allChannels.filter(c => {
            const matchesGroup = !selectedGroup || c.group === selectedGroup;
            const matchesKeyword = !keyword || c.name.toLowerCase().includes(keyword) || c.group.toLowerCase().includes(keyword);
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

            // 로고 컨테이너 박스
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

            const group = document.createElement('div');
            group.className = 'm3u-ch-group';
            group.textContent = ch.group;

            info.appendChild(name);
            info.appendChild(group);

            item.appendChild(logoBox);
            item.appendChild(info);

            item.addEventListener('click', () => playStream(ch));
            channelListEl.appendChild(item);
        });
    }

    // HLS 재생
    function playStream(channel) {
        activeChannel = channel;
        currentTitleEl.textContent = channel.name;
        currentGroupEl.textContent = channel.group || 'Live Stream';

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
                videoEl.play().catch(e => console.log('[M3UPlayer] Autoplay blocked:', e));
            });

            hlsInstance.on(window.Hls.Events.ERROR, (event, data) => {
                if (data.fatal) {
                    console.error('[M3UPlayer] HLS Error:', data);
                    switch (data.type) {
                        case window.Hls.ErrorTypes.NETWORK_ERROR:
                            setOverlay('스트림 연결 실패 (CORS 또는 스트림 오프라인)', true);
                            hlsInstance.startLoad();
                            break;
                        case window.Hls.ErrorTypes.MEDIA_ERROR:
                            setOverlay('디코딩 복구 시도 중...', true);
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
                videoEl.play().catch(e => console.log('[M3UPlayer] Autoplay blocked:', e));
            });
        } else {
            alert('현재 브라우저에서 HLS 재생을 지원하지 않습니다.');
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