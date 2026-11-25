"use client";
import { FormEvent, useCallback, useEffect, useRef, useState } from "react";
import { CONDITIONS, InventoryItem, STATUSES } from "@/lib/types";
import { Badge, ConditionBadge, Empty, fetchJson, formatDate, Modal, Notice, submitJson } from "@/components/ui";
import { useDebouncedValue } from "@/lib/use-debounced-value";
import { InventoryPhotos } from "@/components/inventory-photos";

type Room = { id: number; name: string };
type Detail = { item: InventoryItem; inspections: any[]; transfers: any[]; history: any[] };

export default function InventoryPage() {
  const [items, setItems] = useState<InventoryItem[]>([]); const [rooms, setRooms] = useState<Room[]>([]);
  const [summary, setSummary] = useState({ records: 0, units: 0, repairs: 0 }); const [loading, setLoading] = useState(true);
  const [visibleCount, setVisibleCount] = useState(10);
  const [grouped, setGrouped] = useState(false);
  const [filters, setFilters] = useState({ search: "", room: "", condition: "", status: "", archived: false });
  const [modal, setModal] = useState<"create" | "edit" | "detail" | null>(null); const [selected, setSelected] = useState<InventoryItem | null>(null); const [detail, setDetail] = useState<Detail | null>(null);
  const [nextCode, setNextCode] = useState("EUR-000001"); const [createMessage, setCreateMessage] = useState("");
  const [message, setMessage] = useState(""); const [error, setError] = useState(""); const [saving, setSaving] = useState(false);
  const detailRequest = useRef(0);
  const listRequest = useRef(0);
  const submitLock = useRef(false);
  const pendingCreate = useRef<{ key: string; body: string } | null>(null);
  const [recovered, setRecovered] = useState<Record<string, string | number> | null>(null);
  useEffect(() => {
    try {
      const pending = JSON.parse(sessionStorage.getItem("eurocap.pendingInventoryCreate") ?? "null");
      if (!pending || typeof pending.key !== "string" || typeof pending.body !== "string") return;
      const fields = JSON.parse(pending.body);
      pendingCreate.current = pending;
      setRecovered(fields);
      setError("წინა შენახვის შედეგი ვერ დადასტურდა. უსაფრთხოდ გასამეორებლად დააჭირეთ „შენახვა“.");
      setModal("create");
    } catch { /* Browser storage is optional. */ }
  }, []);
  function rememberCreate(pending: typeof pendingCreate.current) {
    pendingCreate.current = pending;
    try {
      if (pending) sessionStorage.setItem("eurocap.pendingInventoryCreate", JSON.stringify(pending));
      else sessionStorage.removeItem("eurocap.pendingInventoryCreate");
    } catch { /* Retries still use the in-memory request key. */ }
  }
  const search = useDebouncedValue(filters.search);
  const { room, condition, status, archived } = filters;
  const loadRooms = useCallback(async () => {
    try { setRooms((await fetchJson<{ rooms: Room[] }>("/api/rooms")).rooms); }
    catch { setError("ოთახების ჩატვირთვა ვერ მოხერხდა. სცადეთ განახლება."); }
  }, []);
  useEffect(() => { void loadRooms(); }, [loadRooms]);
  const load = useCallback(async (signal?: AbortSignal) => {
    const request = ++listRequest.current;
    setLoading(true); const q = new URLSearchParams(); Object.entries({ search, room, condition, status, archived }).forEach(([k, v]) => v && q.set(k, String(v)));
    try {
      const inventory = await fetchJson<any>(`/api/inventory?${q}`, signal);
      if (request !== listRequest.current) return true;
      setItems(inventory.items); setSummary(inventory.summary); setNextCode(inventory.nextCode);
      return true;
    } catch {
      if (!signal?.aborted && request === listRequest.current) setError("ინვენტარის ჩატვირთვა ვერ მოხერხდა. სცადეთ განახლება.");
      return false;
    } finally { if (request === listRequest.current) setLoading(false); }
  }, [search, room, condition, status, archived]);
  useEffect(() => { const controller = new AbortController(); setVisibleCount(10); void load(controller.signal); return () => controller.abort(); }, [load]);
  const notify = (text: string) => { setMessage(text); setError(""); window.setTimeout(() => setMessage(""), 4000); };
  const fail = (e: unknown) => setError(e instanceof Error ? e.message : "მოთხოვნა ვერ შესრულდა.");
  async function submitItem(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (submitLock.current) return;
    submitLock.current = true;
    setSaving(true); setError(""); const form = new FormData(event.currentTarget); const intent = ((event.nativeEvent as SubmitEvent).submitter as HTMLButtonElement | null)?.value;
    try {
      if (modal === "create") {
        const body = JSON.stringify({ name: form.get("name"), roomId: Number(form.get("roomId")), quantity: Number(form.get("quantity")), condition: form.get("condition"), status: form.get("status"), notes: form.get("notes"), responsiblePerson: form.get("responsiblePerson") });
        const pending = pendingCreate.current ?? { body, key: crypto.randomUUID() };
        if (pending.body !== body && !window.confirm("წინა შენახვის შედეგი უცნობია. ჯერ უცვლელი მონაცემებით გავიმეოროთ წინა მოთხოვნა?")) return;
        rememberCreate(pending);
        const uncertain = "შენახვის შედეგი ვერ დადასტურდა. უსაფრთხოდ გასამეორებლად ისევ დააჭირეთ „შენახვა“.";
        let response: Response;
        try {
          response = await fetch("/api/inventory", { method: "POST", headers: { "Content-Type": "application/json", "Idempotency-Key": pending.key }, body: pending.body, signal: AbortSignal.timeout(30000) });
        } catch { throw new Error(uncertain); }
        const result = await response.json().catch(() => null);
        if (!response.ok || !result || !Array.isArray(result.codes)) {
          if (response.status === 400 && result?.error) rememberCreate(null);
          throw new Error(response.status === 400 && result?.error ? result.error : uncertain);
        }
        rememberCreate(null);
        if (intent === "next") {
          setCreateMessage(`${result.created} ჩანაწერი (${result.codes.join(", ")}) შენახულია. შეგიძლიათ დაამატოთ შემდეგი მსგავსი ნივთი.`);
          await load();
          return;
        }
      }
      else if (modal === "edit" && selected) await submitJson(`/api/inventory/${selected.id}`, "PATCH", { action: "edit", name: form.get("name"), condition: form.get("condition"), status: form.get("status"), notes: form.get("notes"), responsiblePerson: form.get("responsiblePerson") });
      setModal(null); notify("ინვენტარის ჩანაწერი შენახულია."); await load();
    } catch (e) { fail(e); } finally { submitLock.current = false; setSaving(false); }
  }
  async function openDetail(item: InventoryItem) { const requestId=++detailRequest.current; setSelected(item); setModal("detail"); setDetail(null); try { const result=await fetchJson<Detail>(`/api/inventory/${item.id}`); if(detailRequest.current===requestId)setDetail(result); } catch(e) { if(detailRequest.current===requestId){setModal(null);fail(e);} } }
  async function archive(item: InventoryItem) { if (!confirm(`ნამდვილად გსურთ ${item.code} ჩანაწერის არქივირება?`)) return; try { await submitJson(`/api/inventory/${item.id}`, "PATCH", { action: "archive" }); await load(); notify("ჩანაწერი დაარქივდა და ისტორია შენარჩუნებულია."); } catch (e) { fail(e); } }
  const visibleItems = filters.room ? items : items.slice(0, visibleCount);
  const filteredUnitCount = items.reduce((total, item) => total + item.quantity, 0);
  const groups = new Map<string, { name: string; quantity: number }>();
  if (grouped) {
    for (const item of items) {
      const name = item.name.trim().replace(/\s+/g, " ");
      const key = name.toLocaleLowerCase("ka-GE");
      const group = groups.get(key);
      if (group) group.quantity += item.quantity;
      else groups.set(key, { name, quantity: item.quantity });
    }
  }
  return <div className="mx-auto max-w-[1600px]">
    <div className="mb-7 flex flex-wrap items-end justify-between gap-4"><div><h1 className="text-2xl font-bold">ინვენტარი</h1><p className="mt-1 text-sm text-slate-500">აქტივების სრული აღრიცხვა ოთახების მიხედვით</p></div><div className="flex flex-wrap items-center gap-2"><button className="btn-secondary" disabled={loading} onClick={() => { void load(); void loadRooms(); }}>{loading ? "ახლდება..." : "განახლება"}</button><span className="rounded-lg border border-red-200 bg-red-50 px-4 py-2 text-sm font-bold text-red-700">სულ {filteredUnitCount}</span><button className="btn-primary" onClick={() => { setSelected(null); setRecovered(pendingCreate.current ? JSON.parse(pendingCreate.current.body) : null); setCreateMessage(""); setModal("create"); }}>+ ნივთის დამატება</button></div></div>
    {message && <Notice message={message} />}{error && <Notice message={error} error />}
    <div className="mb-6 grid gap-4 sm:grid-cols-3">
      {[['აქტიური ჩანაწერები', summary.records, 'ჩანაწერი'], ['სულ ერთეული', summary.units, 'ერთეული'], ['საჭიროებს შეკეთებას', summary.repairs || 0, 'ჩანაწერი']].map(([label, value, unit]) => <div className="card p-5" key={String(label)}><p className="text-sm font-medium text-slate-500">{label}</p><div className="mt-2 flex items-baseline gap-2"><strong className="text-3xl">{value}</strong><span className="text-xs text-slate-400">{unit}</span></div></div>)}
    </div>
    <div className="card mb-5 grid gap-3 p-4 sm:grid-cols-2 lg:grid-cols-[minmax(0,1fr)_minmax(0,1fr)_minmax(0,1fr)_minmax(0,1fr)_auto] [&>input]:min-w-0 [&>select]:min-w-0">
      <input aria-label="ძებნა" placeholder="კოდი ან დასახელება" value={filters.search} onChange={e => setFilters({ ...filters, search: e.target.value })} />
      <select aria-label="ოთახი" value={filters.room} onChange={e => setFilters({ ...filters, room: e.target.value })}><option value="">ყველა ოთახი</option>{rooms.map(r => <option key={r.id} value={r.id}>{r.name}</option>)}</select>
      <select aria-label="მდგომარეობა" value={filters.condition} onChange={e => setFilters({ ...filters, condition: e.target.value })}><option value="">ყველა მდგომარეობა</option>{CONDITIONS.map(v => <option key={v}>{v}</option>)}</select>
      <select aria-label="სტატუსი" value={filters.status} onChange={e => setFilters({ ...filters, status: e.target.value })}><option value="">ყველა სტატუსი</option>{STATUSES.map(v => <option key={v}>{v}</option>)}</select>
      <div className="flex gap-3 whitespace-nowrap"><label className="flex items-center gap-2 rounded-lg border px-3 py-2 text-sm"><input type="checkbox" checked={filters.archived} onChange={e => setFilters({ ...filters, archived: e.target.checked })} /> არქივი</label><label className="flex items-center gap-2 rounded-lg border px-3 py-2 text-sm"><input type="checkbox" checked={grouped} onChange={e => setGrouped(e.target.checked)} /> დაჯგუფება</label></div>
    </div>
    <div className="mb-5 flex flex-wrap items-center gap-2">
      {filters.room ? <a className="btn-secondary" href={`/api/rooms/passports?roomId=${encodeURIComponent(filters.room)}`} target="_blank" rel="noopener noreferrer">ოთახის პასპორტის ბეჭდვა</a> : <button className="btn-secondary" disabled title="ჯერ აირჩიეთ ოთახი">ოთახის პასპორტის ბეჭდვა</button>}
      <a className="btn-secondary" href="/api/rooms/passports" target="_blank" rel="noopener noreferrer">ყველა ოთახის პასპორტი</a>
      <span className="text-xs text-slate-500">სრული აქტიური ინვენტარი · A4 / PDF</span>
    </div>
    {loading ? <div className="card p-12 text-center text-slate-500">იტვირთება...</div> : items.length === 0 ? <Empty>შერჩეული პირობებით ჩანაწერები არ მოიძებნა.</Empty> : grouped ? <div className="table-wrap"><table><thead><tr><th>დასახელება</th><th>რაოდენობა</th></tr></thead><tbody>{Array.from(groups, ([key, group]) => <tr key={key} className="hover:bg-slate-50"><td className="max-w-64 whitespace-normal font-medium"><span className="inventory-clamp" title={group.name}>{group.name}</span></td><td>{group.quantity}</td></tr>)}</tbody></table></div> : <><div className="table-wrap"><table><thead><tr>{["ნივთის კოდი","დასახელება","ოთახი","რაოდენობა","მდგომარეობა","სტატუსი","ბოლო შემოწმების თარიღი","აღწერა / შენიშვნა","პასუხისმგებელი პირი","რეგისტრაციის თარიღი", "მოქმედებები"].map(h => <th key={h}>{h}</th>)}</tr></thead><tbody>{visibleItems.map(item => <tr key={item.id} className="hover:bg-slate-50"><td><button className="font-semibold text-blue-700 hover:underline" onClick={() => openDetail(item)}>{item.code}</button></td><td className="max-w-64 whitespace-normal font-medium"><span className="inventory-clamp" title={item.name}>{item.name}</span></td><td className="max-w-48 whitespace-normal"><span className="inventory-clamp" title={item.room_name}>{item.room_name}</span></td><td>{item.quantity}</td><td><ConditionBadge value={item.condition} /></td><td><Badge tone={item.status === "გამოყენებაში" ? "blue" : "slate"}>{item.status}</Badge></td><td>{formatDate(item.last_inspected_at)}</td><td className="max-w-xs whitespace-normal text-slate-600"><span className="inventory-clamp" title={item.notes || undefined}>{item.notes || "—"}</span></td><td className="max-w-48 whitespace-normal"><span className="inventory-clamp" title={item.responsible_person || undefined}>{item.responsible_person || "—"}</span></td><td>{formatDate(item.registered_at)}</td><td><div className="flex gap-2">{item.archived_at ? <Badge>მხოლოდ ისტორია</Badge> : <><button className="text-blue-700 hover:underline" onClick={() => { setSelected(item); setModal("edit"); }}>რედაქტირება</button><button className="text-red-700 hover:underline" onClick={() => archive(item)}>არქივი</button></>}</div></td></tr>)}</tbody></table></div>{!filters.room && visibleCount<items.length&&<div className="mt-4 flex flex-col items-center gap-2"><button className="btn-secondary min-w-40" onClick={()=>setVisibleCount(count=>count+10)}>მეტი ↓</button><p className="text-xs text-slate-500">ნაჩვენებია {Math.min(visibleCount,items.length)} / {items.length} ჩანაწერი</p></div>}</>}
    {(modal === "create" || modal === "edit") && <Modal title={modal === "create" ? "ახალი ნივთის დამატება" : `რედაქტირება: ${selected?.code}`} onClose={() => { if (!submitLock.current) setModal(null); }}>{error && <Notice message={error} error />}<ItemForm key={recovered && rooms.some(room => room.id === recovered.roomId) ? "recovered" : "item"} recovered={modal === "create" ? recovered : null} item={modal === "edit" ? selected : null} rooms={rooms} saving={saving} nextCode={nextCode} createMessage={createMessage} onSubmit={submitItem} /></Modal>}
    {modal === "detail" && <Modal title={`ნივთის დეტალები: ${selected?.code}`} onClose={() => {detailRequest.current++;setModal(null);}} wide>{!detail ? <p className="py-8 text-center text-slate-500">იტვირთება...</p> : <DetailView data={detail} onPhotoCountChange={(count)=>{setDetail(current=>current?{...current,item:{...current.item,photoCount:count}}:current);setItems(current=>current.map(item=>item.id===detail.item.id?{...item,photoCount:count}:item));}} />}</Modal>}
  </div>;
}

