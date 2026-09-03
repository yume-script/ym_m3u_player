# -*- coding: utf-8 -*-
"""
ym_m3u_player.py
-------------
BookOasis 카테고리탭 플러그인 - 5개 세트 M3U/EPG 소스를 등록해두고
좌측 사이드바 독립 화면에서 실시간으로 재생/편성표를 보여준다.

⚠️ 설정 저장 위치 (중요, 변경됨)
설정(5개 세트의 M3U/EPG URL 등)의 진짜 저장소는 더 이상 DB가 아니라
파일이다:

    <앱 루트>/plugins/data/ym_m3u_player/sources.json

앱 루트는 이 파일 자신의 경로에서 "plugins" 디렉터리를 역산해 구한다
(_resolve_app_root 참고) — 서버 프로세스의 현재 작업 디렉터리(cwd)에
의존하지 않는다.

이렇게 바꾼 이유: BookOasis 관리자 설정 화면(config_schema)에 입력한 값은
BookOasis 코어가 자체 DB에 저장하는데, 이 DB는 컴퓨터를 옮기거나 재설치할 때
함께 보존되지 않을 수 있다. 반면 plugins/metadata/<id>/(플러그인 코드,
업데이트 시 통째로 교체됨)와 분리된 plugins/data/<id>/(플러그인 데이터,
재설치·이전에도 보존됨)는 다른 BookOasis 플러그인(예: rclone_g2g_copy)에서도
이미 이 용도로 쓰이는 위치다.

동작 방식:
- get_dashboard_data(): 먼저 sources.json을 읽는다. 파일이 아직 없으면
  (플러그인을 처음 설치한 직후) 관리자 설정 화면(config_schema, DB 저장)의
  값을 딱 한 번 시드로 읽어와 그대로 sources.json에도 저장해둔다. 이후로는
  파일이 유일한 진짜 저장소가 된다.
- apply(): 카테고리탭의 "⚙️ 소스 관리" 모달에서 저장하면 sources.json에만
  쓴다(DB에는 쓰지 않는다).

⚠️ 트레이드오프: 이 변경 이후로는 관리자 설정 화면(config_schema)에서 값을
고쳐도 sources.json이 이미 존재하면 더 이상 반영되지 않는다(최초 1회 시드
용도로만 쓰이기 때문). 소스 변경은 이제부터 카테고리탭의 "⚙️ 소스 관리"
모달을 통해서만 하는 것을 권장한다.

카테고리탭 프론트(script.js)는
    GET /api/media/dashboard/widgets/{plugin_id}/data?type={dbType}
로 get_dashboard_data(db_type, limit)의 반환값을 받는다.

커스텀 저장 액션(단순 book 메타데이터가 아닌 임의의 데이터 저장)은
plugin_board / scan_scheduler와 동일하게
    POST /api/media/books/0/apply-metadata
    body: {"type": db_type, "source": plugin_id, "item_data": {...}}
로 apply(db_type, book_id, item_data)를 호출해 처리한다 (book_id=0은 더미).
item_data.action으로 여러 커스텀 기능을 구분한다: save_sources(소스 저장),
search_youtube(유튜브 검색), resolve_youtube_url(재생 URL 추출),
save_youtube_picks(유튜브 선택 목록 저장). 아래 "유튜브 검색/저장/재생" 섹션 참고.

📺 유튜브 검색 / 체크 저장 / 재생 (yt-dlp 기반)
카테고리탭에서 유튜브를 키워드로 검색하고, 체크한 영상만 골라
plugins/data/ym_m3u_player/youtube_picks.json에 저장해두는 기능이다.
검색은 yt-dlp의 `ytsearchN:키워드` 문법을 쓰므로 유튜브 Data API 키가
필요 없다. 단, 유튜브의 실제 재생 주소는 시간 제한이 있는 서명된 링크라
저장 시점의 값을 그대로 재사용할 수 없다 — 그래서 저장 파일에는
video_id/title/channel/thumbnail/is_live 같은 메타데이터만 담고, 재생
버튼을 누르는 바로 그 순간에 서버가 yt-dlp로 최신 재생 주소를 새로
추출해서 넘겨준다(resolve_youtube_url 액션). 이 방식의 한계:
- yt-dlp는 유튜브가 서명/보호 로직을 바꿀 때마다 업데이트가 필요한
  비공식 추출 도구라, 특정 시점에 일부 영상(특히 연령제한/일부 라이브)의
  재생이 실패할 수 있다.
- requirements.txt로 yt-dlp가 이 플러그인 전용 libs/ 폴더에 자동 설치되며,
  설치 전/실패 시에도 이 기능만 에러 메시지로 안내되고 M3U 재생 등 다른
  기능에는 영향이 없다.
"""

