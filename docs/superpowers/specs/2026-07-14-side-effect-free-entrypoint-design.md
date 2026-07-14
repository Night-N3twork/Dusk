# Side-Effect-Free DuskJS Entrypoint

## Problem

`src/index.ts` is both DuskJS's library entrypoint and the standalone demo bootstrap. In a browser, importing any library export executes the bootstrap, dynamically imports `src/demo/page.ts`, and expects the standalone demo DOM. Consumers such as `night-network-demo` do not provide elements like `#out`, so the demo writes `textContent` through a null reference.

## Design

Keep `src/index.ts` exclusively responsible for library exports and library behavior. Move the existing browser bootstrap block into a new `src/demo/main.ts` entrypoint. Update the standalone DuskJS `index.html` module script to load `src/demo/main.ts` instead of `src/index.ts`.

`src/demo/main.ts` will preserve the existing query-string behavior: `?demo=scripted` starts the scripted demo, while the default starts the interactive page. This changes no standalone demo behavior; it only prevents library consumers from starting that demo implicitly.

## Data Flow

For library consumers, importing `duskjs` evaluates exports without touching the DOM. The consumer explicitly calls `bootRepl` and supplies its own output callback and UI integration.

For the standalone DuskJS page, `index.html` loads `src/demo/main.ts`. That module selects and starts the requested demo, whose DOM lookups remain valid because the standalone page owns the expected markup.

## Testing

Add a regression test that imports the library entrypoint in a browser-like environment and verifies that neither standalone demo starter executes. Existing DuskJS tests, type checking, and production build must continue to pass.

After rebuilding the distributable DuskJS library, update the vendored copy used by `night-network-demo`. Build the integration demo and verify its output no longer contains the unconditional standalone-demo bootstrap or generated `page-*.js` chunk. Run the demo in a browser and confirm the integrated Dusk pane boots without the `textContent` exception.

## Scope

This change does not add DOM fallback checks, global configuration flags, or silent null handling. Those would preserve the incorrect coupling between library import and demo startup instead of removing its source.
