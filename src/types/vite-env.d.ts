/// <reference types="vite/client" />

declare module '*?worldsrc' {
  const src: string;
  export default src;
}

declare module '@babel/standalone' {
  export function transform(source: string, options: unknown): { code?: string; ast?: unknown };
}
