# Flow Hub

Mini server (Python / FastAPI) điều khiển **Google Flow** qua một extension Chrome làm "worker":
tạo ảnh / nhân vật / video, quản lý job, và **quan sát toàn bộ request** mà trang Flow gửi để cập nhật
nhanh khi Google thay đổi API.

```
 Server khác / app của bạn ──REST + webhook──▶ ┌──────────── Flow Hub (FastAPI) ────────────┐
                                                │ API · hàng đợi job · dựng body · poll video │
 Trình duyệt ──dashboard (cùng cổng)──────────▶ │ lưu media · Observation · Models · Template │
                                                │ SQLite 1 file + thư mục media               │
                                                └─────────────────────▲───────────────────────┘
                                                                      │ WebSocket + token
                                                ┌─────────────────────┴───────────────────────┐
                                                │ Chrome thật + extension "Flow Hub Worker"   │
                                                │ chạy RPC trong tab · mint reCAPTCHA · báo   │
                                                │ traffic của trang (Observation)             │
                                                └─────────────────────┬───────────────────────┘
                                                                      ▼
                                                              flow.google.com
```

Vì sao cần extension: request tới Flow phải chạy **bên trong tab flow.google.com đã đăng nhập** (cookie,
token `at` của trang và reCAPTCHA dùng 1 lần chỉ có ở đó). Extension chỉ thực thi và báo cáo; mọi logic
(dựng body, poll, lưu trữ) nằm ở server — Flow đổi gì thì sửa ở server, không phải cài lại extension.

## Cài đặt & chạy

Yêu cầu: Python 3.11+, Google Chrome 116+.

```powershell
cd flow-hub
python -m venv .venv
.\.venv\Scripts\pip install -r requirements.txt
copy .env.example .env      # tuỳ chọn
.\.venv\Scripts\python -m flowhub      # hoặc: run.bat
```

Mở dashboard: <http://127.0.0.1:8787> · tài liệu API: <http://127.0.0.1:8787/docs>

### Ghép nối extension (worker)

1. `chrome://extensions` → bật **Developer mode** → **Load unpacked** → chọn thư mục `extension/`.
2. Trên dashboard mở **Cài đặt** → copy **URL WebSocket** và **Token**.
3. Bấm icon extension → dán 2 giá trị → **Lưu & kết nối** (trạng thái chuyển "● đã kết nối").
4. Mở <https://flow.google.com>, đăng nhập, vào (hoặc tạo) một project — giữ tab này mở.

Mỗi profile Chrome (một tài khoản Google) là một worker; có thể nối nhiều worker vào cùng server.

## Dashboard

| Trang | Chức năng |
|---|---|
| Tổng quan | worker online, thống kê job, **cảnh báo khi Flow thay đổi** |
| Ảnh / Nhân vật / Video | form tạo (model theo danh mục, tỉ lệ, thời lượng, độ phân giải…), nút **Xem body** |
| Thư viện | ảnh/video đã tạo, upload ảnh lên Flow, thêm theo media ID, upscale 2K/4K, "Dùng cho" (tham chiếu / ảnh đầu / ảnh cuối / ingredient) |
| Jobs | trạng thái từng job, từng request đã gửi (body + response), huỷ / kiểm tra lại / dùng lại |
| Observation | mọi `batchexecute` + lệnh mint reCAPTCHA của trang: header, body, response, **kiểm tra builder**, **tạo template** |
| Models | danh mục wire id (verified / unverified / disabled), đặt mặc định, thêm tay |
| Templates & RPC | chạy lại body của trang với prompt mới; gửi RPC thô để thử nghiệm |
| Cài đặt | ghép nối, project mặc định, bật ghi response, chu kỳ poll, giãn cách lệnh… |

## Khi Flow cập nhật — quy trình

1. Dùng Flow bình thường trên tab có worker → Observation ghi lại mọi request.
2. **Tổng quan** báo tự động khi: xuất hiện RPC mới, model mới (tự thêm vào Models, trạng thái
   *verified*), Flow đổi build (`bl`), action reCAPTCHA đổi (tự học, hub dùng action mới), hoặc
   **builder lệch** — request thật của trang khác body Flow Hub dựng (chỉ ra vị trí khác).
3. Cách xử lý nhanh không cần sửa code: Observation → request của trang → **Tạo template** →
   chạy template với prompt mới (Templates hoặc `POST /api/jobs {"type":"template"}`).
4. Sửa vĩnh viễn: cập nhật builder trong `flowhub/protocol/batch.py`, thêm request thật vào
   `tests/fixtures/observed_requests.json` và chạy test — test bắt builder phải dựng **đúng từng byte**.

