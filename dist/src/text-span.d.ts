/** Convert a code-point span (as some providers report) to UTF-16 offsets; undefined when out of range. */
export declare function codePointSpanToUtf16(text: string, [cpStart, cpEnd]: readonly [number, number]): [number, number] | undefined;
