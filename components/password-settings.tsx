"use client";

import { FormEvent, useState } from "react";
import { Notice, submitJson } from "@/components/ui";

export function PasswordSettings() {
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState("");
  const [message, setMessage] = useState("");
  async function changePassword(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const form = event.currentTarget;
    const data = new FormData(form);
    setError(""); setMessage("");
    if (data.get("newPassword") !== data.get("confirmation")) { setError("პაროლები არ ემთხვევა."); return; }
    setSaving(true);
    try {
      const result = await submitJson("/api/auth/password", "POST", { username: data.get("username"), currentPassword: data.get("currentPassword"), newPassword: data.get("newPassword") });
      if (result.requiresLogin) { window.location.assign("/login"); return; }
      form.reset();
      setMessage("პაროლი შეიცვალა. ამ მომხმარებლის ძველი სესიები გაუქმებულია.");
    } catch (error) { setError(error instanceof Error ? error.message : "პაროლი ვერ შეიცვალა."); }
    finally { setSaving(false); }
  }
  return <section className="card mt-6 p-5">
    <h2 className="mb-1 text-lg font-bold">პაროლის შეცვლა</h2>
    <p className="mb-5 text-sm text-slate-500">შეცვალეთ საწყისი პაროლები. ახალი პაროლი უნდა შეიცავდეს მინიმუმ 10 სიმბოლოს: ლათინურ ასოს, ციფრს და სპეციალურ სიმბოლოს.</p>
    {error && <Notice message={error} error />}{message && <Notice message={message} />}
    <form onSubmit={changePassword} className="grid gap-4 sm:grid-cols-2">
      <label><span className="label">მომხმარებელი</span><select className="w-full" name="username"><option value="admin">admin</option><option value="check">check</option></select></label>
      <label><span className="label">admin-ის მიმდინარე პაროლი</span><input className="w-full" name="currentPassword" type="password" autoComplete="current-password" required /></label>
      <label><span className="label">ახალი პაროლი</span><input className="w-full" name="newPassword" type="password" autoComplete="new-password" minLength={10} maxLength={1024} required /></label>
      <label><span className="label">გაიმეორეთ ახალი პაროლი</span><input className="w-full" name="confirmation" type="password" autoComplete="new-password" minLength={10} maxLength={1024} required /></label>
      <div className="sm:col-span-2"><button className="btn-primary" disabled={saving}>{saving ? "ინახება..." : "პაროლის შეცვლა"}</button></div>
    </form>
  </section>;
}
