# -*- coding: utf-8 -*-
from plugins.metadata.base import BaseMetadataProvider


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

    def apply(self, db_type, book_id, item_data):
        return False, "카테고리 뷰 전용 플레이어 플러그인입니다."