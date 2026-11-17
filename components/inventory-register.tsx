import { type InventoryItem } from "@/lib/types";
import { formatDate } from "@/components/ui";
import styles from "@/app/inventory/register.module.css";

const headings = ["ნივთის კოდი", "დასახელება", "ოთახი", "რაოდენობა", "მდგომარეობა", "სტატუსი", "ბოლო შემოწმების თარიღი", "აღწერა / შენიშვნა", "პასუხისმგებელი პირი", "რეგისტრაციის თარიღი", "მოქმედებები"];

export function InventoryRegister({ items, onOpen, onEdit, onArchive }: {
  items: InventoryItem[];
  onOpen: (item: InventoryItem) => void;
  onEdit: (item: InventoryItem) => void;
  onArchive: (item: InventoryItem) => void;
}) {
  const code = (item: InventoryItem) => <button type="button" className={styles.textAction} onClick={() => onOpen(item)}>{item.code}</button>;
  const actions = (item: InventoryItem) => item.archived_at ? <span className="text-slate-600">მხოლოდ ისტორია</span> : <div className={styles.itemActions}>
    <button type="button" className={styles.textAction} onClick={() => onEdit(item)}>რედაქტირება</button>
    <button type="button" className={styles.archiveAction} onClick={() => onArchive(item)}>არქივი</button>
  </div>;
  const metadata = (item: InventoryItem) => [item.condition, item.status, formatDate(item.last_inspected_at), item.notes || "—", item.responsible_person || "—", formatDate(item.registered_at)];
  return <>
    <div className={styles.desktopRegister}>
      <table className={styles.ledger}>
        <thead><tr>{headings.map((heading, index) => <th key={heading} scope="col" className={index === 3 ? styles.quantity : undefined}>{heading}</th>)}</tr></thead>
        <tbody>{items.map(item => <tr key={item.id}>
          <td>{code(item)}</td>
          <td className="font-semibold"><Clamped value={item.name} /></td>
          <td><Clamped value={item.room_name} /></td>
          <td className={styles.quantity}>{item.quantity}</td>
          {metadata(item).map((value, index) => <td key={headings[index + 4]}>{index === 3 || index === 4 ? <Clamped value={value} /> : value}</td>)}
          <td>{actions(item)}</td>
        </tr>)}</tbody>
      </table>
    </div>
    <ul className={styles.mobileRegister} aria-label="ინვენტარის ჩანაწერები">
      {items.map(item => <li key={item.id} className={styles.record}>
        <div className={styles.recordHeading}>
          <div className="min-w-0">
            {code(item)}
            <h2 className="mt-1 text-base font-bold"><Clamped value={item.name} /></h2>
            <p className="mt-1 text-sm text-slate-600"><Clamped value={item.room_name} /></p>
          </div>
          <div className={styles.recordQuantity}><span>{headings[3]}</span><strong>{item.quantity}</strong></div>
        </div>
        <details className={styles.recordDetails}>
          <summary>დეტალები</summary>
          <dl>{metadata(item).map((value, index) => <div key={headings[index + 4]}>
            <dt>{headings[index + 4]}</dt><dd>{value}</dd>
          </div>)}</dl>
        </details>
        {actions(item)}
      </li>)}
    </ul>
  </>;
}

function Clamped({ value }: { value: string }) {
  return <span className={styles.clamp} title={value}>{value}</span>;
}
