"use client";

import { FormEvent, useState } from "react";
import { Notice } from "@/components/ui";

type Preview = { total: number; updated: number; unchanged: number; revision: string };

export function InventoryImport() {
  const [file, setFile] = useState<File | null>(null);
  const [preview, setPreview] = useState<Preview | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [message, setMessage] = useState("");

  async function upload(apply: boolean) {
    if (!file) return;
    setBusy(true); setError(""); setMessage("");
    try {
      const body = new FormData();
      body.append("file", file);
      body.append("action", apply ? "apply" : "preview");
      if (preview) body.append("revision", preview.revision);
      const response = await fetch("/api/inventory/import", { method: "POST", body });
      const data = await response.json();
      if (!response.ok) throw new Error(data.error || "იმპორტი ვერ შესრულდა.");
      if (apply) {
        setPreview(null);
        setMessage(`იმპორტი დასრულდა: განახლდა ${data.updated}, უცვლელია ${data.unchanged}.`);
        if (data.warning) setError(data.warning);
      } else setPreview(data);
    } catch (error) { setPreview(null); setError(error instanceof Error ? error.message : "იმპორტი ვერ შესრულდა."); }
    finally { setBusy(false); }
  }

  function submit(event: FormEvent) { event.preventDefault(); void upload(false); }

  return <section className="card mt-6 p-5">
    <h2 className="mb-1 text-lg font-bold">ინვენტარის იმპორტი</h2>
    <p className="mb-3 text-sm text-slate-500">ატვირთეთ საიტიდან ექსპორტირებული და შესწორებული XLSX ან UTF-8 CSV ფაილი. არსებული ჩანაწერები განახლდება ნივთის კოდით. კოდები და სვეტების სათაურები არ შეცვალოთ.</p>
    <p className="mb-5 text-sm text-slate-500">ფოტოები და ისტორია შენარჩუნდება. გამოტოვებული ჩანაწერები არ წაიშლება. ოთახი უკვე უნდა არსებობდეს პარამეტრებში. შეცვლილი თარიღებისთვის გამოიყენეთ Excel-ის თარიღი ან YYYY-MM-DD ფორმატი. მაქსიმუმ 4 მბ / 10 000 ჩანაწერი.</p>
    {error && <Notice message={error} error />}{message && <Notice message={message} />}
    <form onSubmit={submit} className="flex flex-wrap items-end gap-3">
      <label className="min-w-0 flex-1"><span className="label">XLSX / CSV ფაილი</span><input className="w-full" type="file" accept=".xlsx,.csv" required disabled={busy} onChange={event => { setFile(event.target.files?.[0] || null); setPreview(null); setError(""); setMessage(""); }} /></label>
      <button className="btn-secondary" disabled={busy || !file}>{busy ? "მუშავდება..." : "ფაილის შემოწმება"}</button>
    </form>
    {preview && <div className="mt-4 rounded-lg border border-blue-200 bg-blue-50 p-4 text-sm text-blue-950">
      <p>სულ: {preview.total} · განახლდება: {preview.updated} · უცვლელია: {preview.unchanged}</p>
      <button type="button" className="btn-primary mt-3" disabled={busy || preview.updated === 0} onClick={() => { if (window.confirm(`${preview.updated} ჩანაწერი განახლდება. ადასტურებთ იმპორტს?`)) void upload(true); }}>იმპორტის დადასტურება</button>
    </div>}
  </section>;
}
