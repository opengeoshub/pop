/// <reference types="astro/client" />

declare module "*?worker&url" {
  const url: string;
  export default url;
}

interface ImportMetaEnv {
  readonly PUBLIC_NATIVE_API_URL?: string;
}

interface ImportMeta {
  readonly env: ImportMetaEnv;
}