import json
import os

from plugins.metadata.base import BaseMetadataProvider


# 이 플러그인의 설정 파일 경로(코드 위치 plugins/metadata/m3u_player/와는 별개;
# 데이터 경로는 id(ym_m3u_player) 기준으로 잡는다). google_links / rclone_g2g_copy
# 플러그인과 동일하게 plugins/data/<플러그인id>/ 관례를 따르되, 실제 절대경로는
# cwd가 아니라 _resolve_app_root()로 계산한다.
_PLUGIN_ID_FOR_PATH = "ym_m3u_player"


def _resolve_app_root():
    """plugins/data/ 절대 경로를 앱 실행 cwd에 의존하지 않고 계산한다.

    기존 코드는 os.path.join(".", "plugins", "data", ...) 처럼 현재 작업
    디렉터리(cwd) 기준 상대경로를 썼는데, systemd/docker 등에서 서버가 다른
    cwd로 기동되면 sources.json이 엉뚱한 위치에 생기거나 재시작할 때마다
    새로 시드되는 문제가 있었다. 대신 이 파일 자신의 경로
    (.../plugins/metadata/m3u_player/ym_m3u_player.py)에서 "plugins" 디렉터리를
    역산해 앱 루트를 찾는다. 예상치 못한 배치 구조라 "plugins"를 못 찾으면
    기존 동작(cwd 기준 상대경로)으로 안전하게 폴백한다.
    """
    this_dir = os.path.abspath(os.path.dirname(__file__))
    parts = this_dir.split(os.sep)
    if "plugins" in parts:
        last_plugins_idx = len(parts) - 1 - parts[::-1].index("plugins")
        root = os.sep.join(parts[:last_plugins_idx])
        if root:
            return root
    # 폴백: 기존과 동일하게 cwd 기준
    return "."


DATA_DIR = os.path.join(_resolve_app_root(), "plugins", "data", _PLUGIN_ID_FOR_PATH)
CONFIG_FILE = os.path.join(DATA_DIR, "sources.json")
YOUTUBE_PICKS_FILE = os.path.join(DATA_DIR, "youtube_picks.json")

# 플러그인 코드 자신의 버전 파일 (plugins/data/의 사용자 설정과는 별개 — 코드 위치 옆에 있는
# VERSION 파일). 카테고리탭 화면에서 "현재 버전 vs GitHub 최신 버전" 배지를 보여줄 때
# get_dashboard_data()가 이 값을 함께 내려준다.
_PLUGIN_CODE_DIR = os.path.dirname(os.path.abspath(__file__))
VERSION_FILE = os.path.join(_PLUGIN_CODE_DIR, "VERSION")


def _read_local_version():
    """VERSION 파일에서 "plugin version" 값을 읽는다. 파일이 없거나 형식이 깨졌으면
    프런트가 안전하게 처리할 수 있도록 None을 반환한다(예외를 던지지 않는다)."""
    try:
        with open(VERSION_FILE, "r", encoding="utf-8") as f:
            data = json.load(f)
        version = str(data.get("plugin version") or "").strip()
        return version or None
    except (OSError, json.JSONDecodeError, AttributeError):
        return None

