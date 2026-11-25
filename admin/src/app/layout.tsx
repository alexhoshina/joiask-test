import type { Metadata } from "next";
import "@fontsource-variable/geist";
import "@fontsource-variable/geist-mono";
import "./globals.css";
import { AuthProvider } from "@/lib/auth";


export const metadata: Metadata = {
  title: "JoiAsk 管理后台",
  description: "JoiAsk 提问箱管理后台",
  icons: {
    icon: "/favicon.png",
  },
};

export default function RootLayout({
  children,
}: Readonly<{
  children: React.ReactNode;
}>) {
  return (
    <html lang="zh-CN" className="h-full" style={{ scrollbarGutter: 'stable' }}>
      <body
        className="antialiased min-h-full"
      >
        <AuthProvider>{children}</AuthProvider>
      </body>
    </html>
  );
}