function ItemForm({ recovered, item, rooms, saving, nextCode, createMessage, onSubmit }: { recovered: Record<string, string | number> | null; item: InventoryItem | null; rooms: Room[]; saving: boolean; nextCode: string; createMessage: string; onSubmit: (e: FormEvent<HTMLFormElement>) => void }) {
  return <form onSubmit={onSubmit} className="grid gap-4 sm:grid-cols-2">{!item&&<><label className="sm:col-span-2"><span className="label">ნივთის კოდი</span><input className="w-full bg-slate-100 font-semibold text-slate-700" readOnly value={nextCode}/><span className="mt-1 block text-xs text-slate-500">კოდი ავტომატურად მიენიჭება შენახვისას და მისი შეცვლა შეუძლებელია.</span></label>{createMessage&&<div className="sm:col-span-2"><Notice message={createMessage}/></div>}</>}<label className="sm:col-span-2"><span className="label">დასახელება *</span><input className="w-full" name="name" required defaultValue={item?.name ?? recovered?.name} /></label>{!item && <><label><span className="label">ოთახი *</span><select className="w-full" name="roomId" required defaultValue={recovered?.roomId ?? ""}><option value="" disabled>აირჩიეთ ოთახი</option>{rooms.map(r => <option key={r.id} value={r.id}>{r.name}</option>)}</select></label><label><span className="label">რაოდენობა *</span><input className="w-full" name="quantity" type="number" min="1" required defaultValue={recovered?.quantity ?? 1} /><span className="mt-1 block text-xs text-slate-500">თითოეული ერთეული შეიქმნება ცალკე ჩანაწერად, საკუთარი კოდით.</span></label></>}<label><span className="label">მდგომარეობა *</span><select className="w-full" name="condition" required defaultValue={item?.condition ?? recovered?.condition ?? "კარგი"}>{CONDITIONS.map(v => <option key={v}>{v}</option>)}</select></label><label><span className="label">სტატუსი *</span><select className="w-full" name="status" required defaultValue={item?.status ?? recovered?.status ?? "გამოყენებაში"}>{STATUSES.map(v => <option key={v}>{v}</option>)}</select></label><label className="sm:col-span-2"><span className="label">პასუხისმგებელი პირი</span><input className="w-full" name="responsiblePerson" defaultValue={item?.responsible_person ?? recovered?.responsiblePerson} /></label><label className="sm:col-span-2"><span className="label">აღწერა / შენიშვნა</span><textarea className="w-full" name="notes" rows={3} defaultValue={item?.notes ?? recovered?.notes} /></label><div className="flex justify-end gap-2 sm:col-span-2"><button name="intent" value="save" className="btn-primary min-w-36" disabled={saving}>{saving ? "ინახება..." : "შენახვა"}</button>{!item&&<button name="intent" value="next" className="btn-secondary px-3" disabled={saving}>შემდეგი</button>}</div></form>;
}

