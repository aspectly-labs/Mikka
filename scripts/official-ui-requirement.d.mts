export declare const REQUIRE_OFFICIAL_UI: 'MIKKA_REQUIRE_OFFICIAL_UI'
export declare function officialUiRequired(env?: Record<string, string | undefined>): boolean
export declare function officialUiSkip(present: unknown, where: string, env?: Record<string, string | undefined>): false | string
