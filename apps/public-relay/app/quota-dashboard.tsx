"use client";

import { useCallback, useEffect, useState } from "react";
import {
  DEFAULT_MONTHLY_LIMIT,
  type PublicQuotaResponse,
  type PublicQuotaSnapshot
} from "./lib/public-quota";

const numberFormatter = new Intl.NumberFormat("vi-VN");
const dateFormatter = new Intl.DateTimeFormat("vi-VN", {
  dateStyle: "short",
  timeStyle: "medium"
});

function formatTokens(value: number) {
  return numberFormatter.format(value);
}

function statusText(snapshot: PublicQuotaSnapshot) {
  if (snapshot.status === "stale") return "Dữ liệu đang trễ";
  if (snapshot.status === "exhausted") return "Đã dùng hết";
  if (snapshot.status === "near-limit") return "Sắp chạm giới hạn";
  return "Đang hoạt động";
}

function WaitingState() {
  return (
    <main className="shell">
      <header className="topbar">
        <div className="brand-mark" aria-hidden="true">
          <span />
        </div>
        <div>
          <p className="eyebrow">PUBLIC TOKEN STATUS</p>
          <h1>Quota tháng</h1>
        </div>
      </header>

      <section className="quota-card waiting-card" aria-live="polite">
        <div className="status-row">
          <span className="status-pill waiting">
            <i />
            Đang chờ đồng bộ đầu tiên
          </span>
          <span className="refresh-note">Tự cập nhật mỗi 10 giây</span>
        </div>
        <div className="waiting-number">{formatTokens(DEFAULT_MONTHLY_LIMIT)}</div>
        <p className="waiting-label">giới hạn tháng đã cấu hình</p>
        <div className="skeleton-track">
          <span />
        </div>
        <p className="privacy-copy">
          Máy chính chưa gửi bản ghi quota. Trang này không cần đăng nhập và không chứa
          tài khoản, khóa API, cookie hay địa chỉ nhà cung cấp.
        </p>
      </section>
    </main>
  );
}

export function QuotaDashboard() {
  const [snapshot, setSnapshot] = useState<PublicQuotaResponse | null>(null);
  const [requestFailed, setRequestFailed] = useState(false);

  const refresh = useCallback(async () => {
    try {
      const response = await fetch("/api/quota", { cache: "no-store" });
      if (!response.ok) throw new Error("Quota request failed.");
      setSnapshot((await response.json()) as PublicQuotaResponse);
      setRequestFailed(false);
    } catch {
      setRequestFailed(true);
    }
  }, []);

  useEffect(() => {
    const initialRefresh = window.setTimeout(() => void refresh(), 0);
    const timer = window.setInterval(() => void refresh(), 10_000);
    const onVisibilityChange = () => {
      if (document.visibilityState === "visible") void refresh();
    };
    document.addEventListener("visibilitychange", onVisibilityChange);
    return () => {
      window.clearTimeout(initialRefresh);
      window.clearInterval(timer);
      document.removeEventListener("visibilitychange", onVisibilityChange);
    };
  }, [refresh]);

  if (!snapshot || snapshot.status === "waiting") {
    return <WaitingState />;
  }

  const progress = Math.min(100, Math.max(0, snapshot.percentUsed));
  const observedAt = dateFormatter.format(new Date(snapshot.observedAt));

  return (
    <main className="shell">
      <header className="topbar">
        <div className="brand-mark" aria-hidden="true">
          <span />
        </div>
        <div>
          <p className="eyebrow">PUBLIC TOKEN STATUS</p>
          <h1>Quota tháng</h1>
        </div>
        <div className="live-indicator">
          <span />
          LIVE
        </div>
      </header>

      <section className="quota-card" aria-live="polite">
        <div className="status-row">
          <span className={`status-pill ${snapshot.status}`}>
            <i />
            {statusText(snapshot)}
          </span>
          <span className="refresh-note">
            {requestFailed ? "Đang thử kết nối lại…" : "Tự cập nhật mỗi 10 giây"}
          </span>
        </div>

        <div className="hero-metric">
          <span className="metric-label">CÒN LẠI</span>
          <strong>{formatTokens(snapshot.remaining)}</strong>
          <span className="metric-unit">token</span>
        </div>

        <div className="progress-block">
          <div className="progress-copy">
            <span>{snapshot.percentUsed.toLocaleString("vi-VN")}% đã dùng</span>
            <span>{formatTokens(snapshot.limit)} giới hạn</span>
          </div>
          <div
            className="progress-track"
            role="progressbar"
            aria-valuemin={0}
            aria-valuemax={100}
            aria-valuenow={progress}
            aria-label="Phần trăm quota đã dùng"
          >
            <span style={{ width: `${progress}%` }} />
          </div>
        </div>

        <div className="metric-grid">
          <article>
            <span>ĐÃ DÙNG</span>
            <strong>{formatTokens(snapshot.used)}</strong>
            <small>token trong tháng</small>
          </article>
          <article>
            <span>GIỚI HẠN</span>
            <strong>{formatTokens(snapshot.limit)}</strong>
            <small>token mỗi tháng</small>
          </article>
          <article>
            <span>CẬP NHẬT LÚC</span>
            <strong className="date-value">{observedAt}</strong>
            <small>từ máy chính</small>
          </article>
        </div>
      </section>

      <footer>
        <svg aria-hidden="true" viewBox="0 0 24 24">
          <path d="M12 3 5 6v5c0 4.6 2.8 8.4 7 10 4.2-1.6 7-5.4 7-10V6l-7-3Z" />
          <path d="m9.5 12 1.7 1.7 3.5-4" />
        </svg>
        Chỉ công khai số token tổng hợp. Không công khai thông tin đăng nhập.
      </footer>
    </main>
  );
}
