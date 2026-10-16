/**
 * Фильтр турниров для загрузки старых протоколов: нужна ТОЛЬКО Betera-Экстралига
 * (регулярный чемпионат, плей-офф, плей-ин, любые этапы), без Высшей лиги,
 * детских/юношеских/юниорских турниров, женского хоккея, МХЛ, кубков U-возрастов и т.п.
 *
 * Название турнира берётся из поля «Вид соревнования» протокола hockey.by, например:
 *   «Betera-Экстралига. 1 этап»                              → экстралига
 *   «Betera-Экстралига. Дивизион А»                          → экстралига
 *   «Betera-Экстралига. Плей-офф»                            → экстралига
 *   «Открытый Чемпионат … сезона 2023-2024. Betera-Экстралига» → экстралига
 *   «Betera-Высшая лига. 1 этап»                             → другое
 *   «Детская лига», «Юниорская лига», «U16. Кубок …», «МХЛ»   → другое
 *   «Betera-Экстралига. Товарищеские матчи»                  → товарищеский (по умолчанию пропускается)
 *
 * Модуль чистый (без БД и сети) — расчёты приложения он не затрагивает.
 */

export type CompetitionClass = "extraliga" | "friendly" | "other" | "unknown";

const norm = (s: string) =>
  s
    .toLowerCase()
    .replace(/ё/g, "е")
    .replace(/\s+/g, " ")
    .trim();

/** Экстралига: рус./англ. написания («Экстралига», «Extraliga», «Extraleague», «Экстра-лига»). */
const EXTRA = /экстра[\s-]*лиг|екстра[\s-]*лиг|extra[\s-]*lig|extra[\s-]*leag/;

/** Всё, что точно НЕ наша лига (даже если в названии упомянута экстралига). */
const OTHER =
  /высш|higher|highest|перв(ая|ое|ой|енство)\s|втор(ая|ое|ой)\s+лиг|детск|юнош|юниор|junior|youth|kids|женск|women|молод|школьн|спартакиад|(?<![а-яa-z0-9])(мхл|вхл|нхл|хл)(?![а-яa-z0-9])|olimpbet|любител|ветеран|студен|\bu[\s-]?\d{2}\b|\bw[\s/-]?u?\d{2}\b|до \d{2} лет|мальчик|девочк/;

const FRIENDLY = /товарищ|friendly|контрольн|спарринг/;

export function classifyCompetition(raw: string | null | undefined): CompetitionClass {
  const n = norm(raw ?? "");
  if (!n) return "unknown";
  if (OTHER.test(n)) return "other";
  if (!EXTRA.test(n)) return "other";
  if (FRIENDLY.test(n)) return "friendly";
  return "extraliga";
}

export function isExtraligaCompetition(raw: string | null | undefined, opts: { includeFriendly?: boolean } = {}): boolean {
  const c = classifyCompetition(raw);
  return c === "extraliga" || (c === "friendly" && !!opts.includeFriendly);
}
