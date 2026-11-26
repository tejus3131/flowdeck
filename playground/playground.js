// The switcher: every control writes a data-attribute on <html> and
// re-renders the stage. State persists in the URL hash so a combination
// can be shared: #board/p1/warm/indigo/light/on
(function () {
  const stage = document.getElementById('stage');
  const axes = ['page', 'philosophy', 'gray', 'accent', 'theme', 'motion'];
  const defaults = { page: 'board', philosophy: 'p1', gray: 'warm', accent: 'indigo', theme: 'light', motion: 'on' };
  const state = { ...defaults };

  function readHash() {
    const parts = location.hash.replace(/^#/, '').split('/').filter(Boolean);
    axes.forEach((a, i) => {
      if (parts[i]) state[a] = parts[i];
    });
  }

  function writeHash() {
    location.hash = axes.map((a) => state[a]).join('/');
  }

  function apply() {
    const root = document.documentElement;
    axes.forEach((a) => {
      if (a === 'page') return;
      root.dataset[a] = state[a];
    });
    stage.innerHTML = window.PG_PAGES[state.page](window.PG_DATA[state.page]);
    axes.forEach((a) => {
      document.getElementById(a).value = state[a];
    });
  }

  axes.forEach((a) => {
    document.getElementById(a).addEventListener('change', (e) => {
      state[a] = e.target.value;
      writeHash();
      apply();
    });
  });

  readHash();
  apply();
})();
