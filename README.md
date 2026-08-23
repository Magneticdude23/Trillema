# Trilemma - Governor of the Central Bank

A small-open-economy policy simulator built around the **Impossible Trinity**: you can only ever have two of a stable currency, an open capital account, and an independent interest rate. Run monetary and fiscal policy through currency crises, debt spirals, and speculative attacks - and see exactly which of the three you're giving up.

**[▶ Play it here](https://<your-username>.github.io/<your-repo-name>/)**

Inspired by [FedSim](https://asurixyz.github.io/fedsim/) by [@asurixyz](https://github.com/asurixyz).

## What it is

You govern a central bank for a chosen tenure (1–30 years), holding levers over:

- Policy interest rate, QE / QT (balance sheet)
- Exchange-rate regime - float, managed, or peg - and FX intervention
- Capital-account openness (capital controls)
- Fiscal stance and tax rate
- Tariffs, and foreign-currency borrowing

against a live model tracking inflation, unemployment, GDP, the exchange rate, reserves, the balance of payments, and public debt-to-GDP - all driven by an underlying small-open-economy New Keynesian model (IS curve, Phillips curve, Okun's law, UIP capital flows, PPP exchange rates, and an explicit government budget constraint with r > g debt dynamics).

Six scenarios (a modern advanced economy, newly-independent India 1947, post-war reconstruction, 1970s stagflation, market liberalization, and a petrostate boom) or a fully custom setup.

At the end of your tenure, a before/after stats page shows what changed - and you can copy a shareable summary.

## The model

Every formula running under the hood - the IS/Phillips/Okun core, UIP, PPP, the fiscal multiplier, and the public-debt identity - is derived and documented on the **[model spec page](https://<your-username>.github.io/<your-repo-name>/model-reference.html)**, alongside the exact discretized equation the code runs each tick.

## Tech

Single-file vanilla JS + [Chart.js](https://www.chartjs.org/), no build step, no dependencies beyond two CDN scripts (Chart.js and MathJax for the model spec page). Everything runs client-side.

## Running locally

Just open `index.html` in a browser - or serve the folder locally (`python3 -m http.server`, then visit `localhost:8000`) if you want the two pages to link to each other exactly as they will on GitHub Pages.

## License

MIT - do whatever you'd like with it.
