# Side-Effect-Free DuskJS Entrypoint Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Prevent importing DuskJS as a browser library from automatically launching its standalone demo.

**Architecture:** Separate the reusable library entrypoint from the standalone application entrypoint. `src/index.ts` will expose DuskJS APIs without DOM side effects, while `src/demo/main.ts` will own query-string routing and demo startup for `index.html`.

**Tech Stack:** TypeScript, Vite, Vitest browser mode, Playwright, npm

---

## File Structure

- Create `test/entrypoint-boundary.test.ts`: asserts the library source has no demo bootstrap and the standalone HTML uses the dedicated demo entrypoint.
- Create `src/demo/main.ts`: starts either the scripted or interactive standalone demo.
- Modify `src/index.ts:189-200`: remove standalone demo startup from the library entrypoint.
- Modify `index.html:35`: load `src/demo/main.ts` for the standalone application.
- Mirror the same four changes under `/home/amplify/Projects/night-network-demo/vendor/duskjs` and regenerate its `lib/` package output.

### Task 1: Lock Down the Entrypoint Boundary

**Files:**
- Create: `test/entrypoint-boundary.test.ts`
- Test: `test/entrypoint-boundary.test.ts`

- [ ] **Step 1: Write the failing source-boundary tests**

```ts
import { describe, expect, test } from 'vitest';
import demoHtml from '../index.html?raw';
import indexSource from '../src/index.ts?raw';

describe('DuskJS entrypoint boundary', () => {
  test('the library entrypoint does not import standalone demos', () => {
    expect(indexSource).not.toContain("import('./demo/");
  });

  test('the standalone page uses a dedicated demo entrypoint', () => {
    expect(demoHtml).toContain('src="/src/demo/main.ts"');
  });
});
```

- [ ] **Step 2: Run the focused test and verify the current coupling is detected**

Run: `npm test -- test/entrypoint-boundary.test.ts`

Expected: FAIL. The first assertion finds `import('./demo/` in `src/index.ts`; the second finds `/src/index.ts` instead of `/src/demo/main.ts` in `index.html`.

- [ ] **Step 3: Do not commit the red test unless explicitly authorized**

If the user explicitly authorizes a commit, run:

```bash
git add test/entrypoint-boundary.test.ts
git commit -m "test: cover DuskJS entrypoint boundary"
```

Otherwise leave the test unstaged and continue.

### Task 2: Split Library and Standalone Demo Startup

**Files:**
- Create: `src/demo/main.ts`
- Modify: `src/index.ts:189-200`
- Modify: `index.html:35`
- Test: `test/entrypoint-boundary.test.ts`

- [ ] **Step 1: Add the standalone demo entrypoint**

Create `src/demo/main.ts` with:

```ts
const params = new URLSearchParams(location.search);

if (params.get('demo') === 'scripted') {
  const { startScripted } = await import('./scripted');
  await startScripted();
} else {
  const { startPage } = await import('./page');
  await startPage();
}
```

- [ ] **Step 2: Remove demo startup from the library entrypoint**

Delete this block from the end of `src/index.ts`:

```ts
if (typeof document !== 'undefined' && import.meta.env?.MODE !== 'test') {
  void (async () => {
    const params = new URLSearchParams(location.search);
    if (params.get('demo') === 'scripted') {
      const { startScripted } = await import('./demo/scripted');
      await startScripted();
    } else {
      const { startPage } = await import('./demo/page');
      await startPage();
    }
  })();
}
```

- [ ] **Step 3: Point the standalone page at its new entrypoint**

Change the final script in `index.html` to:

```html
<script type="module" src="/src/demo/main.ts"></script>
```

- [ ] **Step 4: Run the focused regression test**

Run: `npm test -- test/entrypoint-boundary.test.ts`

Expected: PASS with 2 passing tests.

- [ ] **Step 5: Run DuskJS static verification**

Run: `npm run typecheck`

Expected: exit code 0 with no TypeScript errors.

Run: `npm run build`

Expected: exit code 0 and a standalone Vite build in `dist/`.

- [ ] **Step 6: Run the complete DuskJS test suite**

Run: `npm test`

Expected: exit code 0 with all existing Chromium browser tests passing.

- [ ] **Step 7: Do not commit the implementation unless explicitly authorized**

If the user explicitly authorizes a commit, inspect `git diff` and run:

```bash
git add index.html src/index.ts src/demo/main.ts test/entrypoint-boundary.test.ts
git commit -m "fix: separate DuskJS library and demo entrypoints"
```

Do not stage or commit the pre-existing unrelated DuskJS working-tree changes.

### Task 3: Update the Vendored Library Build

**Files:**
- Create: `/home/amplify/Projects/night-network-demo/vendor/duskjs/src/demo/main.ts`
- Create: `/home/amplify/Projects/night-network-demo/vendor/duskjs/test/entrypoint-boundary.test.ts`
- Modify: `/home/amplify/Projects/night-network-demo/vendor/duskjs/src/index.ts:189-200`
- Modify: `/home/amplify/Projects/night-network-demo/vendor/duskjs/index.html:35`
- Regenerate: `/home/amplify/Projects/night-network-demo/vendor/duskjs/lib/`

