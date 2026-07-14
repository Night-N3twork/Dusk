import { describe, expect, test } from 'vitest';
import demoHtml from '../index.html?raw';
import indexSource from '../src/index.ts?raw';

describe('DuskJS entrypoint boundary', () => {
  test('the library entrypoint does not reference standalone demo modules', () => {
    expect(indexSource).not.toMatch(/['"`]\.\/demo\/[^'"`]*['"`]/);
  });

  test('the standalone page uses a dedicated demo entrypoint', () => {
    const document = new DOMParser().parseFromString(demoHtml, 'text/html');
    const moduleScripts = document.querySelectorAll('script[type="module"]');
    const moduleScriptSources = Array.from(
      moduleScripts,
      (script) => script.getAttribute('src'),
    );

    expect(moduleScriptSources).toEqual(['/src/demo/main.ts']);
  });
});
