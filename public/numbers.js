(function (global) {
  function trimTrailingZero(value) {
    return value.replace(/\.0$/, '');
  }

  function compactNumber(value, options) {
    const useMillion = options.useMillion !== false;
    const n = Number(value) || 0;
    if (useMillion && n >= 1_000_000) {
      const scaled = n / 1_000_000;
      const digits = scaled >= 100 ? 0 : 1;
      return `${trimTrailingZero(scaled.toFixed(digits))}M`;
    }
    if (n >= 1_000) {
      const scaled = n / 1_000;
      const digits = scaled >= 100 ? 0 : 1;
      return `${trimTrailingZero(scaled.toFixed(digits))}k`;
    }
    return String(Math.round(n));
  }

  function formatCount(value) {
    return compactNumber(value, { useMillion: false });
  }

  function formatTokens(value) {
    return compactNumber(value, { useMillion: true });
  }

  global.formatCount = formatCount;
  global.formatTokens = formatTokens;
})(typeof window !== 'undefined' ? window : globalThis);
