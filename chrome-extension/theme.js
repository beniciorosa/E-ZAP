// ===== E-ZAP Theme System =====
// Centralized theme detection and color management
// Extracted from abas.js for shared use across all modules
(function() {
  "use strict";

  /**
   * Detect if WhatsApp is in dark mode by reading body background brightness
   * @returns {boolean}
   */
  function isDarkMode() {
    var body = document.body;
    if (!body) return true;
    var bg = getComputedStyle(body).backgroundColor;
    if (!bg || bg === 'transparent') {
      var app = document.getElementById('app');
      if (app) bg = getComputedStyle(app).backgroundColor;
    }
    if (!bg || bg === 'transparent') return true;
    var match = bg.match(/\d+/g);
    if (!match) return true;
    var brightness = (parseInt(match[0]) + parseInt(match[1]) + parseInt(match[2])) / 3;
    return brightness < 128;
  }

  /**
   * Read computed color from a DOM element and convert to hex
   * @param {string|Element} selector - CSS selector or DOM element
   * @param {string} prop - CSS property name (default: backgroundColor)
   * @param {string} fallback - Fallback hex color
   * @returns {string} hex color
   */
  function _readColor(selector, prop, fallback) {
    try {
      var el = typeof selector === 'string' ? document.querySelector(selector) : selector;
      if (!el) return fallback;
      var val = getComputedStyle(el)[prop || 'backgroundColor'];
      if (!val || val === 'transparent' || val === 'rgba(0, 0, 0, 0)') return fallback;
      var match = val.match(/\d+/g);
      if (!match || match.length < 3) return fallback;
      var hex = '#' + match.slice(0, 3).map(function(c) {
        return ('0' + parseInt(c).toString(16)).slice(-2);
      }).join('');
      return hex;
    } catch (e) { return fallback; }
  }

  /**
   * Convert hex color to RGB array
   * @param {string} hex - e.g. "#ff6b6b"
   * @returns {number[]} [r, g, b]
   */
  function _hexToRgb(hex) {
    hex = hex.replace('#', '');
    return [parseInt(hex.substr(0, 2), 16), parseInt(hex.substr(2, 2), 16), parseInt(hex.substr(4, 2), 16)];
  }

  /**
   * Lighten/darken a hex color by a factor (-1 to 1)
   * Positive = lighten, negative = darken
   * @param {string} hex
   * @param {number} factor
   * @returns {string} adjusted hex color
   */
  function _adjustColor(hex, factor) {
    var rgb = _hexToRgb(hex);
    var adjusted = rgb.map(function(c) {
      if (factor > 0) return Math.min(255, Math.round(c + (255 - c) * factor));
      return Math.max(0, Math.round(c * (1 + factor)));
    });
    return '#' + adjusted.map(function(c) { return ('0' + c.toString(16)).slice(-2); }).join('');
  }

  /**
   * Get complete theme palette based on dark/light mode and custom config
   * Supports "responsive" mode (reads WA DOM colors) and "custom" mode (derives from primary color)
   * @returns {object} theme colors { bg, bgSecondary, bgHover, bgItem, border, borderLight, text, textSecondary, headerBg, iconColor, accent? }
   */
  function getTheme() {
    var dark = isDarkMode();
    var cfg = window.__ezapThemeConfig || { mode: "responsive" };

    // Custom mode: derive colors from primary color
    if (cfg.mode === "custom" && cfg.primaryColor) {
      var pc = cfg.primaryColor;
      var pcRgb = _hexToRgb(pc);
      var pcBrightness = (pcRgb[0] + pcRgb[1] + pcRgb[2]) / 3;
      return {
        bg: dark ? '#111b21' : '#ffffff',
        bgSecondary: dark ? '#202c33' : '#f0f2f5',
        bgHover: _adjustColor(pc, dark ? -0.7 : 0.85),
        bgItem: dark ? '#1a2730' : '#ffffff',
        border: _adjustColor(pc, dark ? -0.6 : 0.7),
        borderLight: _adjustColor(pc, dark ? -0.4 : 0.5),
        text: dark ? '#e9edef' : '#111b21',
        textSecondary: dark ? '#8696a0' : '#667781',
        headerBg: _adjustColor(pc, dark ? -0.75 : 0.9),
        iconColor: pc,
        accent: pc,
      };
    }

    // Responsive mode: read REAL colors from WA DOM
    var paneSide = document.getElementById('pane-side');
    var header = paneSide && paneSide.querySelector('header');
    var realBg = _readColor(paneSide, 'backgroundColor', dark ? '#111b21' : '#ffffff');
    var realHeaderBg = _readColor(header, 'backgroundColor', dark ? '#202c33' : '#f0f2f5');
    return {
      bg: realBg,
      bgSecondary: dark ? '#202c33' : '#f0f2f5',
      bgHover: dark ? '#2a3942' : '#e9edef',
      bgItem: dark ? '#1a2730' : '#ffffff',
      border: dark ? '#2a3942' : '#e9edef',
      borderLight: dark ? '#3b4a54' : '#d1d7db',
      text: dark ? '#e9edef' : '#111b21',
      textSecondary: dark ? '#8696a0' : '#667781',
      headerBg: realHeaderBg,
      iconColor: dark ? '#aebac1' : '#54656f',
    };
  }

  // Expose globally for all modules
  window.isDarkMode = isDarkMode;
  window._readColor = _readColor;
  window._hexToRgb = _hexToRgb;
  window._adjustColor = _adjustColor;
  window.getTheme = getTheme;

  // Refresh callback for auth.js theme config changes
  window.__ezapRefreshTheme = function() {
    console.log("[EZAP THEME] Config changed, re-applying CSS");
    if (typeof _ensureCustomListCSS === 'function') _ensureCustomListCSS(true);
  };

  console.log("[EZAP] Theme system loaded");
})();