# 최초 설치 직후, sources.json이 아직 없을 때 관리자 설정 화면(config_schema)의
# 값을 시드로 읽어오기 위한 DB 조회 스코프. 이 플러그인 설정은 라이브러리
# 스코프와 무관한 전역 값이므로 항상 "general" 하나로 고정한다.
CONFIG_SCOPE = "general"

DEFAULT_SLOTS = [
    {"enabled": True, "name": "개인", "m3u": "", "epg": ""},
    {
        "enabled": False,
        "name": "iptv-org",
        "m3u": "https://iptv-org.github.io/iptv/countries/kr.m3u",
        # ⚠️ iptv-org/epg 저장소가 GitHub Actions 실행이 중단되면서 사전빌드 가이드 파일
        # 제공을 완전히 중단했다("We are no longer able to provide pre-made guides due to
        # the disabling of GitHub Actions" - 저장소 공식 안내, 2026-09 기준). 그 결과
        # https://iptv-org.github.io/epg/guides/*.xml 계열 URL은 전부 404가 나므로 기본값을
        # 비워둔다. M3U 재생목록(iptv-org/iptv 저장소, 별개)은 이 영향을 받지 않아 그대로 둔다.
        "epg": "",
    },
    {"enabled": False, "name": "FAST", "m3u": "", "epg": ""},
    {"enabled": False, "name": "세트 4", "m3u": "", "epg": ""},
    {"enabled": False, "name": "세트 5", "m3u": "", "epg": ""},
]


