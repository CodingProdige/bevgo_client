export const runtime = "nodejs";

import { NextResponse } from "next/server";
import axios from "axios";
import { db } from "@/lib/firebaseConfig";
import {
  collection, getDocs, doc, setDoc, deleteDoc
} from "firebase/firestore";

const ok  =(p={},s=200)=>NextResponse.json({ ok:true, ...p },{ status:s });
const err =(s,t,m,e={})=>NextResponse.json({ ok:false,title:t,message:m,...e },{ status:s });

const PRODUCT_RELEASE = "https://bevgo-pricelist.vercel.app/api/catalogue/v1/products/sale/release";

export async function GET(){
  try{
    const cartsRef = collection(db,"carts_active");
    const snap = await getDocs(cartsRef);

    const nowTs = Date.now();
    const TWELVE_HOURS = 12 * 60 * 60 * 1000;

    let reclaimed = [];

    for (const docSnap of snap.docs){
      const cart = docSnap.data();
      const createdAt = new Date(cart.timestamps.createdAt).getTime();

      if ((nowTs - createdAt) < TWELVE_HOURS) continue;

      /* Cart is stale → reclaim */

      for (const it of cart.items || []){
        if ((it.sale_qty || 0) > 0){
          await axios.post(PRODUCT_RELEASE,{
            unique_id: it.product_unique_id,
            variant_id: it.selected_variant.variant_id,
            qty: it.sale_qty
          });
        }
      }

      /* Move to abandoned */
      await setDoc(doc(db,"carts_abandoned",docSnap.id),{
        ...cart,
        reclaimedAt: new Date().toISOString()
      });

      /* Delete active cart */
      await deleteDoc(doc(db,"carts_active",docSnap.id));

      reclaimed.push(docSnap.id);
    }

    return ok({
      message:"Reclaim process completed.",
      reclaimed
    });

  }catch(e){
    console.error(e);
    return err(500,"Reclaim Failed","Unexpected error",{ error:e.toString() });
  }
}
