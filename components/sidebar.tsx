"use client";
import Link from "next/link";
import { usePathname } from "next/navigation";
import { useState } from "react";
import type { AuthUser } from "@/lib/auth";
import register from "@/app/inventory/register.module.css";

const links = [
  ["/inventory", "ინვენტარი", "▦"], ["/inspections", "შემოწმება", "✓"],
  ["/transfers", "გადაადგილება", "⇄"], ["/settings", "პარამეტრები", "⚙"],
];
export function Sidebar({ user }: { user: AuthUser }) {
  const path = usePathname();
  const [error, setError] = useState("");
  const [loggingOut, setLoggingOut] = useState(false);
  async function logout() {
    setLoggingOut(true);
    try {
      const response = await fetch("/api/auth/logout", { method: "POST" });
      if (!response.ok) throw new Error("გამოსვლა ვერ მოხერხდა.");
      window.location.assign("/login");
    } catch (error) { setError(error instanceof Error ? error.message : "გამოსვლა ვერ მოხერხდა."); setLoggingOut(false); }
  }
  if (path === "/inventory" && user.role === "admin") return (
    <aside className={register.navigation}>
      <div className={register.navIdentity}>
        <div><strong>EURO Inventory</strong><p>ინვენტარის მართვა</p></div>
        <div className={register.navAccount}>
          <span>{user.username}</span>
          <button type="button" disabled={loggingOut} onClick={logout}>{loggingOut ? "მიმდინარეობს..." : "გამოსვლა"}</button>
        </div>
      </div>
      <nav aria-label="მთავარი მენიუ">
        {links.map(([href, label]) => <Link key={href} href={href} aria-current={path === href ? "page" : undefined}>{label}</Link>)}
      </nav>
      {error && <p className="text-sm text-red-800" role="alert">{error}</p>}
    </aside>
  );
  return <aside className="border-b bg-slate-950 text-white md:min-h-screen md:w-64 md:border-b-0 md:border-r">
    <div className="flex h-20 items-center px-6"><div><strong className="text-lg tracking-wide">EURO Inventory</strong><p className="text-xs text-slate-400">ინვენტარის მართვა</p></div></div>
    <nav className="flex gap-1 overflow-x-auto px-3 pb-3 md:block md:space-y-1 md:pb-0">
      {links.filter(([href]) => user.role === "admin" || href === "/inspections").map(([href, label, icon]) => <Link key={href} href={href} className={`flex shrink-0 items-center gap-3 rounded-lg px-3 py-2.5 text-sm font-medium ${path.startsWith(href) ? "bg-blue-600 text-white" : "text-slate-300 hover:bg-slate-800"}`}><span className="w-5 text-center text-base">{icon}</span>{label}</Link>)}
    </nav>
    <div className="px-6 py-5"><p className="mb-2 text-sm text-slate-400">{user.username}</p><button type="button" disabled={loggingOut} onClick={logout} className="text-sm font-semibold text-white hover:underline">{loggingOut ? "მიმდინარეობს..." : "გამოსვლა"}</button>{error && <p className="mt-2 text-xs text-red-300" role="alert">{error}</p>}</div>
  </aside>;
}