class YM_M3UPlayerPlugin(BaseMetadataProvider):
    id = "ym_m3u_player"
    name = "M3U 플레이어"
    is_searchable = False

    category_tab = {
        "title": "M3U 플레이어",
        "icon": "fa-solid fa-tv",
        "order": 85,
        "sessions": "all",
    }

    # 5개 소스 세트 config_schema 구성.
    # ⚠️ 이제 이 값들은 "최초 설치 시 1회 시드"로만 쓰인다 - 실제 진짜 저장소는
    # sources.json 파일이다. 자세한 내용은 파일 상단 docstring 참고.
    config_schema = [
        # Set 1 (기본: 개인 소스)
        {"key": "ENABLE_1", "label": "[세트 1] 활성화", "type": "checkbox", "default": True},
        {"key": "NAME_1", "label": "[세트 1] 이름/태그", "type": "text", "default": "개인"},
        {"key": "M3U_1", "label": "[세트 1] M3U URL", "type": "text", "default": ""},
        {"key": "EPG_1", "label": "[세트 1] EPG URL", "type": "text", "default": ""},

        # Set 2 (기본: iptv-org)
        {"key": "ENABLE_2", "label": "[세트 2] 활성화", "type": "checkbox", "default": False},
        {"key": "NAME_2", "label": "[세트 2] 이름/태그", "type": "text", "default": "iptv-org"},
        {"key": "M3U_2", "label": "[세트 2] M3U URL", "type": "text", "default": "https://iptv-org.github.io/iptv/countries/kr.m3u"},
        {"key": "EPG_2", "label": "[세트 2] EPG URL", "type": "text", "default": ""},

        # Set 3
        {"key": "ENABLE_3", "label": "[세트 3] 활성화", "type": "checkbox", "default": False},
        {"key": "NAME_3", "label": "[세트 3] 이름/태그", "type": "text", "default": "FAST"},
        {"key": "M3U_3", "label": "[세트 3] M3U URL", "type": "text", "default": ""},
        {"key": "EPG_3", "label": "[세트 3] EPG URL", "type": "text", "default": ""},

        # Set 4
        {"key": "ENABLE_4", "label": "[세트 4] 활성화", "type": "checkbox", "default": False},
        {"key": "NAME_4", "label": "[세트 4] 이름/태그", "type": "text", "default": "세트 4"},
        {"key": "M3U_4", "label": "[세트 4] M3U URL", "type": "text", "default": ""},
        {"key": "EPG_4", "label": "[세트 4] EPG URL", "type": "text", "default": ""},

        # Set 5
        {"key": "ENABLE_5", "label": "[세트 5] 활성화", "type": "checkbox", "default": False},
        {"key": "NAME_5", "label": "[세트 5] 이름/태그", "type": "text", "default": "세트 5"},
        {"key": "M3U_5", "label": "[세트 5] M3U URL", "type": "text", "default": ""},
        {"key": "EPG_5", "label": "[세트 5] EPG URL", "type": "text", "default": ""},
    ]

    def search(self, db_type, query):
        return {"success": True, "items": []}

    # ------------------------------------------------------------------
    # 📺 유튜브 검색 / 체크 저장 / 재생용 URL 추출 (yt-dlp)
    # ------------------------------------------------------------------
    # yt-dlp는 requirements.txt로 이 플러그인 전용 libs/ 폴더에 격리 설치된다
    # (guide_plugins.md "플러그인 캐시"/패키지 격리 절 참고). 여기서는 지연 import로
    # 불러온다 — 설치 전이거나 실패해도 플러그인의 다른 기능(M3U 재생 등)은
    # 영향받지 않고, 이 기능을 실제로 쓸 때만 에러 메시지로 안내한다.
    #
    # 아래 클라이언트 선정/헤더/타임아웃 값들은 이 서버에서 이미 안정적으로 쓰이고 있는
    # 다른 플러그인의 yt-dlp 연동(ytdlp_library.py)을 참고해 맞췄다 — 안드로이드 계열
    # 클라이언트를 우선하고 웹 클라이언트를 마지막 폴백으로 두는 순서, 모바일 UA 명시,
    # 넉넉한 타임아웃 등은 데이터센터/도커 환경에서 유튜브의 봇 감지를 우회하는 데
    # 실전에서 효과가 있었던 조합이다.
    _YTDLP_USER_AGENT = (
        "Mozilla/5.0 (Linux; Android 13; Pixel 7) AppleWebKit/537.36 "
        "(KHTML, like Gecko) Chrome/120.0.6099.230 Mobile Safari/537.36"
    )

    @staticmethod
    def _import_yt_dlp():
        try:
            # 프로세스가 이미 떠 있는 동안 requirements.txt 설치가 뒤늦게 끝난 경우에도
            # (재시작 없이) 바로 잡아낼 수 있도록 모듈 캐시를 무효화한 뒤 import한다.
            import importlib
            importlib.invalidate_caches()
            import yt_dlp  # noqa: WPS433 (의도적 지연 import)
            return yt_dlp, None
        except ImportError:
            return None, (
                "yt-dlp가 설치되어 있지 않습니다. 관리자에게 플러그인 재설치/서버 재시작을 "
                "요청해주세요 (requirements.txt를 통해 자동 설치되어야 합니다)."
            )

    @classmethod
    def _base_ydl_opts(cls):
        return {
            "quiet": True,
            "no_warnings": True,
            "noplaylist": True,  # 검색/재생 대상은 항상 단일 영상 — 실수로 재생목록 전체를 긁지 않는다
            "retries": 2,
            "socket_timeout": 20,
            "http_headers": {"User-Agent": cls._YTDLP_USER_AGENT},
        }

    # 2025년 말부터 yt-dlp는 유튜브의 'web' 클라이언트 기준으로는 서명 해독을 위해
    # 별도 JavaScript 런타임(Deno 등)이 있어야 완전히 동작하도록 바뀌었다
    # (https://github.com/yt-dlp/yt-dlp/wiki/EJS). 서버에 그런 런타임을 설치해달라고
    # 요구하면 배포 난이도가 크게 오르므로, JS 런타임이 필요 없는 안드로이드 계열
    # 클라이언트를 우선 시도하고, 'web'은 마지막 폴백으로만 둔다. player_skip으로
    # 불필요한 설정 조회도 건너뛴다. 유튜브가 특정 클라이언트를 막으면(흔한 일이다)
    # 다음 후보로 자동으로 넘어간다.
    _YTDLP_CLIENT_CANDIDATES = (
        ["android"],
        ["android_vr"],
        ["tv"],
        ["web"],
    )

    def _run_ytdlp_with_client_fallback(self, run_once):
        """run_once(extra_ydl_opts) -> 결과를 반환하는 콜백을 여러 player_client
        후보로 순차 시도한다. 첫 성공을 반환하고, 전부 실패하면 마지막 에러를
        사람이 읽을 수 있는 한국어 안내로 감싸서 반환한다."""
        last_error = None
        for client in self._YTDLP_CLIENT_CANDIDATES:
            extra_opts = {
                "extractor_args": {
                    "youtube": {"player_client": client, "player_skip": ["configs"]}
                }
            }
            try:
                return run_once(extra_opts), None
            except Exception as e:  # yt-dlp는 다양한 자체 예외를 던지므로 광범위하게 처리
                last_error = e
                continue

        return None, self._friendly_ytdlp_error(last_error)

    @staticmethod
    def _friendly_ytdlp_error(exc):
        """yt-dlp 예외를 사람이 읽을 수 있는 한국어 안내로 정리한다."""
        msg = str(exc or "").strip() or "알 수 없는 오류"
        lowered = msg.lower()
        if "expecting value" in lowered or "failed to parse json" in lowered or "jsondecodeerror" in lowered:
            return (
                "유튜브가 이 서버 IP의 요청을 막았거나(빈 응답/차단), 서버의 yt-dlp가 오래됐을 "
                "수 있습니다. 관리자에게 yt-dlp를 최신 버전으로 올려달라고 요청해주세요. "
                "잠시 후 다시 시도하면 될 수도 있습니다."
            )
        if "no supported javascript runtime" in lowered or "js runtime" in lowered:
            return (
                "이 서버에 유튜브 처리에 필요한 JavaScript 런타임(Deno 등)이 없습니다. "
                "관리자에게 https://github.com/yt-dlp/yt-dlp/wiki/EJS 참고해 Deno 설치를 "
                "요청해주세요."
            )
        if "sign in to confirm" in lowered or "not a bot" in lowered:
            return "유튜브가 봇 확인을 요구하고 있어 이 서버에서는 추출이 막혔습니다."
        if "429" in msg or "too many requests" in lowered:
            return "유튜브 요청이 일시적으로 제한됐습니다(429). 잠시 후 다시 시도하세요."
        return f"유튜브 처리 실패: {msg}"

    def _run_ytdlp_search(self, query, limit=15):
        """ytsearchN:검색어 표현으로 유튜브 검색 결과 메타데이터만 빠르게 가져온다
        (API 키 불필요). extract_flat 옵션으로 각 영상의 실제 스트림까지는 파고들지
        않아 검색 자체는 비교적 빠르다."""
        yt_dlp, err = self._import_yt_dlp()
        if err:
            return None, err

        limit = max(1, min(int(limit or 15), 30))  # 과도한 검색량 방지

        def run_once(extra_opts):
            ydl_opts = self._base_ydl_opts()
            ydl_opts.update({
                "extract_flat": "in_playlist",
                "skip_download": True,
            })
            ydl_opts.update(extra_opts)
            with yt_dlp.YoutubeDL(ydl_opts) as ydl:
                return ydl.extract_info(f"ytsearch{limit}:{query}", download=False)

        info, err = self._run_ytdlp_with_client_fallback(run_once)
        if err:
            return None, err

        entries = (info or {}).get("entries") or []
        results = []
        for entry in entries:
            if not entry:
                continue
            video_id = entry.get("id")
            results.append({
                "video_id": video_id,
                "title": entry.get("title") or "(제목 없음)",
                "channel": entry.get("uploader") or entry.get("channel") or "",
                "thumbnail": entry.get("thumbnail")
                    or (f"https://i.ytimg.com/vi/{video_id}/hqdefault.jpg" if video_id else ""),
                "is_live": bool(entry.get("is_live")),
                "duration": entry.get("duration"),
            })
        return results, None

    def _run_ytdlp_resolve(self, video_id):
        """실제 재생 시점에 호출된다. 유튜브 재생 URL은 시간 제한이 있는 서명된
        링크라 저장해둘 수 없으므로, 클릭할 때마다 매번 새로 추출한다. 가능하면
        hls.js가 바로 처리할 수 있는 m3u8(HLS) 포맷을 우선한다(주로 라이브 방송)."""
        yt_dlp, err = self._import_yt_dlp()
        if err:
            return None, err

        url = f"https://www.youtube.com/watch?v={video_id}"

        def run_once(extra_opts):
            ydl_opts = self._base_ydl_opts()
            ydl_opts.update({
                "skip_download": True,
                "format": "best[protocol*=m3u8]/best",
            })
            ydl_opts.update(extra_opts)
            with yt_dlp.YoutubeDL(ydl_opts) as ydl:
                return ydl.extract_info(url, download=False)

        info, err = self._run_ytdlp_with_client_fallback(run_once)
        if err:
            return None, err

        if not info:
            return None, "영상 정보를 가져오지 못했습니다."

        stream_url = info.get("url")
        protocol = info.get("protocol") or ""
        if not stream_url or "m3u8" not in protocol:
            # 최상위 선택 결과가 m3u8이 아니면 formats 목록에서 직접 찾는다.
            for f in (info.get("formats") or []):
                if "m3u8" in (f.get("protocol") or "") and f.get("url"):
                    stream_url = f["url"]
                    break

        if not stream_url:
            return None, "재생 가능한 스트림 주소를 찾지 못했습니다 (연령제한/비공개 영상이거나 유튜브 정책 변경일 수 있습니다)."

        return {
            "stream_url": stream_url,
            "is_live": bool(info.get("is_live")),
            "title": info.get("title") or "",
        }, None

    # ------------------------------------------------------------------
    # 유튜브 선택 목록 파일 저장소 (./plugins/data/ym_m3u_player/youtube_picks.json)
    # ------------------------------------------------------------------
    @staticmethod
    def _load_youtube_picks():
        try:
            with open(YOUTUBE_PICKS_FILE, "r", encoding="utf-8") as f:
                data = json.load(f)
            return data if isinstance(data, list) else []
        except (FileNotFoundError, json.JSONDecodeError, OSError):
            return []

    @staticmethod
    def _save_youtube_picks(picks):
        os.makedirs(DATA_DIR, exist_ok=True)
        tmp_path = YOUTUBE_PICKS_FILE + ".tmp"
        with open(tmp_path, "w", encoding="utf-8") as f:
            json.dump(picks, f, ensure_ascii=False, indent=2)
        os.replace(tmp_path, YOUTUBE_PICKS_FILE)

    @staticmethod
    def _sanitize_youtube_picks(raw_picks):
        """프런트에서 받은 체크 목록을 신뢰하지 않고 필요한 필드만 뽑아 정제한다."""
        picks = []
        for p in raw_picks or []:
            if not isinstance(p, dict):
                continue
            video_id = str(p.get("video_id") or "").strip()
            if not video_id:
                continue
            picks.append({
                "video_id": video_id,
                "title": str(p.get("title") or ""),
                "channel": str(p.get("channel") or ""),
                "thumbnail": str(p.get("thumbnail") or ""),
                "is_live": bool(p.get("is_live")),
            })
        return picks

    # ------------------------------------------------------------------
    # 설정 <-> slots 배열 변환 헬퍼
    # ------------------------------------------------------------------
    @staticmethod
    def _slots_from_config(config):
        """config dict(config_schema 키 형식)를 프론트(script.js)가 쓰는
        slots 배열 형식으로 변환한다."""
        config = config or {}
        slots = []
        for i in range(1, 6):
            default_slot = DEFAULT_SLOTS[i - 1]
            slots.append({
                "enabled": bool(config.get(f"ENABLE_{i}", default_slot["enabled"])),
                "name": config.get(f"NAME_{i}") or default_slot["name"],
                "m3u": config.get(f"M3U_{i}", default_slot["m3u"]) or "",
                "epg": config.get(f"EPG_{i}", default_slot["epg"]) or "",
            })
        return slots

    @staticmethod
    def _config_from_slots(slots):
        """slots 배열을 config_schema와 동일한 키의 dict로 변환한다.
        (sources.json에는 항상 이 형태로 20개 키를 빠짐없이 저장한다.)"""
        config = {}
        for i in range(1, 6):
            idx = i - 1
            slot = slots[idx] if idx < len(slots) and isinstance(slots[idx], dict) else {}
            default_slot = DEFAULT_SLOTS[idx]
            config[f"ENABLE_{i}"] = bool(slot.get("enabled", default_slot["enabled"]))
            config[f"NAME_{i}"] = str(slot.get("name") or default_slot["name"])
            config[f"M3U_{i}"] = str(slot.get("m3u") or "")
            config[f"EPG_{i}"] = str(slot.get("epg") or "")
        return config

    # ------------------------------------------------------------------
    # 파일 기반 설정 저장소 (./plugins/data/ym_m3u_player/sources.json)
    # ------------------------------------------------------------------
    @staticmethod
    def _load_config_from_file():
        try:
            with open(CONFIG_FILE, "r", encoding="utf-8") as f:
                return json.load(f)
        except FileNotFoundError:
            return None
        except (json.JSONDecodeError, OSError):
            # 파일이 손상됐거나 읽기 실패 - 시드 값으로 새로 만들도록 None 처리
            return None

    @staticmethod
    def _save_config_to_file(config):
        os.makedirs(DATA_DIR, exist_ok=True)
        tmp_path = CONFIG_FILE + ".tmp"
        with open(tmp_path, "w", encoding="utf-8") as f:
            json.dump(config, f, ensure_ascii=False, indent=2)
        # 원자적 교체: 쓰는 도중 프로세스가 죽어도 기존 파일이 반쪽짜리로
        # 깨지지 않도록 임시 파일에 다 쓴 뒤 한 번에 이름을 바꾼다.
        os.replace(tmp_path, CONFIG_FILE)

    def _load_config_with_db_seed(self, db_type):
        """sources.json을 읽되, 파일이 아직 없으면(최초 설치 직후) 관리자
        설정 화면(config_schema, DB)의 값을 1회 시드로 읽어와 파일에도 저장한다."""
        config = self._load_config_from_file()
        if config is not None:
            return config

        try:
            # ⚠️ 이전 버전 버그: gateway.get_plugin_config(self.id, ...)로 호출했었다.
            # get_plugin_config()는 게이트웨이(get_db_gateway()의 반환값)의 메서드가
            # 아니라 플러그인 베이스 클래스 자신(self)의 헬퍼이며 시그니처도
            # self.get_plugin_config(db_type, default={}) 이다. 잘못된 호출이라
            # 항상 AttributeError가 나서 여기 except에 조용히 삼켜졌고, 그 결과
            # 관리자 설정 화면(config_schema)에 입력해둔 값이 한 번도 시드되지 못하고
            # 매번 빈 설정({})으로만 sources.json이 생성되는 문제가 있었다.
            config = self.get_plugin_config(CONFIG_SCOPE, default={}) or {}
        except Exception:
            config = {}

        try:
            self._save_config_to_file(config)
        except OSError:
            pass  # 시드 저장에 실패해도 이번 응답 자체는 정상 반환한다

        return config

    # ------------------------------------------------------------------
    # 카테고리탭 데이터 조회 (GET .../widgets/ym_m3u_player/data?type=...)
    # ------------------------------------------------------------------
    def get_dashboard_data(self, db_type, limit=10):
        # 코어 공통 계약(guide_plugins.md §3)은 {'success': True, 'items': [...]}
        # 형태를 기본으로 하므로, 향후 다른 코어 화면이 이 엔드포인트를 공통 방식으로
        # 다루더라도 깨지지 않도록 success/items를 함께 채워준다. 이 플러그인 자신의
        # script.js는 여전히 커스텀 필드인 slots를 사용한다.
        # version: 카테고리탭이 GitHub 저장소의 VERSION과 비교해 업데이트 필요 여부를
        # 배지로 보여주는 데 사용한다 (파일을 못 읽으면 None — 프런트가 "확인 불가"로 처리).
        # youtube_picks: 사용자가 체크해서 저장해둔 유튜브 영상 목록 (video_id/title/
        # channel/thumbnail/is_live). 실제 재생 URL은 여기 담지 않는다 — 서명된 임시
        # 링크라 저장해봐야 곧 만료되므로, 재생 시점마다 resolve_youtube_url 액션으로
        # 새로 추출한다.
        config = self._load_config_with_db_seed(db_type)
        return {
            "success": True,
            "slots": self._slots_from_config(config),
            "youtube_picks": self._load_youtube_picks(),
            "version": _read_local_version(),
            "items": [],
        }

    # ------------------------------------------------------------------
    # 카테고리탭 "소스 관리" 모달 저장 / 유튜브 검색·저장·재생 URL 추출
    # (POST .../books/0/apply-metadata) — action 필드로 여러 커스텀 기능을 구분한다.
    # ------------------------------------------------------------------
    def apply(self, db_type, book_id, item_data):
        if not isinstance(item_data, dict):
            return False, "카테고리 뷰 전용 플레이어 플러그인입니다."

        action = item_data.get("action")

        if action == "save_sources":
            slots = item_data.get("slots")
            if not isinstance(slots, list) or not slots:
                return False, "저장할 소스 정보가 없습니다."

            config = self._config_from_slots(slots)
            try:
                self._save_config_to_file(config)
            except OSError as e:
                return False, f"설정 파일 저장 실패: {e}"

            return True, "M3U 소스 설정이 저장되었습니다. (plugins/data/ym_m3u_player/sources.json)"

        if action == "search_youtube":
            query = str(item_data.get("query") or "").strip()
            if not query:
                return False, "검색어를 입력해주세요."
            results, err = self._run_ytdlp_search(query, limit=item_data.get("limit"))
            if err:
                return False, err
            # apply()의 표준 반환은 (bool, 문자열 메시지)뿐이라 구조화된 검색 결과를
            # 돌려줄 자리가 없다 — save_sources 액션과 마찬가지로 이 엔드포인트를
            # 커스텀 용도로 재활용하는 것이므로, message 필드에 JSON 문자열을 담아
            # 프런트가 JSON.parse해서 쓰도록 한다.
            return True, json.dumps({"results": results}, ensure_ascii=False)

        if action == "resolve_youtube_url":
            video_id = str(item_data.get("video_id") or "").strip()
            if not video_id:
                return False, "video_id가 없습니다."
            data, err = self._run_ytdlp_resolve(video_id)
            if err:
                return False, err
            return True, json.dumps(data, ensure_ascii=False)

        if action == "save_youtube_picks":
            picks = self._sanitize_youtube_picks(item_data.get("picks"))
            try:
                self._save_youtube_picks(picks)
            except OSError as e:
                return False, f"저장 실패: {e}"
            return True, f"유튜브 선택 목록 {len(picks)}건이 저장되었습니다."

        return False, "카테고리 뷰 전용 플레이어 플러그인입니다."
