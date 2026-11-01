// Demo-mode entrypoint. Kept separate from src/index.ts so importing the
// library (src/index.ts) has zero side effects: no DOM access, no auto-start.
// index.html loads this file directly in app mode.

const ensureIsolation = async (): Promise<boolean> => {
	if (globalThis.crossOriginIsolated || !('serviceWorker' in navigator)) return true;
	const registration = await navigator.serviceWorker.register(`${import.meta.env.BASE_URL}coi-sw.js`);
	if (navigator.serviceWorker.controller) return true;
	await new Promise<void>((resolve) => {
		if (registration.active) resolve();
		else navigator.serviceWorker.addEventListener('controllerchange', () => resolve(), { once: true });
	});
	if (sessionStorage.getItem('dusk-coi-reload') === '1') return true;
	sessionStorage.setItem('dusk-coi-reload', '1');
	location.reload();
	return false;
};

if (typeof document !== 'undefined') {
	void (async () => {
		if (!await ensureIsolation()) return;
		sessionStorage.removeItem('dusk-coi-reload');
		const params = new URLSearchParams(location.search);
		if (params.get('demo') === 'scripted') {
			const { startScripted } = await import('./scripted');
			await startScripted();
		} else {
			const { startPage } = await import('./page');
			await startPage();
		}
	})();
}
