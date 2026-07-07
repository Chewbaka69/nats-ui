/// <reference types="vite/client" />

declare const __APP_VERSION__: string;

interface ImportMetaEnv {
  readonly VITE_NATS_URL?: string;
  readonly VITE_NATS_HTTP_URL?: string;
}

interface ImportMeta {
  readonly env: ImportMetaEnv;
}
