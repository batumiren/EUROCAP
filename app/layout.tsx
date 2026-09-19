import type { Metadata } from "next";
import "./globals.css";
import { Sidebar } from "@/components/sidebar";

export const metadata: Metadata = { title: "EURO Inventory", description: "ინვენტარის მართვის სისტემა" };

export default function RootLayout({ children }: Readonly<{ children: React.ReactNode }>) {
  return <html lang="ka"><body><div className="min-h-screen md:flex"><Sidebar /><main className="min-w-0 flex-1 px-4 py-6 sm:px-6 md:px-8 md:py-8">{children}</main></div></body></html>;
}
