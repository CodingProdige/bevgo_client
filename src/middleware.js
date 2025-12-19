// import { NextResponse } from 'next/server';

// export function middleware(req) {
//   const response = NextResponse.next();

//   // Add CORS headers to the response
//   response.headers.set('Access-Control-Allow-Origin', '*'); // Change * to your specific domain if needed
//   response.headers.set('Access-Control-Allow-Methods', 'GET, POST, PUT, DELETE, OPTIONS');
//   response.headers.set('Access-Control-Allow-Headers', 'Content-Type, Authorization');
//   response.headers.set('Access-Control-Allow-Credentials', 'true');

//   // Handle preflight (OPTIONS) request
//   if (req.method === 'OPTIONS') {
//     return new Response(null, {
//       status: 204,
//       headers: response.headers,
//     });
//   }

//   return response;
// }


import { NextResponse } from "next/server";

export function middleware(req) {
  const res = NextResponse.next();

  // PUBLIC ROUTES (important!)
  const publicRoutes = [
    "/payments/add-card",
    "/payments/add-card/success"
  ];

  const { pathname } = req.nextUrl;

  // Allow Peach widget + add-card to load without interference
  if (publicRoutes.some(route => pathname.startsWith(route))) {
    return res;
  }

  // Apply CORS globally (safe)
  res.headers.set("Access-Control-Allow-Origin", "*");
  res.headers.set("Access-Control-Allow-Methods", "GET, POST, PUT, DELETE, OPTIONS");
  res.headers.set("Access-Control-Allow-Headers", "Content-Type, Authorization");
  res.headers.set("Access-Control-Allow-Credentials", "true");

  if (req.method === "OPTIONS") {
    return new Response(null, {
      status: 204,
      headers: res.headers,
    });
  }

  return res;
}
