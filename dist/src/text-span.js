/** Convert a code-point span (as some providers report) to UTF-16 offsets; undefined when out of range. */
export function codePointSpanToUtf16(text, [cpStart, cpEnd]) {
    if (!Number.isSafeInteger(cpStart) || !Number.isSafeInteger(cpEnd) || cpStart < 0 || cpStart >= cpEnd)
        return undefined;
    let cp = 0;
    let start = -1;
    for (let i = 0; i < text.length;) {
        if (cp === cpStart)
            start = i;
        const code = text.codePointAt(i);
        i += code > 0xffff ? 2 : 1;
        cp++;
        if (cp === cpEnd)
            return start >= 0 ? [start, i] : undefined;
    }
    return undefined;
}
