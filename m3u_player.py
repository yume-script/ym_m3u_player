# -*- coding: utf-8 -*-
from plugins.metadata.base import BaseMetadataProvider


class M3UPlayerPlugin(BaseMetadataProvider):
    id = "m3u_player"
    name = "M3U 플레이어"
    is_searchable = False

    # 좌측 사이드바 카테고리 1등 시민 메뉴
    category_tab = {
        "title": "M3U 플레이어",
        "icon": "fa-solid fa-tv",
        "order": 85,
        "sessions": "all",
    }

    # 환경설정 폼 스키마 (관리자 설정 화면에 자동 생성됨)
    config_schema = [
        {
            "key": "DEFAULT_M3U_URL",
            "label": "기본 M3U/M3U8 재생목록 URL",
            "type": "text",
            "required": False,
            "default": "",
            "placeholder": "https://example.com/playlist.m3u"
        },
        {
            "key": "DEFAULT_EPG_URL",
            "label": "기본 EPG (XMLTV) URL",
            "type": "text",
            "required": False,
            "default": "",
            "placeholder": "https://example.com/epg.xml"
        },
        {
            "key": "AUTO_LOAD",
            "label": "진입 시 기본 URL 자동 로드",
            "type": "checkbox",
            "default": True
        }
    ]

    def search(self, db_type, query):
        return {"success": True, "items": []}

    def apply(self, db_type, book_id, item_data):
        return False, "카테고리 뷰 전용 플레이어 플러그인입니다."