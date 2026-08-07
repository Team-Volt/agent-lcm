export function harnessSet(harnesses) {
    return harnesses?.length ? new Set(harnesses) : undefined;
}
export function matchesHarness(event, selectedHarnesses) {
    return !selectedHarnesses || selectedHarnesses.has(event.harness);
}
export function harnessSqlFragment(column, harnesses, parameter) {
    const values = [...(harnessSet(harnesses) ?? [])];
    return values.length === 0
        ? { sql: "", values }
        : { sql: ` AND ${column} IN (${values.map((_, index) => `?${parameter + index}`).join(", ")})`, values };
}
