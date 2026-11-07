// The market data is asked for now, while the page's script is still on its way (src/view.ts takes
// the answer). A file of its own, not inline, so the page's security policy allows no inline script.
try {
  var n = /^x1/.test(new URLSearchParams(location.search).get("network") || localStorage.getItem("percolator-vaults:network") || "") ? "x1-testnet" : "devnet";
  window.__state = { net: n, res: fetch("/api/state?network=" + n).then(function (r) { return r.ok ? r.json().then(function (j) { j.age = 1000 * (Number(r.headers.get("age")) || 0); return j; }) : null; }).catch(function () { return null; }) };
} catch (e) {}
