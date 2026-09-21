/// <reference types="astro/client" />

interface ImportMetaEnv {
  readonly PUBLIC_NATIVE_API_URL?: string;
  readonly PUBLIC_VSTYLES_POP_URL?: string;
}

interface ImportMeta {
  readonly env: ImportMetaEnv;
}
