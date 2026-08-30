📺 BookOasis M3U / IPTV 플레이어 플러그인
북오아시스(BookOasis) 미디어 서버에서 실시간 IPTV 스트리밍 및 M3U 재생목록, XMLTV 편성표(EPG)를 감상할 수 있는 카테고리 레벨(사이드바 1등 시민) 풀페이지 플러그인입니다.
🌟 주요 기능 (Key Features)
1. 🚀 하이브리드 미디어 재생 엔진
HLS (hls.js): 표준 .m3u8 스트리밍 지원
MPEG-TS (mpegts.js): 직접 HTTP TS 스트림(.ts), FLV 규격 자동 감지 및 초저지연 재생
Safari Native Fallback: Apple 기기(iOS, macOS) 네이티브 HLS 가속 지원
2. 🗂️ 최대 5개 멀티 M3U/EPG 소스 병합 관리
개인 스트림(Allive/klive 등)과 공개 스트림(iptv-org, FAST 채널 등)을 최대 5개 세트까지 등록하고 동시 병합
출처별 자동 태깅 ([개인] 지상파, [iptv-org] 뉴스 등)
북오아시스 관리자 환경설정 및 웹 화면 내 [⚙️ 소스 관리] 모달 양방향 완벽 동기화
3. 📅 실시간 EPG (XMLTV 편성표) 타임라인
실시간 진행률 바: 현재 방송 프로그램 제목, 시작/종료 시각, 실시간 진행률(%), 종료까지 남은 시간 실시간 계산 (1초 단위 갱신)
NEXT 예고: 바로 다음 방영 예정 프로그램 미리보기
채널별 미니 진행바: 우측 목록의 모든 채널 카드에도 현재 진행률 바 표시
당일 전체 편성표 팝업 (📅): 현재 채널의 오늘 하루 전체 방영 목록 조회 모달
4. 📺 TV 스타일 OSD (On-Screen Display) 채널 안내창
채널 전환 시 비디오 화면 하단에 **[채널 로고 + 채널명 + EPG 진행바 + NEXT 예고]**가 담긴 반투명 글래스모피즘 안내창이 3.5초간 노출 후 부드럽게 페이드아웃
5. 🩺 스마트 사전 상태 점검 (Health Check)
사전 스트림 검사: [🩺 상태 점검] 버튼으로 전체 채널의 온라인/오프라인 상태를 백그라운드 핑(Ping) 테스트
상태등(Dot): 🟢 정상(Online) / 🔴 오프라인(Offline / 반투명 흐림 처리) / ⚪ 미확인
재생 실패 자동 감지: 클릭 시 CORS/오류로 재생 불가능한 채널을 즉시 🔴 마킹
정상 채널 전용 필터: [x] 🟢 정상만 체크박스로 죽은 채널 숨김 지원
6. 🎮 스마트 TV 조작 편의 기능
키보드 단축키: ▲ / ▼ (이전/다음 채널 전환), F (전체화면)
즐겨찾기 (⭐): 자주 보는 채널 북마크 및 ⭐ 즐겨찾기 채널 전용 필터
8종 대시보드 테마 100% 동기화: 북오아시스 전역 CSS 디자인 토큰 완벽 상속
📂 디렉토리 구조
code
Text
plugins/metadata/
  m3u_player/
    ├── __init__.py          # 플러그인 모듈 등록
    ├── m3u_player.py        # 플러그인 클래스 선언 & 5개 세트 config_schema
    ├── VERSION              # 버전 매니페스트 (1.0.0)
    ├── index.html           # 좌측 플레이어 & 우측 채널/EPG 사이드바 템플릿
    ├── style.css            # 반응형 Grid & 글래스모피즘 테마 스타일시트
    ├── script.js            # 하이브리드 플레이어, XMLTV/M3U 파서, 헬스체크 엔진
    └── README.md            # 플러그인 설명서
⚙️ 설치 및 활성화
북오아시스 서버의 plugins/metadata/m3u_player/ 경로에 위 파일들을 저장합니다.
북오아시스 서버를 재시작합니다.
웹 UI [환경설정 ⚙️] → [플러그인 설정] 탭에서 M3U 플레이어 플러그인을 활성화(ON)합니다.
좌측 사이드바에 생성된 M3U 플레이어 (fa-tv) 메뉴를 클릭하여 진입합니다.
🛠️ 소스 설정 방법 (5개 세트 등록)
방법 A. 웹 화면에서 직접 등록 (추천)
M3U 플레이어 화면 우측 상단의 [⚙️ 소스 관리 (5세트)] 버튼을 클릭합니다.
원하는 세트에 체크(ON) 후 태그명, M3U URL, EPG URL을 입력합니다.
[저장하고 채널 새로고침] 버튼을 누르면 즉시 전체 소스가 병합 로드됩니다.
방법 B. 관리자 환경설정에서 등록
관리자 **[환경설정 ⚙️] → [플러그인 설정] → [M3U 플레이어]**로 이동합니다.
세트 1 ~ 5의 활성화 여부, 이름, M3U/EPG 주소를 입력하고 저장합니다.
🌐 추천 공개 M3U / EPG 주소 예시
소스 이름	M3U URL	EPG (편성표) URL	설명
개인 (Allive 등)	http://내개인서버/alive/api/m3uall?apikey=...	http://내개인서버/myepg/api/epgall?apikey=...	개인 NAS/서버 구축 M3U
한국 공개 (iptv-org)	https://iptv-org.github.io/iptv/countries/kr.m3u	https://iptv-org.github.io/epg/guides/kr.xml	국내 공공/무료 오픈소스 방송
삼성 TV 플러스 (FAST)	https://raw.githubusercontent.com/iptv-org/iptv/master/streams/kr_samsung.m3u	-	무료 FAST 채널 모음
글로벌 뉴스 (Global)	https://iptv-org.github.io/iptv/categories/news.m3u	-	전 세계 실시간 뉴스 채널
⌨️ 조작 가이드 및 단축키
키 / 동작	기능
▲ / ▼ (방향키)	이전 채널 / 다음 채널로 즉시 전환
F 또는 비디오 더블클릭	전체화면(Fullscreen) 토글
⭐ 별표 클릭	해당 채널 즐겨찾기 등록/해제
[📅 편성표] 버튼	현재 채널의 당일 전체 편성표 모달 열기
[🩺 상태 점검] 버튼	M3U 스트림 생존 여부 일괄 핑(Ping) 검사
[x] 🟢 정상만	화면이 안 나오는 오프라인 채널 숨기기
🔒 보안 및 런타임 제약 준수
CORS & Fail-Safe: 연결이 끊어진 스트림은 404/Network Error 감지 후 안전하게 오프라인으로 격리 처리
XSS 방어: 채널명, 그룹명, EPG 타이틀 렌더링 시 DOM TextContent 및 이스케이프 처리 적용
리소스 격리: 외부 의존성 없이 CDN을 통해 hls.js 및 mpegts.js를 안전하게 로드
