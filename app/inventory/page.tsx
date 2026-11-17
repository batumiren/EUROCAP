"use client";
import { FormEvent, useCallback, useEffect, useRef, useState } from "react";
import { CONDITIONS, InventoryItem, STATUSES } from "@/lib/types";
import { fetchJson, formatDate, Modal, Notice, submitJson } from "@/components/ui";
import { InventoryPhotos } from "@/components/inventory-photos";
import { InventoryRegister } from "@/components/inventory-register";
import "@fontsource-variable/noto-sans-georgian";
import styles from "./register.module.css";

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
  const load = useCallback(async () => {
    setLoading(true); const q = new URLSearchParams(); Object.entries(filters).forEach(([k, v]) => v && q.set(k, String(v)));
    const [inventory, roomData] = await Promise.all([fetchJson<any>(`/api/inventory?${q}`), fetchJson<any>("/api/rooms")]);
    setItems(inventory.items); setSummary(inventory.summary); setRooms(roomData.rooms); setNextCode(inventory.nextCode); setLoading(false);
  }, [filters]);
  useEffect(() => { setVisibleCount(10); load(); }, [load]);
  const notify = (text: string) => { setMessage(text); setError(""); window.setTimeout(() => setMessage(""), 4000); };
  const fail = (e: unknown) => setError(e instanceof Error ? e.message : "მოთხოვნა ვერ შესრულდა.");
  async function submitItem(event: FormEvent<HTMLFormElement>) {
    event.preventDefault(); setSaving(true); setError(""); const form = new FormData(event.currentTarget); const intent = ((event.nativeEvent as SubmitEvent).submitter as HTMLButtonElement | null)?.value;
    try {
      if (modal === "create") {
        const result = await submitJson("/api/inventory", "POST", { name: form.get("name"), roomId: Number(form.get("roomId")), quantity: Number(form.get("quantity")), condition: form.get("condition"), status: form.get("status"), notes: form.get("notes"), responsiblePerson: form.get("responsiblePerson") });
        await load();
        if (intent === "next") { setCreateMessage(`${result.created} ჩანაწერი (${result.codes.join(", ")}) შენახულია. შეგიძლიათ დაამატოთ შემდეგი მსგავსი ნივთი.`); return; }
      }
      else if (modal === "edit" && selected) await submitJson(`/api/inventory/${selected.id}`, "PATCH", { action: "edit", name: form.get("name"), condition: form.get("condition"), status: form.get("status"), notes: form.get("notes"), responsiblePerson: form.get("responsiblePerson") });
      setModal(null); await load(); notify("ინვენტარის ჩანაწერი შენახულია.");
    } catch (e) { fail(e); } finally { setSaving(false); }
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
  return <div className={`mx-auto max-w-[1600px] ${styles.workspace}`}>
    <header className={styles.masthead}>
      <div><p className={styles.eyebrow}>EURO INVENTORY</p><h1 className={styles.title}>ინვენტარი</h1><p className={styles.subtitle}>აქტივების სრული აღრიცხვა ოთახების მიხედვით</p></div>
      <div className={styles.actions}>
        <button type="button" className={styles.control} disabled={loading} onClick={load}>{loading ? "ახლდება..." : "განახლება"}</button>
        <span className={styles.total}>სულ {filteredUnitCount}</span>
        <button type="button" className={styles.primary} onClick={() => { setSelected(null); setCreateMessage(""); setModal("create"); }}>+ ნივთის დამატება</button>
      </div>
    </header>
    {message && <Notice message={message} />}{error && <Notice message={error} error />}
    <dl className={styles.stats}>
      {[["აქტიური ჩანაწერები", summary.records, "ჩანაწერი"], ["სულ ერთეული", summary.units, "ერთეული"], ["საჭიროებს შეკეთებას", summary.repairs || 0, "ჩანაწერი"]].map(([label, value, unit]) => <div key={label}><dt>{label}</dt><dd><strong>{value}</strong><span>{unit}</span></dd></div>)}
    </dl>
    <div className={styles.filters} role="group" aria-label="ინვენტარის ფილტრები">
      <label className={`${styles.field} ${styles.searchField}`}><span>ძებნა</span><input type="search" placeholder="კოდი ან დასახელება" value={filters.search} onChange={e => setFilters({ ...filters, search: e.target.value })} /></label>
      <label className={`${styles.field} ${styles.roomField}`}><span>ოთახი</span><select aria-label="ოთახი" value={filters.room} onChange={e => setFilters({ ...filters, room: e.target.value })}><option value="">ყველა ოთახი</option>{rooms.map(r => <option key={r.id} value={r.id}>{r.name}</option>)}</select></label>
      <label className={styles.field}><span>მდგომარეობა</span><select aria-label="მდგომარეობა" value={filters.condition} onChange={e => setFilters({ ...filters, condition: e.target.value })}><option value="">ყველა მდგომარეობა</option>{CONDITIONS.map(v => <option key={v}>{v}</option>)}</select></label>
      <label className={styles.field}><span>სტატუსი</span><select aria-label="სტატუსი" value={filters.status} onChange={e => setFilters({ ...filters, status: e.target.value })}><option value="">ყველა სტატუსი</option>{STATUSES.map(v => <option key={v}>{v}</option>)}</select></label>
      <div className={styles.toggles}><label><input type="checkbox" checked={filters.archived} onChange={e => setFilters({ ...filters, archived: e.target.checked })} /> არქივი</label><label><input type="checkbox" checked={grouped} onChange={e => setGrouped(e.target.checked)} /> დაჯგუფება</label></div>
    </div>
    <div className={styles.utilities}>
      <div>
        {filters.room ? <a className={styles.passportAction} href={`/api/rooms/passports?roomId=${encodeURIComponent(filters.room)}`} target="_blank" rel="noopener noreferrer">ოთახის პასპორტის ბეჭდვა</a> : <button type="button" className={styles.passportAction} disabled title="ჯერ აირჩიეთ ოთახი">ოთახის პასპორტის ბეჭდვა</button>}
        <a className={styles.passportAction} href="/api/rooms/passports" target="_blank" rel="noopener noreferrer">ყველა ოთახის პასპორტი</a>
      </div>
      <span className={styles.subtitle}>სრული აქტიური ინვენტარი · A4 / PDF</span>
    </div>
    <section className={styles.results} aria-label="ინვენტარის ჩანაწერები" aria-busy={loading}>
      {loading ? <p className={styles.feedback} role="status">იტვირთება...</p> : !items.length ? <p className={styles.feedback}>შერჩეული პირობებით ჩანაწერები არ მოიძებნა.</p> : grouped ? (
        <table className={`${styles.ledger} ${styles.grouped}`}>
          <thead><tr><th scope="col">დასახელება</th><th scope="col" className={styles.quantity}>რაოდენობა</th></tr></thead>
          <tbody>{Array.from(groups, ([key, group]) => <tr key={key}><td><span className={styles.clamp} title={group.name}>{group.name}</span></td><td className={styles.quantity}>{group.quantity}</td></tr>)}</tbody>
        </table>
      ) : <>
        <InventoryRegister items={visibleItems} onOpen={openDetail} onEdit={item => { setSelected(item); setModal("edit"); }} onArchive={archive} />
        {!filters.room && visibleCount < items.length && <div className={styles.pagination}><p className={styles.subtitle}>ნაჩვენებია {visibleItems.length} / {items.length} ჩანაწერი</p><button type="button" className={styles.control} onClick={() => setVisibleCount(count => count + 10)}>მეტი ↓</button></div>}
      </>}
    </section>
    {(modal === "create" || modal === "edit") && <Modal title={modal === "create" ? "ახალი ნივთის დამატება" : `რედაქტირება: ${selected?.code}`} onClose={() => setModal(null)}><ItemForm item={modal === "edit" ? selected : null} rooms={rooms} saving={saving} nextCode={nextCode} createMessage={createMessage} onSubmit={submitItem} /></Modal>}
    {modal === "detail" && <Modal title={`ნივთის დეტალები: ${selected?.code}`} onClose={() => {detailRequest.current++;setModal(null);}} wide>{!detail ? <p className="py-8 text-center text-slate-500">იტვირთება...</p> : <DetailView data={detail} onPhotoCountChange={(count)=>{setDetail(current=>current?{...current,item:{...current.item,photoCount:count}}:current);setItems(current=>current.map(item=>item.id===detail.item.id?{...item,photoCount:count}:item));}} />}</Modal>}
  </div>;
}

