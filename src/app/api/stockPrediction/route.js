// app/api/stock-predictor/route.js

import { NextResponse } from 'next/server';
import { db } from '@/lib/firebaseConfig';
import { collection, getDocs, query } from 'firebase/firestore';
import { format, parse, getDaysInMonth } from 'date-fns';
import { enUS } from 'date-fns/locale';

const moodMultipliers = {
  "very busy": 1.3,
  "busy": 1.15,
  "normal": 1.0,
  "quiet": 0.85,
  "very quiet": 0.7,
};

const getSeason = (month, countryCode) => {
  if (countryCode === 'ZA') {
    if ([5, 6, 7].includes(month)) return 'Winter';
    if ([8, 9, 10].includes(month)) return 'Spring';
    if ([11, 0, 1].includes(month)) return 'Summer';
    if ([2, 3, 4].includes(month)) return 'Autumn';
  }
  return 'Unknown';
};

export async function POST(req) {
  try {
    const body = await req.json();
    const {
      days = 30,
      mood = 'normal',
      countryCode = 'ZA',
      companyCode,
      compare
    } = body;

    // Normalize mood to lowercase for matching regardless of input casing
    const multiplier = moodMultipliers[mood.toLowerCase()] || 1.0;

    const invoicesRef = collection(db, 'invoices');
    const q = query(invoicesRef);
    const snapshot = await getDocs(q);

    const dataByMonth = {};

    snapshot.forEach((doc) => {
      const invoice = doc.data();
      if (!invoice.invoiceDate || !invoice.orderDetails?.cartDetails) return;

      if (companyCode && invoice.customer?.companyCode !== companyCode) return;

      const invoiceDate = new Date(invoice.invoiceDate);
      const monthKey = format(invoiceDate, 'MMMM yyyy', { locale: enUS });

      if (!dataByMonth[monthKey]) dataByMonth[monthKey] = {};

      invoice.orderDetails.cartDetails.forEach((item) => {
        const code = item.unique_code;
        if (!code) return;

        if (!dataByMonth[monthKey][code]) {
          dataByMonth[monthKey][code] = {
            productCode: code,
            productName: item.product_title,
            brand: item.product_brand,
            packSize: item.pack_size,
            imageUrl: item.product_image || '',
            qty: 0,
          };
        }

        const qty = Number(item.quantity) || Number(item.in_cart) || 0;
        dataByMonth[monthKey][code].qty += qty;
      });
    });

    const sortedMonths = Object.keys(dataByMonth).sort((a, b) => {
      const aDate = parse(`01 ${a}`, 'dd MMMM yyyy', new Date());
      const bDate = parse(`01 ${b}`, 'dd MMMM yyyy', new Date());
      return aDate - bDate;
    });

    let latestMonth = [...sortedMonths].reverse().find((monthKey) => {
      return Object.values(dataByMonth[monthKey]).some((prod) => prod.qty > 0);
    });

    const prevMonth = sortedMonths[sortedMonths.indexOf(latestMonth) - 1];
    const results = {};

    sortedMonths.forEach((monthKey) => {
      const isCurrent = monthKey === latestMonth;
      const parsedDate = parse(`01 ${monthKey}`, 'dd MMMM yyyy', new Date());
      const season = getSeason(parsedDate.getMonth(), countryCode);

      results[monthKey] = Object.values(dataByMonth[monthKey]).map((prod) => {
        const prevQty = dataByMonth[prevMonth]?.[prod.productCode]?.qty || 0;
        const momChange = prevQty
          ? +(((prod.qty - prevQty) / prevQty) * 100).toFixed(2)
          : 0;

        return {
          ...prod,
          qty: prod.qty,
          previousMonthQty: prevQty,
          MoMChangePercent: momChange,
          season,
          isCurrentMonth: isCurrent,
        };
      });
    });

    const forecast = [];

    if (latestMonth) {
      Object.values(dataByMonth[latestMonth]).forEach((prod) => {
        const monthDate = parse(`01 ${latestMonth}`, 'dd MMMM yyyy', new Date());
        const daysInMonth = getDaysInMonth(monthDate);
        const avgCasesPerDay = prod.qty / daysInMonth;
        const rawForecastCases = avgCasesPerDay * days * multiplier;
        const forecastQty = rawForecastCases > 0.1 ? Math.ceil(rawForecastCases) : 0;

        forecast.push({
          productCode: prod.productCode,
          productName: prod.productName,
          brand: prod.brand,
          packSize: prod.packSize,
          imageUrl: prod.imageUrl,
          forecastQty,
          rawForecastQty: +rawForecastCases.toFixed(2),
          avgCasesPerDay: +avgCasesPerDay.toFixed(2),
          mood,
          season: getSeason(new Date().getMonth(), countryCode),
          isCurrentMonth: true
        });
      });
    }

    const compareResults = {};
    if (compare?.from && compare?.to) {
      const from = compare.from;
      const to = compare.to;
      compareResults[from] = dataByMonth[from] || {};
      compareResults[to] = dataByMonth[to] || {};
    }

    return NextResponse.json({
      forecastPeriod: `${days} days`,
      forecastMood: mood,
      compareMonths: compare || null,
      results: {
        ...results,
        ...(compare ? { compare: compareResults } : {}),
        forecast
      }
    });
  } catch (err) {
    console.error(err);
    return NextResponse.json(
      { success: false, error: err.message || 'Internal Error' },
      { status: 500 }
    );
  }
}
