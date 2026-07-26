# Public Token Quota relay

Trang công khai, chỉ đọc, dùng để hiển thị quota token tổng hợp. Cookie, khóa API,
tài khoản và URL nhà cung cấp không được nhận hoặc lưu ở relay.

## API

- `GET /api/quota`: công khai; trả về `limit`, `used`, `remaining` và thời gian cập nhật.
- `POST /api/quota`: riêng tư; yêu cầu `Authorization: Bearer ...`.

Publisher chỉ được gửi đúng ba trường:

```json
{
  "limit": 100000000,
  "used": 1270394,
  "observedAt": "2026-07-26T00:00:00.000Z"
}
```

Secret `PUBLIC_QUOTA_PUBLISH_TOKEN` được lưu trong runtime environment của Sites,
không được đặt trong mã nguồn hoặc gửi tới trình duyệt.
