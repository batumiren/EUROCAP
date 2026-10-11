"use client";

import { FormEvent, useState } from "react";

export default function LoginPage() {
  const [error, setError] = useState("");
  const [saving, setSaving] = useState(false);
  async function login(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const form = new FormData(event.currentTarget);
    setError("");
    setSaving(true);
    try {
      const response = await fetch("/api/auth/login", {
        method: "POST", headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ username: form.get("username"), password: form.get("password") }),
      });
      const data = await response.json();
      if (!response.ok) throw new Error(data.error || "შესვლა ვერ მოხერხდა.");
      window.location.assign(data.redirectTo);
    } catch (error) {
      setError(error instanceof Error ? error.message : "შესვლა ვერ მოხერხდა.");
      setSaving(false);
    }
  }
  return <div className="flex min-h-[85vh] items-center justify-center">
    <section className="card w-full max-w-md overflow-hidden">
      <header className="bg-slate-950 px-7 py-8 text-white"><p className="text-xs font-semibold uppercase tracking-widest text-blue-300">EURO Inventory</p><h1 className="mt-3 text-2xl font-bold">სისტემაში შესვლა</h1><p className="mt-2 text-sm text-slate-300">ინვენტარის მართვა და შემოწმება</p></header>
      <form onSubmit={login} className="space-y-5 p-7">
        <label className="block"><span className="label">მომხმარებელი</span><input className="w-full" name="username" required autoComplete="username" autoCapitalize="none" spellCheck={false} autoFocus /></label>
        <label className="block"><span className="label">პაროლი</span><input className="w-full" name="password" type="password" required autoComplete="current-password" /></label>
        {error && <p className="rounded-lg bg-red-50 p-3 text-sm text-red-700" role="alert">{error}</p>}
        <button disabled={saving} className="btn-primary w-full">{saving ? "მიმდინარეობს..." : "შესვლა"}</button>
      </form>
    </section>
  </div>;
}
