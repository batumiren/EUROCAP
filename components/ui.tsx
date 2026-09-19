"use client";
import { FormEvent, ReactNode, useEffect } from "react";
import { Condition } from "@/lib/types";

export const formatDate = (value?: string | null) => value ? new Intl.DateTimeFormat("ka-GE", { dateStyle: "medium", timeStyle: "short", timeZone: "Asia/Tbilisi" }).format(new Date(value)) : "—";

export function Badge({ children, tone = "slate" }: { children: ReactNode; tone?: "slate" | "green" | "amber" | "red" | "blue" }) {
  const colors = { slate: "bg-slate-100 text-slate-700", green: "bg-emerald-100 text-emerald-800", amber: "bg-amber-100 text-amber-800", red: "bg-red-100 text-red-800", blue: "bg-blue-100 text-blue-800" };
  return <span className={`inline-flex rounded-full px-2.5 py-1 text-xs font-semibold ${colors[tone]}`}>{children}</span>;
}
export function ConditionBadge({ value }: { value: Condition }) {
  const tone = value === "კარგი" ? "green" : value === "დამაკმაყოფილებელი" ? "amber" : "red";
  return <Badge tone={tone}>{value}</Badge>;
}
export function Modal({ title, children, onClose, wide = false }: { title: string; children: ReactNode; onClose: () => void; wide?: boolean }) {
  useEffect(() => { const close = (e: KeyboardEvent) => e.key === "Escape" && onClose(); window.addEventListener("keydown", close); return () => window.removeEventListener("keydown", close); }, [onClose]);
  return <div className="fixed inset-0 z-50 flex items-start justify-center overflow-y-auto bg-slate-950/50 p-4 pt-[7vh]" onMouseDown={(e) => e.target === e.currentTarget && onClose()}>
    <section role="dialog" aria-modal="true" aria-label={title} className={`card w-full ${wide ? "max-w-5xl" : "max-w-xl"}`}>
      <header className="flex items-center justify-between border-b px-5 py-4"><h2 className="text-lg font-bold">{title}</h2><button className="rounded p-2 text-slate-500 hover:bg-slate-100" onClick={onClose} aria-label="დახურვა">✕</button></header>
      <div className="p-5">{children}</div>
    </section>
  </div>;
}
export function Notice({ message, error = false }: { message: string; error?: boolean }) { return <div className={`mb-5 rounded-lg border px-4 py-3 text-sm ${error ? "border-red-200 bg-red-50 text-red-800" : "border-emerald-200 bg-emerald-50 text-emerald-800"}`}>{message}</div>; }
export function Empty({ children }: { children: ReactNode }) { return <div className="card p-12 text-center text-sm text-slate-500">{children}</div>; }

export async function submitJson(url: string, method: string, body: unknown) {
  const response = await fetch(url, { method, headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) });
  const data = await response.json(); if (!response.ok) throw new Error(data.error || "მოთხოვნა ვერ შესრულდა."); return data;
}

export async function fetchJson<T = any>(url: string): Promise<T> {
  const response = await fetch(url, { cache: "no-store" });
  const data = await response.json();
  if (!response.ok) throw new Error(data.error || "მონაცემების მიღება ვერ მოხერხდა.");
  return data;
}

export function preventDoubleSubmit(handler: (form: FormData) => Promise<void>) {
  return async (event: FormEvent<HTMLFormElement>) => { event.preventDefault(); await handler(new FormData(event.currentTarget)); };
}
