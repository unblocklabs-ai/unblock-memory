import type bundledDefaults from "../defaults.json";
type OperationalDefaults = {
    readonly [K in keyof typeof bundledDefaults]: Readonly<(typeof bundledDefaults)[K]>;
};
/** An explicit override path takes precedence over the process-wide environment setting. */
export declare function loadOperationalDefaults(overridePath?: string | undefined): OperationalDefaults;
export declare const DEFAULTS: OperationalDefaults;
export {};
