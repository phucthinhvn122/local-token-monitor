import type { Metadata } from "next";
import { Geist, Geist_Mono } from "next/font/google";
import "./globals.css";

const geistSans = Geist({
  variable: "--font-geist-sans",
  subsets: ["latin"],
});

const geistMono = Geist_Mono({
  variable: "--font-geist-mono",
  subsets: ["latin"],
});

export const metadata: Metadata = {
  title: "Public Token Quota",
  description: "Trang công khai chỉ đọc cho số token đã dùng và còn lại.",
  openGraph: {
    title: "Public Token Quota",
    description: "Số token đã dùng và còn lại, tự cập nhật và chỉ đọc.",
    images: [{
      url: "/quota-social-card.png",
      width: 1536,
      height: 1024,
      alt: "Đồng hồ quota token trừu tượng màu xanh chanh trên nền tối"
    }]
  },
  twitter: {
    card: "summary_large_image",
    title: "Public Token Quota",
    description: "Số token đã dùng và còn lại, tự cập nhật và chỉ đọc.",
    images: ["/quota-social-card.png"]
  },
  icons: {
    icon: "/favicon.svg",
    shortcut: "/favicon.svg",
  },
};

export default function RootLayout({
  children,
}: Readonly<{
  children: React.ReactNode;
}>) {
  return (
    <html lang="vi">
      <body
        className={`${geistSans.variable} ${geistMono.variable} antialiased`}
      >
        {children}
      </body>
    </html>
  );
}
