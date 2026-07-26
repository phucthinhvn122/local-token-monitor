import type { Metadata } from "next";
import { QuotaDashboard } from "./quota-dashboard";

export const metadata: Metadata = {
  title: "Public Token Quota",
  description:
    "Theo dõi số token đã dùng và còn lại qua một liên kết công khai, chỉ đọc.",
  other: {
    "codex-preview": "public-token-quota"
  }
};

export default function Home() {
  return <QuotaDashboard />;
}
