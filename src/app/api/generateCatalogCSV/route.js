// app/api/generateCatalogCSV/route.js
import { NextResponse } from "next/server";
import { ref, uploadBytes, getDownloadURL } from "firebase/storage";
import { storage } from "@/lib/firebaseConfig";
import { v4 as uuidv4 } from "uuid";
import { format } from "date-fns";

export async function POST() {
  try {
    // Step 1: Fetch all products
    const response = await fetch("https://bevgo-pricelist.vercel.app/api/getProducts");
    if (!response.ok) throw new Error("Failed to fetch products");
    const groupedProducts = await response.json();

    // Step 2: Flatten all products
    const allProducts = Object.values(groupedProducts).flat();

    // Step 3: Generate CSV headers & rows
    const headers = [
      "id", "title", "description", "availability",
      "condition", "price", "link", "image_link",
      "brand", "custom_label_0"
    ];

    const rows = allProducts.map((product) => {
      const {
        unique_code,
        product_title,
        price_incl,
        in_stock,
        product_image,
        product_brand,
        product_keyword
      } = product;

      const title = product_title.replace(/"/g, ""); // strip quotes
      const price = `${parseFloat(price_incl).toFixed(2)} ZAR`;
      const availability = in_stock ? "in stock" : "out of stock";
      const link = `https://wa.me/27616191616?text=I'm interested in: ${encodeURIComponent(title)} (Code: ${unique_code})`;

      return [
        unique_code,
        title,
        title, // Description same as title
        availability,
        "new",
        price,
        link,
        product_image,
        product_brand,
        product_keyword || "General",
      ];
    });

    // Combine headers and rows into CSV string
    const csvContent = [headers, ...rows]
      .map((row) => row.map((v) => `"${v}"`).join(","))
      .join("\n");

    // Step 4: Upload CSV to Firebase Storage
    const fileName = `catalogs/catalog-${format(new Date(), "yyyyMMdd-HHmmss")}.csv`;
    const fileRef = ref(storage, fileName);
    const csvBuffer = Buffer.from(csvContent, "utf-8");

    await uploadBytes(fileRef, csvBuffer, { contentType: "text/csv" });
    const downloadURL = await getDownloadURL(fileRef);

    return NextResponse.json({ downloadURL }, { status: 200 });

  } catch (error) {
    console.error("❌ Error generating catalog CSV:", error);
    return NextResponse.json(
      { error: error.message },
      { status: 500 }
    );
  }
}