function ItemForm({ item, rooms, saving, nextCode, createMessage, onSubmit }: { item: InventoryItem | null; rooms: Room[]; saving: boolean; nextCode: string; createMessage: string; onSubmit: (e: FormEvent<HTMLFormElement>) => void }) {
  return <form onSubmit={onSubmit} className="grid gap-4 sm:grid-cols-2">{!item&&<><label className="sm:col-span-2"><span className="label">ნივთის კოდი</span><input className="w-full bg-slate-100 font-semibold text-slate-700" readOnly value={nextCode}/><span className="mt-1 block text-xs text-slate-500">კოდი ავტომატურად მიენიჭება შენახვისას და მისი შეცვლა შეუძლებელია.</span></label>{createMessage&&<div className="sm:col-span-2"><Notice message={createMessage}/></div>}</>}<label className="sm:col-span-2"><span className="label">დასახელება *</span><input className="w-full" name="name" required defaultValue={item?.name} /></label>{!item && <><label><span className="label">ოთახი *</span><select className="w-full" name="roomId" required defaultValue=""><option value="" disabled>აირჩიეთ ოთახი</option>{rooms.map(r => <option key={r.id} value={r.id}>{r.name}</option>)}</select></label><label><span className="label">რაოდენობა *</span><input className="w-full" name="quantity" type="number" min="1" required defaultValue="1" /><span className="mt-1 block text-xs text-slate-500">თითოეული ერთეული შეიქმნება ცალკე ჩანაწერად, საკუთარი კოდით.</span></label></>}<label><span className="label">მდგომარეობა *</span><select className="w-full" name="condition" required defaultValue={item?.condition || "კარგი"}>{CONDITIONS.map(v => <option key={v}>{v}</option>)}</select></label><label><span className="label">სტატუსი *</span><select className="w-full" name="status" required defaultValue={item?.status || "გამოყენებაში"}>{STATUSES.map(v => <option key={v}>{v}</option>)}</select></label><label className="sm:col-span-2"><span className="label">პასუხისმგებელი პირი</span><input className="w-full" name="responsiblePerson" defaultValue={item?.responsible_person} /></label><label className="sm:col-span-2"><span className="label">აღწერა / შენიშვნა</span><textarea className="w-full" name="notes" rows={3} defaultValue={item?.notes} /></label><div className="flex justify-end gap-2 sm:col-span-2"><button name="intent" value="save" className="btn-primary min-w-36" disabled={saving}>{saving ? "ინახება..." : "შენახვა"}</button>{!item&&<button name="intent" value="next" className="btn-secondary px-3" disabled={saving}>შემდეგი</button>}</div></form>;
}

