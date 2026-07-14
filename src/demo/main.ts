void (async () => {
  const params = new URLSearchParams(location.search);

  if (params.get('demo') === 'scripted') {
    const { startScripted } = await import('./scripted');
    await startScripted();
  } else {
    const { startPage } = await import('./page');
    await startPage();
  }
})();
