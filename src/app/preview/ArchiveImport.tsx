"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import type { HistGame } from "@/db/schema";
import { fmtDateRu } from "@/lib/clean";
import { seasonLabel } from "@/lib/seasonStats";
import { HistMatchCard } from "@/components/HistMatchCard";

type GameRow = Omit<HistGame, "importedAt" | "details"> & { importedAt: string };
type Summary = {
  bySeason: { season: string; n: number; minExt: number; maxExt: number }[];
  latest: GameRow[];
  nonExtraliga?: number;
};

type LogLine = { id: number; ok: boolean; text: string; dup?: boolean; existingId?: number; filtered?: boolean };

/** Архив старых протоколов (hockey.by/new-admin/games/<id>/?print=protocol): одиночная и пакетная загрузка. */
export function ArchiveImport() {
  const [summary, setSummary] = useState<Summary | null>(null);
  const [url, setUrl] = useState("");
  const [from, setFrom] = useState("");
  const [to, setTo] = useState("");
  const [running, setRunning] = useState(false);
  const [progress, setProgress] = useState<{ done: number; total: number; ok: number; fail: number; dup?: number; skip?: number } | null>(null);
  const [log, setLog] = useState<LogLine[]>([]);
  const stopRef = useRef(false);
  const [openId, setOpenId] = useState<number | null>(null);
  const [showAll, setShowAll] = useState(false);
  const [notice, setNotice] = useState<{ text: string; existingId?: number } | null>(null);
  // фильтр «только Betera-Экстралига» (по умолчанию включён) и товарищеские матчи
  const [onlyExtra, setOnlyExtra] = useState(true);
  const [withFriendly, setWithFriendly] = useState(false);
  // выбранный сезон: полный список матчей сезона
  const [season, setSeason] = useState<string | null>(null);
  const [seasonGames, setSeasonGames] = useState<GameRow[] | null>(null);
  const [seasonErr, setSeasonErr] = useState<string | null>(null);
  const [q, setQ] = useState("");

  const load = useCallback(() => {
    fetch("/api/history/games")
      .then((r) => r.json())
      .then(setSummary)
      .catch(() => {});
  }, []);
  useEffect(() => {
    load();
  }, [load]);

  const loadSeason = useCallback((s: string) => {
    setSeasonErr(null);
    fetch(`/api/history/games?season=${encodeURIComponent(s)}`)
      .then(async (r) => {
        const d = await r.json();
        if (!r.ok) throw new Error(d.error || "Ошибка загрузки сезона");
        setSeasonGames(d.games ?? []);
      })
      .catch((e) => {
        setSeasonErr(e instanceof Error ? e.message : "Ошибка");
        setSeasonGames([]);
      });
  }, []);
  // после загрузки/удаления протоколов обновляем и открытый список сезона
  useEffect(() => {
    if (season) loadSeason(season);
  }, [season, summary, loadSeason]);

  function pickSeason(s: string) {
    setQ("");
    setShowAll(false);
    if (season === s) {
      setSeason(null);
      setSeasonGames(null);
      return;
    }
    setSeasonGames(null);
    setSeason(s);
  }

  async function importOne(body: { url?: string; id?: number; writeFile?: boolean; force?: boolean; onlyExtraliga?: boolean; includeFriendly?: boolean }): Promise<LogLine> {
    try {
      const res = await fetch("/api/history/import", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ onlyExtraliga: onlyExtra, includeFriendly: withFriendly, ...body }),
      });
      const d = await res.json();
      const id = body.id ?? d.game?.extId ?? d.id ?? 0;
      if (d.ok) {
        const g = d.game;
        return { id, ok: true, text: `${fmtDateRu(g.date)} · ${g.homeTeam} ${g.homeScore}:${g.awayScore} ${g.awayTeam} · ${g.competition ?? ""}` };
      }
      if (d.filtered) return { id, ok: false, filtered: true, text: d.error || "пропущен: не Betera-Экстралига" };
      if (d.duplicate) return { id, ok: false, dup: true, text: d.error || "уже есть в архиве", existingId: d.existing?.id };
      return { id, ok: false, text: d.error || "ошибка" };
    } catch {
      return { id: body.id ?? 0, ok: false, text: "сетевая ошибка" };
    }
  }

  async function single() {
    if (!url.trim()) return;
    setRunning(true);
    setNotice(null);
    let line = await importOne({ url });
    // фильтр турнира: протокол не из Экстралиги — сообщаем и спрашиваем, загружать ли всё равно
    if (line.filtered) {
      if (confirm(`${line.text}\n\nВ архив загружается только Betera-Экстралига. Всё равно загрузить этот протокол?`)) {
        line = await importOne({ url, onlyExtraliga: false });
      } else {
        setNotice({ text: line.text });
        setLog((l) => [line, ...l].slice(0, 300));
        setRunning(false);
        return;
      }
    }
    // защита от дубля: протокол уже в архиве — сообщаем и спрашиваем, перезагружать ли
    if (line.dup) {
      setNotice({ text: line.text, existingId: line.existingId });
      if (confirm(`${line.text}\n\nПовторно загружать не нужно. Перезаписать протокол заново?`)) {
        line = await importOne({ url, force: true });
        setNotice(null);
      }
    }
    setLog((l) => [line, ...l].slice(0, 300));
    setRunning(false);
    if (line.ok || line.dup) setUrl("");
    load();
  }

  async function range() {
    const a = parseInt(from, 10);
    const b = parseInt(to, 10);
    if (!a || !b) return;
    const lo = Math.min(a, b);
    const hi = Math.max(a, b);
    if (hi - lo > 5000) {
      alert("Не больше 5000 протоколов за один запуск");
      return;
    }
    stopRef.current = false;
    setRunning(true);
    const total = hi - lo + 1;
    let done = 0, ok = 0, fail = 0, dup = 0, skip = 0;
    setProgress({ done, total, ok, fail, dup, skip });
    let next = lo;
    const worker = async () => {
      while (!stopRef.current && next <= hi) {
        const id = next++;
        const line = await importOne({ id, writeFile: false });
        done++;
        if (line.ok) ok++;
        else if (line.dup) dup++;
        else if (line.filtered) skip++;
        else fail++;
        setProgress({ done, total, ok, fail, dup, skip });
        // отфильтрованные (не Экстралига) в журнал не пишем — только считаем
        if (!line.filtered) setLog((l) => [line, ...l].slice(0, 300));
      }
    };
    await Promise.all([worker(), worker(), worker()]);
    await fetch("/api/history/import", { method: "PUT" }).catch(() => {});
    setRunning(false);
    load();
  }

  async function remove(id: number) {
    if (!confirm("Удалить протокол из архива?")) return;
    await fetch(`/api/history/games?id=${id}`, { method: "DELETE" });
    load();
  }

  async function cleanNonExtra() {
    const n = summary?.nonExtraliga ?? 0;
    if (!n) return;
    if (!confirm(`В архиве ${n} матч. не из Betera-Экстралиги (высшая лига, детская, юниорская и т.п.).\n\nУдалить их из архива? Матчи Экстралиги и товарищеские не затрагиваются.`)) return;
    const r = await fetch("/api/history/games?nonExtraliga=1", { method: "DELETE" }).then((x) => x.json()).catch(() => null);
    if (r?.ok) setLog((l) => [{ id: 0, ok: true, text: `из архива убрано матчей не из Экстралиги: ${r.deleted}` }, ...l].slice(0, 300));
    load();
  }

  // строки таблицы: выбран сезон — все матчи сезона (с поиском), иначе — последние загруженные
  const shownRows: GameRow[] = (() => {
    const base = season ? seasonGames ?? [] : summary?.latest ?? [];
    const t = q.trim().toLowerCase();
    if (!season || !t) return base;
    return base.filter((g) => `${g.extId} ${g.homeTeam} ${g.awayTeam} ${g.competition ?? ""} ${g.homeScore}:${g.awayScore} ${fmtDateRu(g.date)}`.toLowerCase().includes(t));
  })();

  const totalGames = summary?.bySeason.reduce((a, s) => a + s.n, 0) ?? 0;

  return (
    <section className="space-y-3">
      <div className="card p-4">
        <h2 className="text-sm font-extrabold tracking-wide uppercase">Архив старых протоколов</h2>
        <p className="mt-1 text-xs text-ink-soft">
          Протоколы прошлых матчей (сезоны 2018/19 – 2026/27) вида https://hockey.by/new-admin/games/11575/?print=protocol.
          Из каждого протокола сохраняются составы, голы и передачи, штрафы, вратари (время, пропущенные, сейвы). Эти данные
          используются в анализе матчей и в карточках игроков/вратарей («Против команд»). Номер в ссылке — id протокола:
          можно загрузить целый диапазон id (протоколы без составов и несуществующие страницы пропускаются).
        </p>
        <div className="mt-3 grid gap-3 lg:grid-cols-2">
          <div>
            <span className="mb-1 block text-xs font-bold text-ink-soft">Один протокол</span>
            <div className="flex gap-2">
              <input className="inp" placeholder="https://hockey.by/new-admin/games/11575/?print=protocol" value={url} onChange={(e) => setUrl(e.target.value)} onKeyDown={(e) => e.key === "Enter" && single()} />
              <button className="btn-primary whitespace-nowrap" disabled={running || !url.trim()} onClick={single}>Загрузить</button>
            </div>
          </div>
          <div>
            <span className="mb-1 block text-xs font-bold text-ink-soft">Диапазон id протоколов</span>
            <div className="flex flex-wrap items-center gap-2">
              <input className="num w-28" placeholder="с 11575" value={from} onChange={(e) => setFrom(e.target.value.replace(/\D/g, ""))} />
              <span className="text-ink-soft">—</span>
              <input className="num w-28" placeholder="по 11700" value={to} onChange={(e) => setTo(e.target.value.replace(/\D/g, ""))} />
              {!running ? (
                <button className="btn" disabled={!from || !to} onClick={range}>Загрузить диапазон</button>
              ) : (
                <button className="btn" onClick={() => { stopRef.current = true; }}>Остановить</button>
              )}
            </div>
          </div>
        </div>
        <div className="mt-3 flex flex-wrap items-center gap-x-4 gap-y-1 rounded-md border border-line bg-white px-3 py-2 text-xs">
          <label className="flex items-center gap-1.5 font-semibold">
            <input type="checkbox" checked={onlyExtra} onChange={(e) => setOnlyExtra(e.target.checked)} />
            Только Betera-Экстралига (регулярка, плей-ин, плей-офф)
          </label>
          <label className={`flex items-center gap-1.5 ${onlyExtra ? "" : "opacity-40"}`}>
            <input type="checkbox" disabled={!onlyExtra} checked={withFriendly} onChange={(e) => setWithFriendly(e.target.checked)} />
            включая товарищеские матчи
          </label>
          <span className="text-ink-soft">
            Высшая лига, детская, юношеская, юниорская, женская, МХЛ, кубки U-возрастов и прочее при загрузке пропускаются.
          </span>
        </div>
        {notice && (
          <div className="mt-3 flex flex-wrap items-center justify-between gap-2 rounded-md border border-warn/40 bg-warn/5 px-3 py-2 text-sm">
            <span className="font-semibold text-warn">⚠ {notice.text}</span>
            <span className="flex gap-2">
              {notice.existingId && (
                <button className="btn px-2.5 py-1 text-xs" onClick={() => setOpenId(notice.existingId!)}>Открыть матч</button>
              )}
              <button className="btn px-2.5 py-1 text-xs" onClick={() => setNotice(null)}>✕</button>
            </span>
          </div>
        )}
        {progress && (
          <div className="mt-3">
            <div className="h-2 overflow-hidden rounded bg-line">
              <div className="h-full bg-ice transition-all" style={{ width: `${Math.round((progress.done / progress.total) * 100)}%` }} />
            </div>
            <p className="mt-1 text-xs text-ink-soft">
              {progress.done} из {progress.total} · загружено {progress.ok} · пропущено {progress.fail}
              {progress.skip ? ` · не Экстралига (отфильтровано) ${progress.skip}` : ""}
              {progress.dup ? ` · уже были в архиве ${progress.dup}` : ""}
              {running ? " · идёт загрузка…" : " · готово"}
            </p>
          </div>
        )}
        {log.length > 0 && (
          <div className="mt-2 max-h-48 overflow-y-auto rounded-md border border-line bg-white p-2 font-mono text-[11px]">
            {log.map((l, i) => (
              <div key={i} className={l.ok ? "text-ink" : l.dup ? "text-warn" : "text-ink-soft"}>
                {l.ok ? "✓" : l.dup ? "⚠" : "·"} #{l.id} {l.text}
                {l.dup && l.existingId && (
                  <button className="ml-1 text-ice hover:underline" onClick={() => setOpenId(l.existingId!)}>открыть</button>
                )}
              </div>
            ))}
          </div>
        )}
      </div>

      <div className="card overflow-x-auto">
        <div className="flex flex-wrap items-center justify-between gap-2 border-b border-line px-4 py-2">
          <h3 className="text-xs font-extrabold tracking-wide uppercase">В архиве: {totalGames} матчей</h3>
          {!!summary?.nonExtraliga && (
            <button className="btn-danger px-2.5 py-1 text-xs" disabled={running} onClick={cleanNonExtra} title="Удалить из архива матчи высшей лиги, детской и других турниров">
              Убрать не-Экстралигу ({summary.nonExtraliga})
            </button>
          )}
        </div>
        {summary && summary.bySeason.length > 0 ? (
          <div className="flex flex-wrap gap-2 px-4 py-3">
            {summary.bySeason.map((s) => {
              const active = season === s.season;
              return (
                <button
                  key={s.season}
                  type="button"
                  onClick={() => pickSeason(s.season)}
                  title={active ? "Свернуть список матчей сезона" : "Показать все матчи сезона"}
                  className={`rounded-md border px-3 py-1.5 text-xs transition ${active ? "border-ink bg-ink text-white" : "border-line bg-white hover:border-ice hover:bg-ice-soft/50"}`}
                >
                  <b>{seasonLabel(s.season)}</b> · {s.n} матч. <span className={active ? "text-white/70" : "text-ink-soft"}>(id {s.minExt}–{s.maxExt})</span>
                </button>
              );
            })}
          </div>
        ) : (
          <p className="px-4 py-4 text-sm text-ink-soft">Архив пуст — загрузите протоколы выше.</p>
        )}
        {season && (
          <div className="flex flex-wrap items-center gap-2 border-t border-line bg-ice-soft/30 px-4 py-2">
            <span className="text-xs font-extrabold uppercase">Сезон {seasonLabel(season)}</span>
            <span className="text-xs text-ink-soft">{seasonGames ? `матчей: ${shownRows.length}${shownRows.length !== seasonGames.length ? ` из ${seasonGames.length}` : ""}` : "загрузка…"}</span>
            <input className="inp ml-auto max-w-xs py-1 text-xs" placeholder="Поиск: команда, id, турнир" value={q} onChange={(e) => setQ(e.target.value)} />
            <button className="btn px-2.5 py-1 text-xs" onClick={() => pickSeason(season)}>✕ Свернуть</button>
          </div>
        )}
        {seasonErr && <p className="px-4 py-2 text-xs font-semibold text-bad">{seasonErr}</p>}
        {season && seasonGames && shownRows.length === 0 && <p className="px-4 py-3 text-sm text-ink-soft">Ничего не найдено.</p>}
        {summary && shownRows.length > 0 && (
          <table className="w-full border-collapse">
            <thead>
              <tr>
                {["id", "Дата", "Сезон", "Турнир", "Матч", ""].map((h) => <th key={h} className="th text-left">{h}</th>)}
              </tr>
            </thead>
            <tbody>
              {shownRows.slice(0, showAll ? shownRows.length : 30).map((g) => (
                <tr key={g.id} className="cursor-pointer transition hover:bg-ice-soft/40" onClick={() => setOpenId(g.id)} title="Открыть статистику матча">
                  <td className="td font-mono text-xs"><a className="text-ice hover:underline" href={g.sourceUrl} target="_blank" rel="noreferrer" onClick={(e) => e.stopPropagation()} title="Официальный протокол">{g.extId}</a></td>
                  <td className="td font-mono text-xs">{fmtDateRu(g.date)}</td>
                  <td className="td text-xs">{seasonLabel(g.season)}</td>
                  <td className="td text-xs text-ink-soft">{g.competition}</td>
                  <td className="td text-sm">
                    <b>{g.homeTeam}</b>{" "}
                    <button
                      className="rounded bg-ice-soft px-1.5 font-mono font-bold text-ice transition hover:bg-ice hover:text-white"
                      onClick={(e) => { e.stopPropagation(); setOpenId(g.id); }}
                      title="Статистика матча: голы, броски, удаления, вратари, составы"
                    >
                      {g.homeScore}:{g.awayScore}
                    </button>{" "}
                    <b>{g.awayTeam}</b>
                  </td>
                  <td className="td text-right"><button className="btn-danger px-2 py-0.5 text-xs" onClick={(e) => { e.stopPropagation(); remove(g.id); }}>удалить</button></td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
        {summary && shownRows.length > 30 && (
          <div className="border-t border-line px-4 py-2">
            <button className="btn px-3 py-1 text-xs" onClick={() => setShowAll((v) => !v)}>
              {showAll ? "Свернуть" : season ? `Показать все матчи сезона (${shownRows.length})` : `Показать все загруженные (${shownRows.length})`}
            </button>
          </div>
        )}
        {summary && summary.latest.length > 0 && (
          <p className="border-t border-line px-4 py-2 text-[11px] text-ink-soft">
            Кнопки сезонов — полный список матчей сезона. Клик по счёту (или строке) — статистика матча прямо здесь: голы, броски, удаления, вратари, составы. Номер id — ссылка на официальный протокол.
          </p>
        )}
      </div>
      {openId !== null && <HistMatchCard id={openId} onClose={() => setOpenId(null)} />}
    </section>
  );
}
