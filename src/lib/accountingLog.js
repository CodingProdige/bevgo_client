import { db } from "@/lib/firebaseConfig";
import { collection, addDoc } from "firebase/firestore";

export async function logAccountingAction({ 
  action, 
  companyCode, 
  orderNumber = null, 
  amount = null, 
  performedBy = "system", 
  details = {} 
}) {
  const logsRef = collection(db, "accounting_logs");
  await addDoc(logsRef, {
    timestamp: new Date().toISOString(),
    action,
    companyCode,
    orderNumber,
    amount,
    performedBy,
    details
  });
}
