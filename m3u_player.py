# -*- coding: utf-8 -*-
"""
m3u_player.py
-------------
BookOasis 카테고리탭 플러그인 - 5개 세트 M3U/EPG 소스를 등록해두고
좌측 사이드바 독립 화면에서 실시간으로 재생/편성표를 보여준다.

⚠️ 이 파일에서 새로 추가한 get_dashboard_data() / apply()는
BookOasis의 실제 확인된 계약을 그대로 따른다 (ridi_book / dict_lookup /
scan_scheduler / plugin_board 개발 과정에서 서버에서 직접 확인됨):

    services/plugin_db_gateway.py
        def get_plugin_config(self, plugin_id, default=None)
        def set_plugin_config(self, plugin_id, config)

    카테고리탭 프론트(script.js)는
        GET /api/media/dashboard/widgets/{plugin_id}/data?type={dbType}
    로 get_dashboard_data(db_type, limit)의 반환값을 받는다.

    커스텀 저장 액션(단순 book 메타데이터가 아닌 임의의 데이터 저장)은
    plugin_board / scan_scheduler와 동일하게
        POST /api/media/books/0/apply-metadata
        body: {"type": db_type, "source": plugin_id, "item_data": {...}}
    로 apply(db_type, book_id, item_data)를 호출해 처리한다 (book_id=0은 더미).

핵심 설계: config_schema의 20개 키(ENABLE_1..5/NAME_1..5/M3U_1..5/EPG_1..5)를
그대로 get_plugin_config()/set_plugin_config()의 저장 형식으로 재사용한다.
그래서 관리자 설정 화면에서 값을 바꾸든, 카테고리탭의 "⚙️ 소스 관리" 모달에서
바꾸든 항상 같은 저장소를 읽고 쓰게 되어 두 화면이 어긋나지 않는다.

이 플러그인의 설정은 특정 라이브러리(general/adult/audiobook/video)에 종속된
값이 아니라 전역 값이므로, db_type과 무관하게 항상 "general" 스코프의 게이트웨이로
저장/조회한다 (CONFIG_SCOPE 상수). 이렇게 해야 사용자가 어느 사이드바 세션에서
카테고리탭에 들어오든 항상 동일한 소스 설정을 보게 된다.
"""

from plugins.metadata.base import BaseMetadataProvider


# 이 플러그인 설정은 라이브러리 스코프와 무관한 전역 값이라 저장 스코프를 고정한다.
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


class M3UPlayerPlugin(BaseMetadataProvider):
    id = "m3u_player"
    name = "M3U 플레이어"
    is_searchable = False

    category_tab = {
        "title": "M3U 플레이어",
        "icon": "fa-solid fa-tv",
        "order": 85,
        "sessions": "all",
    }

    # 5개 소스 세트 config_schema 구성
    # (아래 키 이름은 get_dashboard_data/apply의 저장 형식과 정확히 맞춰져 있어야 한다)
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
        """get_plugin_config()가 돌려준 dict(config_schema 키 형식)를
        프론트(script.js)가 쓰는 slots 배열 형식으로 변환한다."""
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
        set_plugin_config()가 부분 병합이 아니라 전체 덮어쓰기일 가능성이 있으므로
        (plugin_hub 개발 시 관리자 설정 저장 API가 전체 오버라이트임을 확인한 바 있음)
        항상 20개 키를 빠짐없이 채워서 반환한다."""
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
    # 카테고리탭 데이터 조회 (GET .../widgets/m3u_player/data?type=...)
    # ------------------------------------------------------------------
    def get_dashboard_data(self, db_type, limit=None):
        gateway = self.get_db_gateway(CONFIG_SCOPE)
        config = gateway.get_plugin_config(self.id, default={}) or {}
        return {"slots": self._slots_from_config(config)}

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
        gateway = self.get_db_gateway(CONFIG_SCOPE)
        gateway.set_plugin_config(self.id, config)
        return True, "M3U 소스 설정이 저장되었습니다."
