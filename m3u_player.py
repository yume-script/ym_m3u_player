# -*- coding: utf-8 -*-
from plugins.metadata.base import BaseMetadataProvider


class M3UPlayerPlugin(BaseMetadataProvider):
    id = "m3u_player"
    name = "M3U 플레이어"
    is_searchable = False

    # 좌측 사이드바 카테고리 메뉴 등록 (1등 시민 뷰)
    category_tab = {
        "title": "M3U 플레이어",
        "icon": "fa-solid fa-tv",
        "order": 85,
        "sessions": "all",  # general, adult, audiobook, video 모든 세션 노출
    }

    # 관리자 설정 폼 스키마
    config_schema = [
        {
            "key": "DEFAULT_M3U_URL",
            "label": "기본 M3U/M3U8 재생목록 URL",
            "type": "text",
            "required": False,
            "default": ""
        }
    ]

    def search(self, db_type, query):
        """메타데이터 검색 미지원 플러그인"""
        return {"success": True, "items": []}

    def apply(self, db_type, book_id, item_data):
        """메타데이터 적용 미지원 플러그인"""
        return False, "카테고리 뷰 전용 플레이어 플러그인입니다."