## API (cho server khác)

```bash
# text → video (model mặc định của danh mục)
curl -X POST http://127.0.0.1:8787/api/jobs -H "Content-Type: application/json" \
  -d '{"type":"t2v","prompt":"cô gái đàn hát bên cửa sổ","aspect":"16:9","webhook_url":"https://my.app/hook"}'

# Omni Flash 8s 360p, dọc
curl -X POST http://127.0.0.1:8787/api/jobs -H "Content-Type: application/json" \
  -d '{"type":"t2v","prompt":"…","family":"omni_flash","duration":8,"resolution":"360p","aspect":"9:16"}'

# ảnh, 2 biến thể, có ảnh tham chiếu
curl -X POST http://127.0.0.1:8787/api/jobs -H "Content-Type: application/json" \
  -d '{"type":"image","prompt":"…","aspect":"1:1","count":2,"ref_media_ids":["<media id>"]}'

curl http://127.0.0.1:8787/api/jobs/<id>                 # trạng thái + kết quả
curl -O http://127.0.0.1:8787/api/media/<media id>/file  # file đã lưu trên server
```

Loại job: `image`, `character`, `edit`, `t2v`, `i2v`, `first_last`, `r2v`, `upscale`, `template`
(upload: `POST /api/uploads` multipart). Model: `family` + thuộc tính (server tự chọn wire id) hoặc
`model` = wire id chính xác. Webhook: server `POST {event, job}` khi job kết thúc.

**Xác thực**: tự bật khi server không chỉ nghe trên localhost (`FLOWHUB_HOST=0.0.0.0`) hoặc
`FLOWHUB_AUTH=on`; gửi header `X-API-Key`. Key in ra console lúc khởi động (hoặc đặt
`FLOWHUB_API_KEY`). Khi mở ra mạng ngoài, đặt server sau HTTPS/WSS (reverse proxy).

## Trạng thái đã kiểm chứng (07/10/2026)

* Đã chạy thật trên Flow: text → video `veo_3_1_t2v_fast` (từ bản extension trước).
* Body khớp từng byte với request thật của trang: text → video (`veo_3_1_t2v_fast`, `…_portrait`,
  `veo_3_1_t2v_lite`, `abra_t2v_8s`, `abra_t2v_8s_360p`) và ảnh `BELUGA`.
* Chưa thấy trên Flow hiện tại (đánh dấu *unverified* trong Models): ảnh → video, đầu + cuối,
  ingredients, upscale, các model ảnh cũ. Hãy tạo thử một lần trên giao diện Flow — Observation sẽ
  xác minh hoặc báo builder lệch.

## Lưu ý

* Phải có Chrome thật (không headless) đang mở tab Flow đã đăng nhập. Đừng bắn liên tục: mặc định
  giãn cách 2 giây giữa các lệnh tạo; lỗi `PUBLIC_ERROR_UNUSUAL_ACTIVITY` không được tự thử lại.
* Request tạo ảnh chạy **đồng bộ trong tab Flow** (~20 giây): F5 / chuyển trang tab đó giữa chừng sẽ huỷ
  response (`PAGE_UNLOADED`), dù Flow vẫn tạo ảnh. Khi đó hub tự tìm lại ảnh trong project (theo client
  uuid của request, tối đa 150 giây; cần extension ≥ 1.0.1). Muốn xem kết quả trên Flow thì mở một tab
  Flow khác hoặc chờ job xong rồi hãy tải lại.
* Đây là tự động hoá dịch vụ của Google trên tài khoản của bạn — cân nhắc điều khoản sử dụng.
* Token `at`, cookie không bao giờ rời trình duyệt; Observation ẩn cookie trước khi gửi về server.

## Cấu trúc

```
flowhub/
  protocol/batch.py    dựng body + đọc response (nơi duy nhất biết định dạng Flow)
  protocol/observe.py  giải mã traffic, kiểm tra builder, template, reCAPTCHA protobuf
  workers.py           WebSocket tới extension
  jobs.py              hàng đợi, gửi, poll (jwpduf → as29s, Zzl0ze dự phòng), webhook
  observations.py      lưu Observation + phát hiện thay đổi + tự học
  catalog.py           danh mục model (dữ liệu, tự cập nhật)
  media.py, templates.py, api.py, main.py, db.py, web/ (dashboard)
extension/             Flow Hub Worker (Chrome MV3)
tests/                 test giao thức (khớp request thật) + test end-to-end với worker giả
```

Chạy test: `.\.venv\Scripts\pip install -r requirements-dev.txt` rồi `.\.venv\Scripts\python -m pytest`.
