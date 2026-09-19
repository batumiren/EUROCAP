import { db } from "../lib/db";
import { syncDataToGitHub } from "../lib/data-sync";

const pushed = syncDataToGitHub(db);
console.log(pushed ? "Inventory data snapshot committed and pushed." : "Inventory data snapshot is already current.");
