/** Calendar arithmetic is local-date arithmetic, never a subtraction of 24 hours. */
function localDateFormatter(timezone) {
    const format = new Intl.DateTimeFormat("en-US", { timeZone: timezone,
        year: "numeric", month: "2-digit", day: "2-digit" });
    return now => {
        const parts = format.formatToParts(now);
        const part = (type) => parts.find(p => p.type === type).value;
        return `${part("year")}-${part("month")}-${part("day")}`;
    };
}
export function shiftDate(day, days) {
    if (!/^\d{4}-\d{2}-\d{2}$/u.test(day) || new Date(`${day}T12:00:00Z`).toISOString().slice(0, 10) !== day)
        throw new Error("Invalid local date");
    return new Date(Date.parse(`${day}T12:00:00Z`) + days * 86400_000).toISOString().slice(0, 10);
}
function dayBoundary(day, localDate) {
    // First instant of the local date, including zones with midnight offset changes.
    const noon = Date.parse(`${day}T12:00:00Z`);
    let lo = noon - 48 * 3600_000, hi = noon + 48 * 3600_000;
    while (hi - lo > 1) {
        const mid = Math.floor((lo + hi) / 2);
        if (localDate(mid) < day)
            lo = mid;
        else
            hi = mid;
    }
    return hi;
}
export function reviewWindow(now, timezone, kind, day) {
    // One formatter serves the whole window: both boundary searches call it ~50 times each.
    const localDate = localDateFormatter(timezone);
    if (day && day >= localDate(now))
        throw new Error("Review day must be a completed local calendar day");
    const untilDay = day ? shiftDate(day, 1) : localDate(now);
    const sinceDay = shiftDate(untilDay, kind === "weekly" ? -7 : -1);
    return { localDay: shiftDate(untilDay, -1), timezone,
        since: dayBoundary(sinceDay, localDate), until: dayBoundary(untilDay, localDate) };
}