function DetailView({ data, onPhotoCountChange }: { data: Detail; onPhotoCountChange: (count: number) => void }) {
  const [showAllHistory, setShowAllHistory] = useState(false);
  const visibleHistory = showAllHistory ? data.history : data.history.slice(0, 5);
  return <div className="space-y-6"><div className="grid gap-4 rounded-lg bg-slate-50 p-4 text-sm sm:grid-cols-2 lg:grid-cols-3"><p className="sm:col-span-2 lg:col-span-3"><span className="text-slate-500">დასახელება</span><br/><b className="whitespace-pre-wrap">{data.item.name}</b></p><p><span className="text-slate-500">ოთახი</span><br/><b>{data.item.room_name}</b></p><p><span className="text-slate-500">რაოდენობა</span><br/><b>{data.item.quantity}</b></p><p><span className="text-slate-500">მდგომარეობა</span><br/><b>{data.item.condition}</b></p><p><span className="text-slate-500">სტატუსი</span><br/><b>{data.item.status}</b></p><p><span className="text-slate-500">პასუხისმგებელი პირი</span><br/><b>{data.item.responsible_person || "—"}</b></p><p><span className="text-slate-500">რეგისტრაციის თარიღი</span><br/><b>{formatDate(data.item.registered_at)}</b></p><p className="sm:col-span-2 lg:col-span-3"><span className="text-slate-500">აღწერა / შენიშვნა</span><br/><b className="whitespace-pre-wrap">{data.item.notes || "—"}</b></p></div><InventoryPhotos inventoryId={data.item.id} itemCode={data.item.code} itemName={data.item.name} archived={Boolean(data.item.archived_at)} photoCount={data.item.photoCount||0} onPhotoCountChange={onPhotoCountChange}/><section><h3 className="mb-3 font-bold">ცვლილებების ისტორია</h3>{data.history.length ? <><div className="table-wrap"><table><thead><tr><th>თარიღი</th><th>მოქმედება</th><th>დეტალები</th><th>ოპერატორი</th></tr></thead><tbody>{visibleHistory.map(h => <tr key={h.id}><td>{formatDate(h.created_at)}</td><td>{h.action}</td><td>{h.details}</td><td>{h.operator_email}</td></tr>)}</tbody></table></div>{!showAllHistory && data.history.length > 5 && <div className="mt-3 text-center"><button className="btn-secondary min-w-40" onClick={() => setShowAllHistory(true)}>მეტი ↓</button><p className="mt-1 text-xs text-slate-500">ნაჩვენებია 5 / {data.history.length} ჩანაწერი</p></div>}</> : <p className="text-sm text-slate-500">ისტორია ცარიელია.</p>}</section><section><h3 className="mb-3 font-bold">შემოწმებები ({data.inspections.length})</h3>{data.inspections.map(i => <p key={i.id} className="mb-2 rounded-lg border p-3 text-sm"><b>{i.inspection_code}</b> · {formatDate(i.created_at)} · {i.checked ? `ნაპოვნია ${i.actual_quantity}` : "არ შემოწმებულა"}</p>)}</section><section><h3 className="mb-3 font-bold">გადაადგილებები ({data.transfers.length})</h3>{data.transfers.map(t => <p key={t.id} className="mb-2 rounded-lg border p-3 text-sm"><b>{formatDate(t.created_at)}</b> · {t.source_room_snapshot} → {t.destination_room_snapshot} · {t.quantity} ერთეული</p>)}</section></div>;
}
