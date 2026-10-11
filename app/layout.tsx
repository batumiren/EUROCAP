import type { Metadata } from "next";
import "./globals.css";
import { Sidebar } from "@/components/sidebar";
import { getCurrentUser } from "@/lib/auth";

export const metadata: Metadata = { title: "EURO Inventory", description: "ინვენტარის მართვის სისტემა" };

export default async function RootLayout({ children }: Readonly<{ children: React.ReactNode }>) {
  const user = await getCurrentUser();
  return <html lang="ka"><body><div className="min-h-screen md:flex">{user && <Sidebar user={user} />}<main className="min-w-0 flex-1 px-4 py-6 sm:px-6 md:px-8 md:py-8">{children}</main></div></body></html>;
}
