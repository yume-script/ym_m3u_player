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
        "epg": "https://iptv-org.github.io/epg/guides/kr.xml",
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
        {"key": "EPG_2", "label": "[세트 2] EPG URL", "type": "text", "default": "https://iptv-org.github.io/epg/guides/kr.xml"},

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
        config = self._load_config_with_db_seed(db_type)
        return {
            "success": True,
            "slots": self._slots_from_config(config),
            "items": [],
        }

    # ------------------------------------------------------------------
    # 카테고리탭 "소스 관리" 모달 저장 (POST .../books/0/apply-metadata)
    # ------------------------------------------------------------------
    def apply(self, db_type, book_id, item_data):
        if not isinstance(item_data, dict) or item_data.get("action") != "save_sources":
            return False, "카테고리 뷰 전용 플레이어 플러그인입니다."

        slots = item_data.get("slots")
        if not isinstance(slots, list) or not slots:
            return False, "저장할 소스 정보가 없습니다."

        config = self._config_from_slots(slots)
        try:
            self._save_config_to_file(config)
        except OSError as e:
            return False, f"설정 파일 저장 실패: {e}"

        return True, "M3U 소스 설정이 저장되었습니다. (plugins/data/ym_m3u_player/sources.json)"
