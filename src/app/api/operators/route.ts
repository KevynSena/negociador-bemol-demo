import { NextRequest, NextResponse } from "next/server";
import { demoOperators, isDemoMode } from "@/lib/demo-data";
import { getOperators } from "@/lib/operators";

export async function GET(req: NextRequest) {
  try {
    const search = req.nextUrl.searchParams.get("q")?.trim().toLowerCase() ?? "";
    if (isDemoMode() || !process.env.SQLSERVER_HOST) {
      const filtered = search
        ? demoOperators.filter((item) =>
            item.nome.toLowerCase().includes(search) || item.login.toLowerCase().includes(search),
          )
        : demoOperators;

      return NextResponse.json({
        total: filtered.length,
        items: filtered,
        demo: true,
      });
    }

    const operators = await getOperators();
    const filtered = search
      ? operators.filter((item) =>
          item.nome.toLowerCase().includes(search) || item.login.toLowerCase().includes(search),
        )
      : operators;

    return NextResponse.json({
      total: filtered.length,
      items: filtered,
    });
  } catch (error) {
    return NextResponse.json(
      { error: error instanceof Error ? error.message : "Falha ao consultar operadores." },
      { status: 500 },
    );
  }
}