function DetailView({ data, onPhotoCountChange }: { data: Detail; onPhotoCountChange: (count: number) => void }) {
  const [showAllHistory, setShowAllHistory] = useState(false);
  const visibleHistory = showAllHistory ? data.history : data.history.slice(0, 5);
  return <div className="space-y-6"><div className="grid gap-4 rounded-lg bg-slate-50 p-4 text-sm sm:grid-cols-2 lg:grid-cols-3"><p className="sm:col-span-2 lg:col-span-3"><span className="text-slate-500">დასახელება</span><br/><b className="whitespace-pre-wrap">{data.item.name}</b></p><p><span className="text-slate-500">ოთახი</span><br/><b>{data.item.room_name}</b></p><p><span className="text-slate-500">რაოდენობა</span><br/><b>{data.item.quantity}</b></p><p><span className="text-slate-500">მდგომარეობა</span><br/><b>{data.item.condition}</b></p><p><span className="text-slate-500">სტატუსი</span><br/><b>{data.item.status}</b></p><p><span className="text-slate-500">პასუხისმგებელი პირი</span><br/><b>{data.item.responsible_person || "—"}</b></p><p><span className="text-slate-500">რეგისტრაციის თარიღი</span><br/><b>{formatDate(data.item.registered_at)}</b></p><p className="sm:col-span-2 lg:col-span-3"><span className="text-slate-500">აღწერა / შენიშვნა</span><br/><b className="whitespace-pre-wrap">{data.item.notes || "—"}</b></p></div><InventoryPhotos inventoryId={data.item.id} itemCode={data.item.code} itemName={data.item.name} archived={Boolean(data.item.archived_at)} photoCount={data.item.photoCount||0} onPhotoCountChange={onPhotoCountChange}/><section><h3 className="mb-3 font-bold">ცვლილებების ისტორია</h3>{data.history.length ? <><div className="table-wrap"><table><thead><tr><th>თარიღი</th><th>მოქმედება</th><th>დეტალები</th><th>ოპერატორი</th></tr></thead><tbody>{visibleHistory.map(h => <tr key={h.id}><td>{formatDate(h.created_at)}</td><td>{h.action}</td><td>{h.details}</td><td>{h.operator_email}</td></tr>)}</tbody></table></div>{!showAllHistory && data.history.length > 5 && <div className="mt-3 text-center"><button className="btn-secondary min-w-40" onClick={() => setShowAllHistory(true)}>მეტი ↓</button><p className="mt-1 text-xs text-slate-500">ნაჩვენებია 5 / {data.history.length} ჩანაწერი</p></div>}</> : <p className="text-sm text-slate-500">ისტორია ცარიელია.</p>}</section><section><h3 className="mb-3 font-bold">შემოწმებები ({data.inspections.length})</h3>{data.inspections.map(i => <p key={i.id} className="mb-2 rounded-lg border p-3 text-sm"><b>{i.inspection_code}</b> · {formatDate(i.created_at)} · {i.checked ? `ნაპოვნია ${i.actual_quantity}` : "არ შემოწმებულა"}</p>)}</section><section><h3 className="mb-3 font-bold">გადაადგილებები ({data.transfers.length})</h3>{data.transfers.map(t => <p key={t.id} className="mb-2 rounded-lg border p-3 text-sm"><b>{formatDate(t.created_at)}</b> · {t.source_room_snapshot} → {t.destination_room_snapshot} · {t.quantity} ერთეული</p>)}</section></div>;
}
