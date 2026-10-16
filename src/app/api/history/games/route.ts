import { desc, eq, inArray, sql } from "drizzle-orm";
import { NextResponse } from "next/server";
import { db } from "@/db";
import { histGames } from "@/db/schema";
import { findNonExtraligaGames, writeHistoryFile } from "@/lib/historyDb";

export const dynamic = "force-dynamic";

/** Лёгкие колонки для списков (без тяжёлого JSON «details» — он грузится только в карточке матча). */
const listCols = {
  id: histGames.id,
  extId: histGames.extId,
  sourceUrl: histGames.sourceUrl,
  date: histGames.date,
  season: histGames.season,
  competition: histGames.competition,
  gameNo: histGames.gameNo,
  homeTeam: histGames.homeTeam,
  awayTeam: histGames.awayTeam,
  homeScore: histGames.homeScore,
  awayScore: histGames.awayScore,
  attendance: histGames.attendance,
  importedAt: histGames.importedAt,
};

/**
 * Сводка архива старых протоколов: по сезонам и последние загруженные.
 * ?season=2023-2024 — полный список матчей выбранного сезона (по дате, свежие сверху).
 */
export async function GET(req: Request) {
  const season = new URL(req.url).searchParams.get("season");
  if (season) {
    const games = await db
      .select(listCols)
      .from(histGames)
      .where(eq(histGames.season, season))
      .orderBy(desc(histGames.date), desc(histGames.id));
    return NextResponse.json({ season, games });
  }
  const [bySeason, latest, nonExtra] = await Promise.all([
    db
      .select({ season: histGames.season, n: sql<number>`count(*)::int`, minExt: sql<number>`min(${histGames.extId})::int`, maxExt: sql<number>`max(${histGames.extId})::int` })
      .from(histGames)
      .groupBy(histGames.season)
      .orderBy(histGames.season),
    db.select(listCols).from(histGames).orderBy(desc(histGames.importedAt), desc(histGames.id)).limit(100),
    findNonExtraligaGames(),
  ]);
  return NextResponse.json({ bySeason, latest, nonExtraliga: nonExtra.length });
}

/**
 * DELETE ?id=…           — удалить один матч из архива;
 * DELETE ?nonExtraliga=1 — удалить из архива матчи, которые точно не из Betera-Экстралиги
 *                          (высшая лига, детская, юниорская и т.п.), чтобы они не искажали статистику.
 */
export async function DELETE(req: Request) {
  const sp = new URL(req.url).searchParams;
  if (sp.get("nonExtraliga") === "1") {
    const list = await findNonExtraligaGames();
    if (list.length) await db.delete(histGames).where(inArray(histGames.id, list.map((g) => g.id)));
    await writeHistoryFile();
    return NextResponse.json({ ok: true, deleted: list.length });
  }
  const id = parseInt(sp.get("id") ?? "", 10);
  if (!id) return NextResponse.json({ error: "id" }, { status: 400 });
  await db.delete(histGames).where(eq(histGames.id, id));
  await writeHistoryFile();
  return NextResponse.json({ ok: true });
}
