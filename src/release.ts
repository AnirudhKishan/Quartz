export const APP_VERSION = import.meta.env.VITE_APP_VERSION;
export const BUILD_SHA = import.meta.env.VITE_BUILD_SHA;
export const BUILD_ID = `${APP_VERSION}+${BUILD_SHA}`;
