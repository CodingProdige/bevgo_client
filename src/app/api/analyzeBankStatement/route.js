import { NextResponse } from "next/server";

export async function POST(req) {
  const data = await req.json();

  if (!Array.isArray(data) || data.length === 0) {
    return NextResponse.json({ error: "Invalid or empty array" }, { status: 400 });
  }

  const transactions = [];

  for (let i = 0; i < data.length - 2; i += 3) {
    const date = data[i]?.DateDescriptionAmountBalance?.trim();
    const description = data[i + 1]?.DateDescriptionAmountBalance?.trim();
    const amountBalanceLine = data[i + 2]?.DateDescriptionAmountBalance?.trim();

    if (!date || !description || !amountBalanceLine) continue;

    const parts = amountBalanceLine.includes("\t")
      ? amountBalanceLine.split("\t")
      : amountBalanceLine.split(/\s{2,}/);

    if (parts.length !== 2) continue;

    const [rawAmount, rawBalance] = parts;

    const amount = parseFloat(
      rawAmount
        .replace("−", "-")
        .replace("-", "-")
        .replace(/[^\d.-]/g, "")
    );

    const balance = parseFloat(
      rawBalance.replace(/[^\d.-]/g, "")
    );

    if (!isNaN(amount) && !isNaN(balance)) {
      const dateObj = new Date(date);
      const month = `${dateObj.getFullYear()}-${String(dateObj.getMonth() + 1).padStart(2, "0")}`;

      transactions.push({
        date: dateObj,
        month,
        description,
        amount,
        type: amount >= 0 ? "income" : "expense",
        balance
      });
    }
  }

  // Group by month
  const grouped = {};
  for (const tx of transactions) {
    if (!grouped[tx.month]) grouped[tx.month] = [];
    grouped[tx.month].push(tx);
  }

  const monthlyInsights = {};
  const allIncomes = [];
  const allExpenses = [];

  for (const [month, txs] of Object.entries(grouped)) {
    const income = txs.filter(t => t.type === "income");
    const expenses = txs.filter(t => t.type === "expense");

    const topIncome = income.reduce((map, t) => {
      const key = t.description.toLowerCase();
      map[key] = (map[key] || 0) + t.amount;
      return map;
    }, {});

    const topExpenses = expenses.reduce((map, t) => {
      const key = t.description.toLowerCase();
      map[key] = (map[key] || 0) + Math.abs(t.amount);
      return map;
    }, {});

    const employeePayments = Object.fromEntries(
      Object.entries(topExpenses).filter(([desc]) =>
        /wage|salary|amelia|joslyn|cheslin/i.test(desc)
      )
    );

    const incomeTotal = income.reduce((sum, t) => sum + t.amount, 0);
    const expenseTotal = expenses.reduce((sum, t) => sum + Math.abs(t.amount), 0);
    const net = incomeTotal - expenseTotal;

    allIncomes.push(incomeTotal);
    allExpenses.push(expenseTotal);

    monthlyInsights[month] = {
      totalIncome: incomeTotal.toFixed(2),
      totalExpenses: expenseTotal.toFixed(2),
      netCashFlow: net.toFixed(2),
      transactionCount: txs.length,
      incomeCount: income.length,
      expenseCount: expenses.length,
      topIncomeSources: Object.entries(topIncome)
        .sort((a, b) => b[1] - a[1])
        .slice(0, 3),
      topExpenses: Object.entries(topExpenses)
        .sort((a, b) => b[1] - a[1])
        .slice(0, 3),
      employeePayments
    };
  }

  // Projections
  const months = Object.keys(monthlyInsights).length;
  const avgMonthlyIncome = allIncomes.reduce((a, b) => a + b, 0) / months;
  const avgMonthlyExpenses = allExpenses.reduce((a, b) => a + b, 0) / months;
  const projectedNextMonthNet = avgMonthlyIncome - avgMonthlyExpenses;
  const lastBalance = transactions[transactions.length - 1]?.balance || 0;
  const burnRate = avgMonthlyExpenses - avgMonthlyIncome;
  const estimatedRunwayMonths = burnRate > 0 ? (lastBalance / burnRate).toFixed(1) : "∞";

  // Final response
  return NextResponse.json({
    summary: {
      monthsIncluded: Object.keys(grouped),
      overall: {
        totalIncome: allIncomes.reduce((a, b) => a + b, 0).toFixed(2),
        totalExpenses: allExpenses.reduce((a, b) => a + b, 0).toFixed(2),
        netCashFlow: (allIncomes.reduce((a, b) => a + b, 0) - allExpenses.reduce((a, b) => a + b, 0)).toFixed(2),
        transactionCount: transactions.length,

        averageMonthlyIncome: avgMonthlyIncome.toFixed(2),
        averageMonthlyExpenses: avgMonthlyExpenses.toFixed(2),
        projectedNextMonthIncome: avgMonthlyIncome.toFixed(2),
        projectedNextMonthExpenses: avgMonthlyExpenses.toFixed(2),
        projectedNextMonthNet: projectedNextMonthNet.toFixed(2),
        estimatedRunwayMonths
      }
    },
    monthlyInsights,
    transactions
  });
}