- [ ] **Step 1: Apply the same regression test to the vendored package**

Create `test/entrypoint-boundary.test.ts` in the vendored DuskJS clone with:

```ts
import { describe, expect, test } from 'vitest';
import demoHtml from '../index.html?raw';
import indexSource from '../src/index.ts?raw';

describe('DuskJS entrypoint boundary', () => {
  test('the library entrypoint does not import standalone demos', () => {
    expect(indexSource).not.toContain("import('./demo/");
  });

  test('the standalone page uses a dedicated demo entrypoint', () => {
    expect(demoHtml).toContain('src="/src/demo/main.ts"');
  });
});
```

- [ ] **Step 2: Verify the vendored package still reproduces the failure**

From `/home/amplify/Projects/night-network-demo/vendor/duskjs`, run: `npm test -- test/entrypoint-boundary.test.ts`

Expected: FAIL for the same two entrypoint assertions.

- [ ] **Step 3: Apply the entrypoint split to the vendored package**

Create `src/demo/main.ts` with:

```ts
const params = new URLSearchParams(location.search);

if (params.get('demo') === 'scripted') {
  const { startScripted } = await import('./scripted');
  await startScripted();
} else {
  const { startPage } = await import('./page');
  await startPage();
}
```

Delete this block from the end of `src/index.ts`:

```ts
if (typeof document !== 'undefined' && import.meta.env?.MODE !== 'test') {
  void (async () => {
    const params = new URLSearchParams(location.search);
    if (params.get('demo') === 'scripted') {
      const { startScripted } = await import('./demo/scripted');
      await startScripted();
    } else {
      const { startPage } = await import('./demo/page');
      await startPage();
    }
  })();
}
```

Change the final script in `index.html` to:

```html
<script type="module" src="/src/demo/main.ts"></script>
```

- [ ] **Step 4: Verify the vendored source boundary**

Run: `npm test -- test/entrypoint-boundary.test.ts`

Expected: PASS with 2 passing tests.

- [ ] **Step 5: Rebuild the distributable library**

Run: `npm run build:lib`

Expected: exit code 0; `lib/duskjs.js`, type declarations, worker assets, and runtime chunks are regenerated.

- [ ] **Step 6: Confirm the library output contains no demo bootstrap**

Run: `rg "startPage|params\.get\(\"demo\"\)|chunks/page-" lib/duskjs.js lib/chunks`

Expected: exit code 1 with no matches. A `page-*.js` chunk must not be present under `lib/chunks/`.

- [ ] **Step 7: Do not commit vendored changes unless explicitly authorized**

If the user explicitly authorizes a separate vendored-package commit, inspect its `git diff` first and commit only the source, test, HTML, and generated library files belonging to this rebuild. Otherwise leave all changes unstaged.

### Task 4: Verify the NightNetwork Integration

**Files:**
- Verify: `/home/amplify/Projects/night-network-demo/dist/`
- Verify: `/home/amplify/Projects/night-network-demo/src/panes/dusk.ts`

- [ ] **Step 1: Build the integration demo against the linked vendored package**

From `/home/amplify/Projects/night-network-demo`, run: `npm run build`

Expected: exit code 0 and a production build in `dist/`.

- [ ] **Step 2: Confirm the integration bundle does not include the standalone demo**

Run: `rg "startPage|params\.get\(\"demo\"\)|chunks/page-" dist/assets`

Expected: exit code 1 with no matches, and no `page-*.js` asset is emitted.

- [ ] **Step 3: Start the integration preview server**

Run: `npm run preview -- --host 127.0.0.1`

Expected: Vite reports a local preview URL and serves responses with COOP/COEP headers. Keep it running for the next step.

- [ ] **Step 4: Run a browser smoke check from the vendored DuskJS directory**

From `/home/amplify/Projects/night-network-demo/vendor/duskjs`, run:

```bash
node --input-type=module -e "import { chromium } from 'playwright'; const browser = await chromium.launch({ headless: true }); const page = await browser.newPage(); const errors = []; page.on('pageerror', error => errors.push(error.message)); await page.goto('http://127.0.0.1:4173/', { waitUntil: 'networkidle' }); await page.waitForTimeout(3000); await browser.close(); const regression = errors.filter(message => message.includes('textContent') || message.includes('startPage')); if (regression.length) { console.error(regression.join('\n')); process.exit(1); } console.log('No standalone DuskJS demo errors:', errors);"
```

Expected: exit code 0 and output beginning `No standalone DuskJS demo errors:`. Unrelated network errors may be reported in the array but must not include the original null `textContent` failure or `startPage`.

- [ ] **Step 5: Inspect final repository state**

Run `git status --short` and `git diff --stat` separately in both `/home/amplify/Projects/NightShade/TBNode/DuskJS` and `/home/amplify/Projects/night-network-demo`.

Expected: only the planned files plus previously existing user changes are present. Do not stage, discard, overwrite, or commit unrelated changes.
