// Which build this is: the version from package.json and when it was built,
// stamped in by vite.config.ts. Outside a Vite build (tests) both are unknown.
export const APP_VERSION: string = typeof __APP_VERSION__ === "string" ? __APP_VERSION__ : "dev"
export const APP_BUILD: string = typeof __APP_BUILD__ === "string" ? __APP_BUILD__ : ""
