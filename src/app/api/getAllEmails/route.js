// /app/api/getAllEmails/route.js
import { db } from "@/lib/firebaseConfig";
import { collection, getDocs } from "firebase/firestore";

export async function GET() {
  try {
    const usersSnapshot = await getDocs(collection(db, "users"));
    const customersSnapshot = await getDocs(collection(db, "customers"));

    const userEmails = usersSnapshot.docs
      .map((doc) => doc.data())
      .filter((user) => !user.unsubscribed)
      .map((user) => user.email);

    const customerEmails = customersSnapshot.docs
      .map((doc) => doc.data().email)
      .filter(Boolean);

    const allEmails = [...new Set([...userEmails, ...customerEmails])];

    return new Response(JSON.stringify({ emails: allEmails }), {
      headers: { "Content-Type": "application/json" },
    });
  } catch (error) {
    return new Response(JSON.stringify({ error: error.message }), {
      status: 500,
      headers: { "Content-Type": "application/json" },
    });
  }
}