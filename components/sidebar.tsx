"use client";
import Link from "next/link";
import { usePathname } from "next/navigation";

const links = [
  ["/inventory", "ინვენტარი", "▦"], ["/inspections", "შემოწმება", "✓"],
  ["/transfers", "გადაადგილება", "⇄"], ["/settings", "პარამეტრები", "⚙"],
];
export function Sidebar() {
  const path = usePathname();
  return <aside className="border-b bg-slate-950 text-white md:min-h-screen md:w-64 md:border-b-0 md:border-r">
    <div className="flex h-20 items-center px-6"><div><strong className="text-lg tracking-wide">EURO Inventory</strong><p className="text-xs text-slate-400">ინვენტარის მართვა</p></div></div>
    <nav className="flex gap-1 overflow-x-auto px-3 pb-3 md:block md:space-y-1 md:pb-0">
      {links.map(([href, label, icon]) => <Link key={href} href={href} className={`flex shrink-0 items-center gap-3 rounded-lg px-3 py-2.5 text-sm font-medium ${path.startsWith(href) ? "bg-blue-600 text-white" : "text-slate-300 hover:bg-slate-800"}`}><span className="w-5 text-center text-base">{icon}</span>{label}</Link>)}
    </nav>
  </aside>;
}
