import type { Metadata } from "next";
import { Inter } from "next/font/google";
import "./globals.css";
import "./resume/components/templates/resumeTemplate.css";
import { Providers } from "./providers";
import { WorkbenchShell } from "@/components/workbench/WorkbenchShell";

const inter = Inter({
  subsets: ["latin"],
  weight: ["400", "500", "600", "700"],
  variable: "--font-display",
  display: "swap",
});

export const metadata: Metadata = {
  title: "OfferU | 求职工作台",
  description: "面向校招求职者的 AI 工作台，支持岗位筛选、简历定制与投递跟进。",
};

export default function RootLayout({
  children,
}: Readonly<{
  children: React.ReactNode;
}>) {
  return (
    <html lang="zh-CN">
      <body className={`${inter.variable} h-screen overflow-hidden bg-[var(--background)] text-[var(--foreground)] antialiased`}>
        <Providers>
          <WorkbenchShell>{children}</WorkbenchShell>
        </Providers>
      </body>
    </html>
  );
}