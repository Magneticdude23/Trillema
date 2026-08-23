/* ============================================================
   TRILEMMA — a small-open-economy macro game.
   Core idea: the Impossible Trinity is enforced by consequences,
   not by locking buttons. Peg + open capital account ⇒ your rate
   is pinned by Uncovered Interest Parity; deviating drains reserves.
   ============================================================ */

const P = {
  dtDays: 3, tickMs: 90, termDays: 3650, recEvery: 10,
  inflTarget: 3, uStar: 5, rStar: 2, fxBase: 100, foreignInfl: 2, iStarBase: 4,
  alpha: 0.28,      // IS sensitivity to real rate
  gammaFx: 2.2,     // IS sensitivity to real competitiveness
  mpc: 0.6,         // marginal propensity to consume — feeds the fiscal multiplier
  lamGap: 0.06, lamInfl: 0.045, lamUnemp: 0.05,
  phi: 0.30,        // Phillips slope
  psiPass: 9,       // exchange-rate pass-through (× capped per-tick depr)
  beta: 0.5,        // Okun
  kappa: 0.5,       // capital-flow sensitivity to carry
  chi: 3.0,         // trade sensitivity to competitiveness
  fxRevert: 0.05,   // pull of fx toward PPP fair value
  fxFlow: 0.5,      // fx response to balance-of-payments flow
  resScale: 0.5,    // reserve absorption under a peg
  sig: { gap:0.18, infl:0.14, fx:0.5 },
  debtThresh: 60,   // debt/GDP (%) above which borrowing costs & politics start to bite
  debtIntCoef: 0.018,// extra points of interest spread per point of debt/GDP above threshold
  debtRateRev: 0.05,// how fast the effective debt interest rate reverts to its target
  MAXLEN: 400
};
// P.inflTarget, P.uStar, P.rStar, P.foreignInfl, P.iStarBase are the "structural anchors" — the only
// pieces of the physics that change with the chosen starting scenario. Everything else (alpha, phi,
// chi, ...) is fixed: the same model runs underneath every scenario, only its calibration point differs.
const clamp=(x,a,b)=>Math.max(a,Math.min(b,x));

const CFG_DEFAULT = {
  gdppc:12000, population:50, tenureYears:10, infl:4, unemp:6, i:6, iStar:4, reserves:200, openness:70,
  regime:'peg', fxDebt:0, approval:55, tariff:0, fiscal:0, inflTarget:3, uStar:5, rStar:2, foreignInfl:2,
  govDebtRatio:60, pegCurrency:'USD', taxRate:0.25
};

// Illustrative anchor economies for the "peg against" picker — not live data (that's phase 2).
// Picking one just fills in a plausible world rate & foreign inflation starting point.
const PEG_CURRENCIES = {
  USD:{ label:'US Dollar',      iStar:4.0, foreignInfl:2.0 },
  EUR:{ label:'Euro',           iStar:3.0, foreignInfl:2.0 },
  JPY:{ label:'Japanese Yen',   iStar:0.5, foreignInfl:1.0 },
  GBP:{ label:'British Pound',  iStar:4.5, foreignInfl:2.5 },
  CNY:{ label:'Chinese Yuan',   iStar:2.5, foreignInfl:2.0 }
};

let S, frameCount=0, dayAcc=0, speed=1;
const FRAME_MS=50, BASE_DPF=2;   // reference cadence: 2 sim-days per 50ms at 1× ⇒ a 10y term ≈ 91s (rAF-timed, not fixed-interval)

// event timing as fractions of the chosen tenure, so a 3-year and a 30-year run both get a
// proportionally-paced crisis calendar instead of a fixed day count tuned only for 10 years
const SCRIPT_FRACS = [
  {frac:0.0548, type:'foreignHike'},
  {frac:0.1507, type:'termsOfTrade'},
  {frac:0.2603, type:'suddenStop'},
  {frac:0.3836, type:'attack'},        // boss #1
  {frac:0.5068, type:'foreignHike'},
  {frac:0.6301, type:'termsOfTrade'},
  {frac:0.7123, type:'suddenStop'},
  {frac:0.8356, type:'attack'},        // boss #2
  {frac:0.9315, type:'foreignHike'}
];

function initState(cfg){
  const c = Object.assign({}, CFG_DEFAULT, cfg||{});
  P.inflTarget=c.inflTarget; P.uStar=c.uStar; P.rStar=c.rStar; P.foreignInfl=c.foreignInfl; P.iStarBase=c.iStar;
  P.termDays = Math.round(c.tenureYears*365);
  P.recEvery = Math.max(1, Math.round(P.termDays/380));   // keep ~380 history points regardless of length
  S = {
    day:0, over:false,
    fx:100, fxPrev:100, reserves:c.reserves, resStart:c.reserves,
    infl:c.infl, unemp:c.unemp, gap:0, i:c.i, iStar:c.iStar,
    nx:0, capFlow:0, bop:0, bs:0, approval:c.approval, gdppc:c.gdppc, population:c.population,
    regime:c.regime, pegTarget:100, openness:c.openness, tariff:c.tariff, fiscal:c.fiscal,
    fxDebt:c.fxDebt, fear:0, attack:0, attackTimer:0, retaliation:0, tot:0,
    priceLevel:1, priceLevelF:1, lastRec:0,
    debtRatio:c.govDebtRatio, debtRate:c.i+1.5, pegCode:c.pegCurrency||'USD', taxRate:c.taxRate, autoDeficit:0,
    score:0, firedReason:null,
    scriptFired:{},
    SCRIPT: SCRIPT_FRACS.map(e=>({day:Math.round(e.frac*P.termDays), type:e.type})),
    H:{fx:[],res:[],infl:[],inflT:[],unemp:[],gap:[],rate:[],istar:[],nx:[],cap:[],bs:[],gdppc:[],debt:[],bop:[],priceLevel:[],priceLevelF:[],debtRate:[],day:[]}
  };
  resetDisp();
}

const gauss = ()=> (Math.random()+Math.random()+Math.random()-1.5)*0.9;

/* ---------- events ---------- */
function log(msg, cls=''){
  const el = document.getElementById('log');
  const d = document.createElement('div');
  d.className = 'e '+cls;
  d.innerHTML = `<b>Day ${S.day}</b> — ${msg}`;
  el.prepend(d);
}

function updateEvents(dt){
  for(const ev of S.SCRIPT){
    if(!S.scriptFired[ev.day] && S.day>=ev.day){ S.scriptFired[ev.day]=true; fire(ev.type); }
  }
  // occasional minor shock (probability scaled to time elapsed)
  if(Math.random() < 0.006*(dt/3)){ fire(Math.random()<0.5?'termsOfTrade':'confidence'); }
  // attack lifecycle
  if(S.attackTimer>0){
    S.attackTimer -= dt;
    if(S.attackTimer<=0){
      S.attack=0;
      if(S.reserves>0 && S.regime==='peg'){
        S.approval+=14; log('The speculators blinked. You held the line — the peg survived the raid.','win');
      }
    }
  }
}

function fire(type){
  switch(type){
    case 'foreignHike':
      S.iStar += 1.5;
      log(`The world's central bank hikes — global rate now <b>${S.iStar.toFixed(2)}%</b>. Capital is being pulled home.`,'crisis');
      break;
    case 'termsOfTrade':{
      const shock = (Math.random()<0.5?-1:1)*(0.8+Math.random());
      S.tot += shock; S.fear += shock<0?0.5:0;
      log(`Terms-of-trade shock: export prices ${shock<0?'collapse':'jump'}.`, shock<0?'crisis':'');
      break;}
    case 'suddenStop':
      S.fear += 1.6;
      log(`<b>Sudden stop.</b> Foreign lenders flee emerging markets. Capital inflows evaporate.`,'crisis');
      break;
    case 'confidence':
      S.fear += 0.7; log('Contagion jitters from a neighbouring economy rattle investors.','crisis'); break;
    case 'attack':
      S.attack = 1; S.attackTimer = 130; S.fear += 1.2;
      log(`<b>SPECULATIVE ATTACK.</b> A hedge fund has bet against your peg. Defend with reserves &amp; rates, or float and take the pain.`,'crisis');
      break;
  }
}

function forceDevaluation(){
  S.regime='float';
  const fair = P.fxBase*(S.priceLevel/S.priceLevelF);
  S.fx = Math.max(S.fx*1.22, fair*1.1);   // snap to (overshoot of) fundamentals
  S.infl += 6;                            // one-off pass-through burst
  const debtHit = Math.min(35, S.fxDebt*0.25);
  S.approval -= (18 + debtHit);
  document.querySelectorAll('#regimeSeg button').forEach(b=>b.classList.toggle('on', b.dataset.r==='float'));
  log(`<b>THE PEG BREAKS.</b> Reserves exhausted — the currency is floated in a rout${S.fxDebt>0?', and your foreign debt just ballooned':''}.`,'crisis');
}

/* ---------- one simulation step ---------- */
function step(dt){
  S.day += dt;
  updateEvents(dt);
  const k = dt/3, kn = Math.sqrt(k);   // scale drift by k, noise by sqrt(k) (calibrated at dt=3)
  const open = S.openness/100;
  const pegHard = S.regime==='peg'?1 : S.regime==='managed'?0.5:0;
  const resRatio = S.reserves/S.resStart;

  // price levels → PPP fair value (currency drifts with inflation differential)
  S.priceLevel  *= (1 + S.infl/100 * dt/360);
  S.priceLevelF *= (1 + P.foreignInfl/100 * dt/360);
  const fair = P.fxBase*(S.priceLevel/S.priceLevelF);

  // risk premium
  let risk = 0;
  risk += Math.max(0,(0.5-resRatio))*4;
  risk += Math.max(0,S.infl-6)*0.10;
  risk += S.fear*2.0;
  risk += S.attack*3.0;
  risk += (1-open)*0.8;
  risk += Math.max(0,S.fxDebt)/100;
  risk += Math.max(0,S.debtRatio-P.debtThresh)*0.012;

  // capital flows: carry minus risk, gated by openness; fear/attack force outflow
  const carry = S.i - S.iStar;
  S.capFlow = clamp(open*P.kappa*(carry - risk) - (S.fear*2 + S.attack*4), -10, 10);

  // trade: real undervaluation + terms of trade drive net exports
  const comp = clamp(S.fx/fair - 1, -0.5, 1.0);
  const tariffBoost = S.tariff*0.03, retalDrag = S.retaliation*0.05;
  S.nx = clamp(P.chi*comp + tariffBoost - retalDrag - 0.3*S.gap + S.tot, -8, 8);

  S.bop = S.nx + S.capFlow;

  // exchange rate / reserves by regime — the trinity's teeth
  S.fxPrev = S.fx;
  if(S.regime==='float'){
    S.fx += ((fair - S.fx)*P.fxRevert - clamp(S.bop,-8,8)*P.fxFlow - S.bs*0.01)*k + gauss()*P.sig.fx*kn;
  } else {
    const absorbed = S.bop*pegHard, toFx = S.bop*(1-pegHard);
    S.reserves += clamp(absorbed*P.resScale, -6, 6)*k;
    S.fx += ((fair-S.fx)*P.fxRevert*(1-pegHard) - clamp(toFx,-8,8)*P.fxFlow + (S.pegTarget - S.fx)*0.25*pegHard)*k
          + gauss()*P.sig.fx*(1-pegHard)*kn;
    if(S.reserves<=0){ S.reserves=0; forceDevaluation(); }
  }
  S.fx = clamp(S.fx, fair*0.55, fair*1.9);
  const depr = clamp((S.fx - S.fxPrev)/S.fxPrev, -0.03, 0.03);

  // IS / output gap
  const realRate = S.i - S.infl;
  const capDrag = (1-open)*1.2, tariffDrag = S.tariff*0.02;
  // Open-economy fiscal multiplier: 1/(1 - c(1-tau) + m). More open economies leak more stimulus
  // abroad through imports (m rises with openness), so the same fiscal push moves output less —
  // the textbook small-open-economy result.
  const mpm = 0.20 + 0.15*(S.openness/100);
  const fiscalMultiplier = 1/(1 - P.mpc*(1-S.taxRate) + mpm);
  const gapT = -P.alpha*(realRate-P.rStar) + P.gammaFx*comp + S.fiscal*fiscalMultiplier + S.bs*0.008 - capDrag - tariffDrag;
  S.gap += P.lamGap*(gapT - S.gap)*k + gauss()*P.sig.gap*kn;
  S.gap = clamp(S.gap, -12, 12);

  // Phillips + pass-through
  const inflT = P.inflTarget + P.phi*S.gap + P.psiPass*depr + S.tariff*0.03 + S.bs*0.02;
  S.infl += P.lamInfl*(inflT - S.infl)*k + gauss()*P.sig.infl*kn;

  // Okun
  S.unemp += P.lamUnemp*((P.uStar - P.beta*S.gap) - S.unemp)*k;
  S.unemp = clamp(S.unemp, 0.5, 25);

  // gdp/capita drift
  const gdpStepFrac = (S.gap*0.0005 - 0.00002)*k;   // this step's actual real-growth fraction (same term applied to gdppc below)
  S.gdppc *= (1 + gdpStepFrac);

  // public debt / GDP — standard debt-dynamics identity: Δd = primary deficit(%GDP) + d·(r−g)
  // r = effective average rate the government borrows at (drifts toward policy rate + a debt-level spread)
  // g = nominal GDP growth this step (real growth fraction above + inflation, as a rough GDP-deflator proxy)
  // Everything below is kept as a *fraction of this step* — dt/365 and dt/360 mirror the same day-scaling
  // used elsewhere in the model (e.g. priceLevel) — so no separate annualize-then-rescale is needed.
  const debtRateTarget = S.i + 0.5 + Math.max(0,S.debtRatio-P.debtThresh)*P.debtIntCoef + risk*0.15
                        - S.bs*0.012 + Math.max(0,S.fiscal)*0.15;
  S.debtRate += (debtRateTarget - S.debtRate)*P.debtRateRev*k;
  const nominalGrowthStepFrac = gdpStepFrac + (S.infl/100)*(dt/360);
  const interestCostStepFrac = (S.debtRate/100)*(dt/365);
  // primary balance = your discretionary choice (fiscal slider) + automatic stabilizers.
  // Tax revenue is (to first order) tau*Y, so a recession (negative gap) shrinks revenue and
  // widens the deficit on its own — this is the textbook automatic-stabilizer effect, and it now
  // runs independently of anything the player does with the fiscal slider.
  S.autoDeficit = -S.taxRate*S.gap;
  const primaryDeficitStepPctGDP = (S.fiscal + S.autoDeficit)*(dt/365);
  S.debtRatio += primaryDeficitStepPctGDP + S.debtRatio*(interestCostStepFrac - nominalGrowthStepFrac);
  S.debtRatio = clamp(S.debtRatio, 0, 400);

  // approval
  let aT = 58;
  aT -= Math.abs(S.infl-P.inflTarget)*2.0;
  aT -= Math.max(0,S.unemp-P.uStar)*2.5;
  aT += clamp(S.gap,-4,4)*1.0;
  aT -= (1-open)*8;
  aT -= S.retaliation*6;
  aT -= Math.max(0,S.fxDebt)/100*3*Math.max(0,comp);
  aT -= Math.max(0,(0.3-resRatio))*15;
  aT -= Math.max(0,S.debtRatio-100)*0.12;
  aT = clamp(aT,0,100);
  S.approval += (aT - S.approval)*0.04*k;
  S.approval = clamp(S.approval,0,100);

  // running score
  S.score += (10 - Math.abs(S.infl-P.inflTarget)*2 - Math.max(0,S.unemp-P.uStar)*1.5
           + clamp(S.gap,-3,3)*0.4 + (resRatio>0.3?2:-3))*k;

  // slow normalisation & decay of transient pressures
  S.iStar += (P.iStarBase - S.iStar)*0.006*k;
  S.tot   *= Math.pow(0.985,k);
  S.fear  *= Math.pow(0.965,k);
  S.bs    *= Math.pow(0.996,k);
  S.retaliation *= Math.pow(0.99,k);

  if(S.day - S.lastRec >= P.recEvery){ pushHistory(); S.lastRec = S.day; }
  checkEnd();
}

function pushHistory(){
  const H=S.H;
  H.fx.push(S.fx); H.res.push(S.reserves); H.infl.push(S.infl); H.inflT.push(P.inflTarget);
  H.unemp.push(S.unemp); H.gap.push(S.gap); H.rate.push(S.i); H.istar.push(S.iStar);
  H.nx.push(S.nx); H.cap.push(S.capFlow); H.bs.push(S.bs); H.gdppc.push(S.gdppc); H.debt.push(S.debtRatio);
  H.bop.push(S.bop); H.priceLevel.push(S.priceLevel); H.priceLevelF.push(S.priceLevelF); H.debtRate.push(S.debtRate); H.day.push(S.day);
  for(const k in H){ if(H[k].length>P.MAXLEN) H[k].shift(); }
}

function checkEnd(){
  if(S.over) return;
  if(S.approval<12){ endGame(false,'Escorted from the building','Your approval collapsed. The government has removed you from office.'); }
  else if(S.infl>45){ endGame(false,'Hyperinflation','Prices are doubling in weeks. The currency has lost all meaning, and so has your tenure.'); }
  else if(S.debtRatio>220){ endGame(false,'Sovereign Default','Public debt has spiralled past what the economy can service. Creditors have stopped rolling it over — the treasury cannot pay.'); }
  else if(S.day>=P.termDays){ endGame(true,'Full term served','You navigated the tide and kept the trilemma from breaking you. History is kind.'); }
}

function endGame(won, title, body){
  S.over=true; stop();
  document.getElementById('modalTitle').textContent = title;
  document.getElementById('modalScore').textContent = Math.round(S.score);
  document.getElementById('modalBody').textContent = body;
  document.getElementById('modalTenure').textContent =
    `Served ${(S.day/365).toFixed(1)} of ${(P.termDays/365).toFixed(0)} years as Governor`;
  document.getElementById('statsGrid').innerHTML = buildStatsRows().map(renderStatRow).join('');
  document.getElementById('shareBox').style.display='none';
  document.getElementById('overlay').classList.add('show');
}

// Rows for the end-of-tenure before/after comparison. betterWhenLower: true/false = colored by
// direction; null = purely informational (no good/bad judgement — e.g. the regime you chose).
function buildStatsRows(){
  const s=startSnapshot || { fx:100, reserves:S.resStart, infl:S.infl, unemp:S.unemp, gdppc:S.gdppc,
    population:S.population, debtRatio:S.debtRatio, approval:S.approval, i:S.i, regime:S.regime };
  const totalGdpStart=s.gdppc*s.population/1000, totalGdpEnd=S.gdppc*S.population/1000;
  return [
    { label:'Regime', start:s.regime.toUpperCase(), end:S.regime.toUpperCase(), better:null },
    { label:'Exchange rate', start:s.fx.toFixed(1), end:S.fx.toFixed(1), better:null },
    { label:'FX reserves ($B)', start:fmtMoney(s.reserves), end:fmtMoney(S.reserves),
      better: S.reserves>s.reserves },
    { label:'Inflation (%)', start:s.infl.toFixed(1), end:S.infl.toFixed(1),
      better: Math.abs(S.infl-P.inflTarget) < Math.abs(s.infl-P.inflTarget) },
    { label:'Unemployment (%)', start:s.unemp.toFixed(1), end:S.unemp.toFixed(1),
      better: Math.abs(S.unemp-P.uStar) < Math.abs(s.unemp-P.uStar) },
    { label:'GDP per capita', start:fmtMoney(s.gdppc), end:fmtMoney(S.gdppc),
      better: S.gdppc>s.gdppc },
    { label:'Total GDP', start:fmtGdpShort(totalGdpStart), end:fmtGdpShort(totalGdpEnd),
      better: totalGdpEnd>totalGdpStart },
    { label:'Public debt / GDP (%)', start:s.debtRatio.toFixed(0), end:S.debtRatio.toFixed(0),
      better: S.debtRatio<s.debtRatio },
    { label:'Policy rate (%)', start:s.i.toFixed(2), end:S.i.toFixed(2), better:null },
    { label:'Political approval', start:Math.round(s.approval), end:Math.round(S.approval),
      better: S.approval>s.approval },
  ];
}
function renderStatRow(r){
  const cls = r.better===null ? '' : (r.better ? 'good' : 'bad');
  return `<div class="stat-row"><div class="stat-label">${r.label}</div>`
       + `<div class="stat-val">${r.start}</div><div class="stat-arrow">→</div>`
       + `<div class="stat-val ${cls}">${r.end}</div></div>`;
}
function buildShareText(){
  const rows=buildStatsRows();
  const lines=[
    `TRILEMMA — ${document.getElementById('modalTitle').textContent}`,
    `Score ${Math.round(S.score)} · served ${(S.day/365).toFixed(1)}/${(P.termDays/365).toFixed(0)} yrs as Governor`,
    ''
  ];
  rows.forEach(r=>lines.push(`${r.label}: ${r.start} → ${r.end}`));
  return lines.join('\n');
}
function shareStats(){
  const text=buildShareText();
  document.getElementById('shareText').value=text;
  document.getElementById('shareBox').style.display='block';
  const label=document.getElementById('shareBtnLabel');
  const done=()=>{ label.textContent='Copied!'; setTimeout(()=>{ label.textContent='Share stats'; },1800); };
  if(navigator.clipboard && navigator.clipboard.writeText){
    navigator.clipboard.writeText(text).then(done).catch(()=>{ document.getElementById('shareText').select(); });
  } else {
    document.getElementById('shareText').select();
  }
}

/* ---------- controls ---------- */
function bumpRate(d){ S.i=Math.max(0,Math.round((S.i+d)*100)/100); syncUI(); }
function doQE(){ S.bs+=20; log('QE: balance sheet expands, liquidity floods in.'); syncUI(); }
function doQT(){ S.bs-=20; log('QT: draining liquidity from the system.'); syncUI(); }
function setRegime(r){
  S.regime=r; if(r!=='float') S.pegTarget=S.fx;
  document.querySelectorAll('#regimeSeg button').forEach(b=>b.classList.toggle('on',b.dataset.r===r));
  log(`Regime set to <b>${r.toUpperCase()}</b>${r!=='float'?` at ${S.pegTarget.toFixed(1)} vs the ${PEG_CURRENCIES[S.pegCode]?.label||S.pegCode}`:''}.`);
  syncUI();
}
function intervene(dir){
  // chunk scales with the scenario's own reserve base, so a $15B move means the same thing
  // (~7.5% of the war chest) whether you started with $500B or $15B
  const chunk = Math.max(1, S.resStart*0.075);
  if(dir<0){ if(S.reserves<chunk){log('Not enough reserves to intervene.','crisis');return;} S.reserves-=chunk; S.fx-=1.2; }
  else { S.reserves+=chunk; S.fx+=1.0; }
  syncUI();
}
function setOpen(v){ S.openness=+v; syncUI(); }
function setTariff(v){
  const old=S.tariff; S.tariff=+v;
  if(S.tariff>old+0.001 && S.tariff>10 && Math.random()<0.3){ S.retaliation+=1; log('Trading partners retaliate against your tariffs.','crisis'); }
  syncUI();
}
function setFiscal(v){ S.fiscal=+v; syncUI(); }
function setTax(v){ S.taxRate=(+v)/100; syncUI(); }
function borrowFx(){
  const chunk = Math.max(1, Math.round(S.resStart*0.2));
  S.reserves+=chunk; S.fxDebt+=chunk;
  log(`Raised $${chunk}B in foreign-currency debt. Reserves up — pray the currency holds.`,'warn');
  syncUI();
}

/* ---------- UI sync ---------- */
function fmtMoney(n){ return '$'+Math.round(n).toLocaleString(); }
function cls(v,good){ return good ? 'good':'bad'; }

function syncUI(){
  const open=S.openness/100, pegHard=S.regime==='peg'?1:S.regime==='managed'?0.5:0;
  const aut=Math.round((1-open*pegHard)*100);
  document.getElementById('autVal').textContent=aut+'%';
  document.getElementById('autBar').style.width=aut+'%';

  document.getElementById('rateVal').textContent=S.i.toFixed(2)+'%';
  document.getElementById('rateBig').textContent=S.i.toFixed(2);
  document.getElementById('istarInline').textContent=S.iStar.toFixed(2)+'%';
  document.getElementById('bsVal').textContent=(S.bs>=0?'+$':'−$')+Math.abs(S.bs)+'B';
  document.getElementById('openVal').textContent=S.openness+'%';
  document.getElementById('tariffVal').textContent=S.tariff+'%';
  document.getElementById('fiscalVal').textContent=(+S.fiscal).toFixed(1);
  document.getElementById('taxVal').textContent=Math.round(S.taxRate*100)+'%';
  const autoEl=document.getElementById('autoDeficitHint');
  if(autoEl) autoEl.textContent = 'Automatic stabilizers right now: '+(S.autoDeficit>=0?'+':'')+S.autoDeficit.toFixed(1)+'% of GDP.';

  // cards — noisy readouts use the eased DISP values so they glide instead of flickering
  const fxEl=document.getElementById('c-fx'); fxEl.textContent=DISP.fx.toFixed(1);
  fxEl.className='v '+(DISP.fx>P.fxBase*1.05?'bad':DISP.fx<P.fxBase*0.97?'good':'');
  document.getElementById('c-fxsub').textContent = S.fx>S.fxPrev?'▼ weaker':'▲ firmer';
  document.getElementById('c-res').textContent=fmtMoney(DISP.reserves)+'B';
  document.getElementById('c-res').className='v '+(DISP.reserves<S.resStart*0.3?'bad':'accentv');
  const inflEl=document.getElementById('c-infl'); inflEl.textContent=DISP.infl.toFixed(1)+'%';
  inflEl.className='v '+(Math.abs(DISP.infl-P.inflTarget)<1.2?'good':Math.abs(DISP.infl-P.inflTarget)<3?'warn':'bad');
  document.getElementById('c-infltarget').textContent='target '+P.inflTarget.toFixed(1)+'%';
  const unEl=document.getElementById('c-unemp'); unEl.textContent=DISP.unemp.toFixed(1)+'%';
  unEl.className='v '+(DISP.unemp<P.uStar+1?'good':DISP.unemp<P.uStar+2.5?'warn':'bad');
  document.getElementById('c-unatural').textContent='natural '+P.uStar.toFixed(1)+'%';
  document.getElementById('c-gdp').textContent=fmtMoney(S.gdppc);
  document.getElementById('c-gdptotal').textContent='Total '+fmtGdpShort(S.gdppc*S.population/1000);
  document.getElementById('c-gapsub').textContent='gap '+(DISP.gap>=0?'+':'')+DISP.gap.toFixed(1)+'%';
  const apEl=document.getElementById('c-appr'); apEl.textContent=Math.round(S.approval);
  apEl.className='v '+(S.approval>40?'good':S.approval>20?'warn':'bad');
  document.getElementById('c-score').textContent=Math.round(S.score);
  document.getElementById('c-daysub').textContent='Year '+(S.day/365).toFixed(1)+' / '+Math.round(P.termDays/365);
  document.getElementById('c-regime').textContent=S.regime.toUpperCase()+(S.regime!=='float'?' · '+S.pegCode:'');
  document.getElementById('c-fxdebt').textContent='FX debt '+fmtMoney(S.fxDebt)+'B';
  const debtEl=document.getElementById('c-debt');
  debtEl.textContent='Debt/GDP '+DISP.debtRatio.toFixed(0)+'%';
  debtEl.className=DISP.debtRatio>150?'bad':DISP.debtRatio>P.debtThresh?'warn':'good';
  document.getElementById('borrowBtn').textContent = `Borrow $${Math.max(1,Math.round(S.resStart*0.2))}B in foreign currency (cheap now…)`;

  // trade balance — bipolar gauge, surplus (good) right / deficit (bad) left
  const tEl=document.getElementById('c-trade');
  tEl.textContent=(DISP.nx>=0?'+':'')+DISP.nx.toFixed(1);
  tEl.className='v '+(Math.abs(DISP.nx)<0.8?'warn':DISP.nx>=0?'good':'bad');
  const tf=document.getElementById('c-tradefill');
  const tPct=clamp(Math.abs(DISP.nx)/8*50, 0, 50);
  tf.style.background = DISP.nx>=0 ? 'var(--good)' : 'var(--bad)';
  if(DISP.nx>=0){ tf.style.left='50%'; tf.style.width=tPct+'%'; }
  else { tf.style.left=(50-tPct)+'%'; tf.style.width=tPct+'%'; }

  // clock
  const months=['Jan','Feb','Mar','Apr','May','Jun','Jul','Aug','Sep','Oct','Nov','Dec'];
  const mi=Math.floor(S.day/30)%12, yr=1+Math.floor(S.day/360);
  document.getElementById('clock').textContent=`${months[mi]}, Year ${yr}`;
}

/* ---------- charts ---------- */
let CH={};
// DISP holds time-eased copies of the noisiest readouts, so the on-screen numbers glide
// instead of flickering with every micro-step's random shock. Chart history (H.*) stays raw/true —
// only the live numbers use DISP.
let DISP={};
const DISP_FIELDS=['fx','reserves','infl','unemp','gap','nx','capFlow','bs','debtRatio'];
function resetDisp(){ DISP_FIELDS.forEach(k=>DISP[k]=S[k]); }
function updateDisp(ms){
  const a = 1-Math.exp(-ms/140);   // ~140ms time-constant — frame-rate independent
  DISP_FIELDS.forEach(k=>{ DISP[k] += (S[k]-DISP[k])*a; });
}
const CGOOD='#07ba13', CBAD='#fa0202', CWARN='#fad902', CNEUTRAL='#8fb2c9', CDIM='#4d525d', CVIOLET='#a98cf0';
const baseOpts=(extra={})=>({
  animation:false, responsive:true, maintainAspectRatio:false,
  plugins:{legend:{display:false}},
  scales:{
    x:{display:false},
    y:{ticks:{color:'#5c6472',font:{size:9},maxTicksLimit:4},grid:{color:'#171a20'}}
  }, elements:{point:{radius:0}}, ...extra
});
function mkChart(id, datasets, opts){
  return new Chart(document.getElementById(id),{type:'line',data:{labels:[],datasets},options:opts||baseOpts()});
}
function line(color,fill){ return {data:[],borderColor:color,borderWidth:1.8,tension:.3,fill:fill?{target:'origin'}:false,backgroundColor:fill?color+'1f':undefined}; }
// a line whose color flips between good/bad by the sign of the value — the surplus/deficit signature
function bipolarLine(){
  return {
    data:[], borderWidth:1.8, tension:.3, fill:false,
    segment:{ borderColor: ctx => ((ctx.p0.parsed.y+ctx.p1.parsed.y)/2) >= 0 ? CGOOD : CBAD }
  };
}

function buildCharts(){
  clearOptionalCharts();
  Object.values(CH).forEach(c=>c.destroy&&c.destroy()); CH={};
  CH.fx=mkChart('ch-fx',[line(CWARN,true),{data:[],borderColor:CDIM,borderWidth:1,borderDash:[5,4],tension:0}]);
  CH.res=mkChart('ch-res',[line(CNEUTRAL,true)]);
  CH.infl=mkChart('ch-infl',[line(CNEUTRAL,false),{data:[],borderColor:CDIM,borderWidth:1,borderDash:[5,4]}]);
  CH.unemp=mkChart('ch-unemp',[line(CWARN,false)]);
  CH.gap=mkChart('ch-gap',[bipolarLine()]);
  CH.gdp=mkChart('ch-gdp',[line(CGOOD,true)]);
  CH.rate=mkChart('ch-rate',[line(CNEUTRAL,false),{data:[],borderColor:CBAD,borderWidth:1.4,borderDash:[4,3]}]);
  CH.trade=mkChart('ch-trade',[bipolarLine()]);
  CH.cap=mkChart('ch-cap',[bipolarLine()]);
  CH.bs=mkChart('ch-bs',[line(CVIOLET,true)]);
  CH.debt=mkChart('ch-debt',[line(CWARN,true)]);
  selectedCharts.forEach(buildOptionalChart);
}

// Optional charts — data the model already computes each step but doesn't show by default.
// Picked on the setup screen; the 11 charts above are always shown and unaffected by this.
const OPTIONAL_CHARTS = {
  bop:   { label:'Balance of payments (current + capital acct)' },
  prices:{ label:'Domestic vs foreign price level (index)' },
  debtrate:{ label:'Govt borrowing rate vs policy rate (%)' }
};
let selectedCharts = new Set();
let startSnapshot = null;
function clearOptionalCharts(){
  document.querySelectorAll('#chartsGrid .chart[data-opt-id]').forEach(el=>el.remove());
  Object.keys(CH).filter(k=>k.startsWith('opt_')).forEach(k=>{ CH[k].destroy&&CH[k].destroy(); delete CH[k]; });
}
function buildOptionalChart(id){
  const def=OPTIONAL_CHARTS[id]; if(!def) return;
  const div=document.createElement('div');
  div.className='chart'; div.dataset.optId=id;
  div.innerHTML=`<div class="ct"><span>${def.label}</span><span class="cv" id="cv-opt-${id}">0</span></div><canvas id="ch-opt-${id}"></canvas>`;
  document.getElementById('chartsGrid').appendChild(div);
  if(id==='bop')      CH['opt_'+id]=mkChart('ch-opt-'+id,[bipolarLine()]);
  else if(id==='prices')  CH['opt_'+id]=mkChart('ch-opt-'+id,[line(CGOOD,false),{data:[],borderColor:CDIM,borderWidth:1,borderDash:[5,4]}]);
  else if(id==='debtrate')CH['opt_'+id]=mkChart('ch-opt-'+id,[line(CWARN,false),{data:[],borderColor:CNEUTRAL,borderWidth:1.4,borderDash:[4,3]}]);
}
function fmtGdpShort(totalB){
  return totalB>=1000 ? '$'+(totalB/1000).toFixed(2)+'T' : '$'+Math.round(totalB)+'B';
}
function updateCharts(){
  const H=S.H, L=H.day.map(d=>d);
  const set=(c,arrs)=>{ c.data.labels=L; arrs.forEach((a,i)=>c.data.datasets[i].data=a); c.update('none'); };
  const totalGdpSeries = H.gdppc.map(v=>v*S.population/1000);   // $B, derived — population is constant per run
  set(CH.fx,[H.fx,H.day.map(()=>S.pegTarget)]);
  set(CH.res,[H.res]);
  set(CH.infl,[H.infl,H.inflT]);
  set(CH.unemp,[H.unemp]);
  set(CH.gap,[H.gap]);
  set(CH.gdp,[totalGdpSeries]);
  set(CH.rate,[H.rate,H.istar]);
  set(CH.trade,[H.nx]);
  set(CH.cap,[H.cap]);
  set(CH.bs,[H.bs]);
  set(CH.debt,[H.debt]);
  if(selectedCharts.has('bop')){
    set(CH.opt_bop,[H.bop]);
    const el=document.getElementById('cv-opt-bop'); el.textContent=(S.bop>=0?'+':'')+S.bop.toFixed(1); el.className='cv '+(S.bop>=0?'good':'bad');
  }
  if(selectedCharts.has('prices')){
    set(CH.opt_prices,[H.priceLevel,H.priceLevelF]);
    document.getElementById('cv-opt-prices').textContent=S.priceLevel.toFixed(2);
  }
  if(selectedCharts.has('debtrate')){
    set(CH.opt_debtrate,[H.debtRate,H.rate]);
    document.getElementById('cv-opt-debtrate').textContent=S.debtRate.toFixed(1);
  }
  const cv=(id,val,goodBad)=>{
    const el=document.getElementById(id); el.textContent=val;
    if(goodBad!==undefined) el.className='cv '+(goodBad>=0?'good':'bad');
  };
  cv('cv-fx',DISP.fx.toFixed(1));
  cv('cv-res',Math.round(DISP.reserves));
  cv('cv-infl',DISP.infl.toFixed(1));
  cv('cv-unemp',DISP.unemp.toFixed(1));
  cv('cv-gap',(DISP.gap>=0?'+':'')+DISP.gap.toFixed(1), DISP.gap);
  cv('cv-gdp',fmtGdpShort(S.gdppc*S.population/1000));
  cv('cv-rate',S.i.toFixed(1));
  cv('cv-trade',(DISP.nx>=0?'+':'')+DISP.nx.toFixed(1), DISP.nx);
  cv('cv-cap',(DISP.capFlow>=0?'+':'')+DISP.capFlow.toFixed(1), DISP.capFlow);
  cv('cv-bs',(DISP.bs>=0?'+':'')+Math.round(DISP.bs));
  const dEl=document.getElementById('cv-debt');
  dEl.textContent=DISP.debtRatio.toFixed(0);
  dEl.className='cv '+(DISP.debtRatio>150?'bad':DISP.debtRatio>P.debtThresh?'warn':'good');
}

/* ---------- scenarios ---------- */
// Illustrative starting points, not calibrated historical reconstructions — each is a stylised
// combination of income level, price/labour conditions, and regime choice for teaching purposes.
const SCENARIOS = {
  custom: { brief:'Configure every starting condition yourself — a blank slate.', vals:{} },
  advanced: {
    brief:'A high-income, fully open economy with a credible inflation-targeting central bank and a freely floating currency. The default calibration the model was built around.',
    vals:{ population:60, gdppc:65000, infl:4, unemp:6, i:6, iStar:4, reserves:200, openness:70, regime:'peg', fxDebt:0, approval:55, tariff:0, fiscal:0, inflTarget:3, uStar:5, rStar:2, foreignInfl:2, govDebtRatio:70, pegCurrency:'USD', taxRate:0.28 }
  },
  india1947: {
    brief:'Illustrative, not a historical reconstruction — a stylised newly independent, primarily agrarian economy: low income per head, a managed/pegged currency typical of the Bretton Woods era, tight capital controls, thin reserves, and a fragile approval base.',
    vals:{ population:350, gdppc:250, infl:8, unemp:12, i:4, iStar:3, reserves:15, openness:10, regime:'peg', fxDebt:5, approval:60, tariff:15, fiscal:1, inflTarget:5, uStar:10, rStar:2, foreignInfl:2, govDebtRatio:30, pegCurrency:'GBP', taxRate:0.12 }
  },
  postwar: {
    brief:'A devastated advanced economy rebuilding after a major war: depressed output, high unemployment, a fixed rate under a Bretton-Woods-style system, and heavy capital controls while reconstruction is financed.',
    vals:{ population:45, gdppc:1800, infl:12, unemp:18, i:3, iStar:2, reserves:40, openness:15, regime:'peg', fxDebt:30, approval:55, tariff:20, fiscal:2, inflTarget:4, uStar:8, rStar:2, foreignInfl:2, govDebtRatio:130, pegCurrency:'USD', taxRate:0.32 }
  },
  stagflation: {
    brief:'An oil-importing advanced economy hit by a terms-of-trade shock: inflation and unemployment both elevated, the old fixed-rate system has just given way to floating, and capital is freely mobile.',
    vals:{ population:90, gdppc:9000, infl:11, unemp:8, i:8, iStar:7, reserves:120, openness:85, regime:'float', fxDebt:20, approval:45, tariff:5, fiscal:0, inflTarget:3, uStar:6, rStar:2, foreignInfl:5, govDebtRatio:45, pegCurrency:'USD', taxRate:0.30 }
  },
  liberalization: {
    brief:'A developing economy mid-reform: capital controls are being dismantled, the currency has just moved to a managed float, reserves are modest, and growth expectations are high but fragile.',
    vals:{ population:120, gdppc:1500, infl:9, unemp:9, i:11, iStar:5, reserves:60, openness:55, regime:'managed', fxDebt:45, approval:52, tariff:8, fiscal:0.5, inflTarget:5, uStar:7, rStar:3, foreignInfl:2, govDebtRatio:55, pegCurrency:'USD', taxRate:0.18 }
  },
  petrostate: {
    brief:'A resource exporter riding a commodity boom: strong terms of trade, a hard currency peg defended with ample reserves, a partly closed capital account, and a comfortable approval cushion — until the terms of trade turn.',
    vals:{ population:10, gdppc:14000, infl:4, unemp:5, i:5, iStar:4, reserves:260, openness:35, regime:'peg', fxDebt:10, approval:65, tariff:5, fiscal:1.5, inflTarget:3, uStar:5, rStar:2, foreignInfl:2, govDebtRatio:20, pegCurrency:'USD', taxRate:0.15 }
  }
};
let pendingRegime='peg', pendingPegCode='USD', applyingScenario=false;

function updateSetupLabels(){
  const one = (id, decimals, suffix)=>{
    const inp=document.getElementById(id), lbl=document.getElementById(id+'Val');
    if(!inp||!lbl) return;
    lbl.textContent = (+inp.value).toFixed(decimals) + suffix;
  };
  one('setReserves',0,''); one('setInfl',1,'%'); one('setUnemp',1,'%');
  one('setRatePolicy',2,'%'); one('setRateWorld',2,'%'); one('setOpenness',0,'%');
  one('setFxDebt',0,''); one('setApproval',0,''); one('setTariff0',0,'%'); one('setDebtRatio',0,'%'); one('setTaxRate',0,'%');
  one('setInflTarget',1,'%'); one('setUStar',1,'%'); one('setRStar',1,'%');
  one('setForeignInfl',1,'%'); one('setFiscal0',1,''); one('setTenure',0,'');
  const gdppc=+document.getElementById('setGdppc').value, pop=+document.getElementById('setPopulation').value;
  document.getElementById('totalGdpHint').textContent = 'Total GDP: '+fmtGdpShort(gdppc*pop/1000)+' ('+pop+'M people)';
}
function markCustom(){
  if(applyingScenario) return;
  document.querySelectorAll('.scenario-btn').forEach(b=>b.classList.toggle('on', b.dataset.k==='custom'));
}
function onSetupInput(){ updateSetupLabels(); markCustom(); }
function setRegimePick(r){
  pendingRegime=r;
  document.querySelectorAll('#setRegimeSeg button').forEach(b=>b.classList.toggle('on',b.dataset.r===r));
  markCustom();
}
function setPegCurrency(code){
  pendingPegCode=code;
  const c=PEG_CURRENCIES[code];
  document.getElementById('setRateWorld').value=c.iStar;
  document.getElementById('setForeignInfl').value=c.foreignInfl;
  document.querySelectorAll('#pegCurSeg button').forEach(b=>b.classList.toggle('on',b.dataset.c===code));
  updateSetupLabels();
  markCustom();
}
function applyScenario(key){
  applyingScenario=true;
  const sc = SCENARIOS[key], v = Object.assign({}, CFG_DEFAULT, sc.vals);
  document.getElementById('setGdppc').value = v.gdppc;
  document.getElementById('setPopulation').value = v.population;
  document.getElementById('setReserves').value = v.reserves;
  document.getElementById('setInfl').value = v.infl;
  document.getElementById('setUnemp').value = v.unemp;
  document.getElementById('setRatePolicy').value = v.i;
  document.getElementById('setRateWorld').value = v.iStar;
  document.getElementById('setOpenness').value = v.openness;
  document.getElementById('setFxDebt').value = v.fxDebt;
  document.getElementById('setApproval').value = v.approval;
  document.getElementById('setTariff0').value = v.tariff;
  document.getElementById('setFiscal0').value = v.fiscal;
  document.getElementById('setInflTarget').value = v.inflTarget;
  document.getElementById('setUStar').value = v.uStar;
  document.getElementById('setRStar').value = v.rStar;
  document.getElementById('setForeignInfl').value = v.foreignInfl;
  document.getElementById('setDebtRatio').value = v.govDebtRatio;
  document.getElementById('setTaxRate').value = Math.round(v.taxRate*100);
  // tenure length is a run setting, not an economic condition — scenarios never touch it
  pendingPegCode = v.pegCurrency || 'USD';
  document.querySelectorAll('#pegCurSeg button').forEach(b=>b.classList.toggle('on',b.dataset.c===pendingPegCode));
  setRegimePick(v.regime);
  document.getElementById('scenarioBrief').textContent = sc.brief;
  document.querySelectorAll('.scenario-btn').forEach(b=>b.classList.toggle('on', b.dataset.k===key));
  updateSetupLabels();
  applyingScenario=false;
}
function collectSetupCfg(){
  return {
    gdppc:+document.getElementById('setGdppc').value,
    population:+document.getElementById('setPopulation').value,
    tenureYears:+document.getElementById('setTenure').value,
    reserves:+document.getElementById('setReserves').value,
    infl:+document.getElementById('setInfl').value,
    unemp:+document.getElementById('setUnemp').value,
    i:+document.getElementById('setRatePolicy').value,
    iStar:+document.getElementById('setRateWorld').value,
    openness:+document.getElementById('setOpenness').value,
    regime:pendingRegime,
    fxDebt:+document.getElementById('setFxDebt').value,
    approval:+document.getElementById('setApproval').value,
    tariff:+document.getElementById('setTariff0').value,
    fiscal:+document.getElementById('setFiscal0').value,
    inflTarget:+document.getElementById('setInflTarget').value,
    uStar:+document.getElementById('setUStar').value,
    rStar:+document.getElementById('setRStar').value,
    foreignInfl:+document.getElementById('setForeignInfl').value,
    govDebtRatio:+document.getElementById('setDebtRatio').value,
    taxRate:(+document.getElementById('setTaxRate').value)/100,
    pegCurrency:pendingPegCode
  };
}

/* ---------- tabs ---------- */
function switchTab(name){
  document.querySelectorAll('.tab').forEach(b=>b.classList.toggle('on',b.dataset.tab===name));
  document.getElementById('tab-setup').style.display = name==='setup' ? '' : 'none';
  document.getElementById('tab-manual').style.display = name==='manual' ? '' : 'none';
}

/* ---------- loop ---------- */
let rafId=null, lastT=null, wasRunningBeforeHelp=false, introMode='newrun';
function toggleRun(){
  if(S.over) return;
  if(rafId){ stop(); document.getElementById('startBtn').textContent='▶ RESUME'; }
  else { start(); document.getElementById('startBtn').textContent='❚❚ PAUSE'; }
}
function setSpeed(s){
  speed=s;
  document.getElementById('spdVal').textContent=s+'×';
  document.querySelectorAll('#spdSeg button').forEach(b=>b.classList.toggle('on',+b.dataset.s===s));
}
function loopFrame(ts){
  if(lastT===null) lastT=ts;
  const elapsed = Math.min(ts-lastT, 250);   // cap so a backgrounded tab doesn't jump-cut on return
  lastT=ts;
  dayAcc += (elapsed/FRAME_MS)*BASE_DPF*speed;
  let n=0;
  while(dayAcc>=1 && !S.over && n<200){ step(1); dayAcc-=1; n++; }  // 1-day micro-steps
  updateDisp(elapsed);
  frameCount++;
  syncUI();
  updateCharts();
  if(!S.over) rafId=requestAnimationFrame(loopFrame);
}
function start(){ if(!rafId){ lastT=null; rafId=requestAnimationFrame(loopFrame); } }
function stop(){ if(rafId){ cancelAnimationFrame(rafId); rafId=null; } }

function showIntro(mode){
  introMode = mode||'newrun';
  const setupTabBtn = document.querySelector('.tab[data-tab="setup"]');
  const beginBtn = document.getElementById('beginBtn');
  if(introMode==='help'){
    wasRunningBeforeHelp = !!rafId;
    if(rafId){ stop(); document.getElementById('startBtn').textContent='▶ RESUME'; }
    setupTabBtn.style.display='none';
    switchTab('manual');
    beginBtn.textContent='Resume';
    beginBtn.onclick=closeIntroHelp;
  } else {
    stop();
    document.getElementById('overlay').classList.remove('show');
    setupTabBtn.style.display='';
    switchTab('setup');
    beginBtn.textContent='Begin tenure';
    beginBtn.onclick=beginTenure;
  }
  document.getElementById('introOverlay').classList.add('show');
}
function closeIntroHelp(){
  document.getElementById('introOverlay').classList.remove('show');
  if(wasRunningBeforeHelp){ start(); document.getElementById('startBtn').textContent='❚❚ PAUSE'; }
}
function beginTenure(){
  const cfg = collectSetupCfg();
  document.getElementById('introOverlay').classList.remove('show');
  document.getElementById('log').innerHTML='';
  stop(); dayAcc=0; frameCount=0; lastT=null; setSpeed(1);
  initState(cfg);
  selectedCharts = new Set(Array.from(document.querySelectorAll('#optChartsPicker input:checked')).map(el=>el.dataset.opt));
  startSnapshot = {
    fx:S.fx, reserves:S.reserves, infl:S.infl, unemp:S.unemp, gdppc:S.gdppc, population:S.population,
    debtRatio:S.debtRatio, approval:S.approval, i:S.i, regime:S.regime, pegCode:S.pegCode, taxRate:S.taxRate
  };
  resetDisp();
  document.getElementById('openSlider').value=cfg.openness;
  document.getElementById('tariffSlider').value=cfg.tariff;
  document.getElementById('fiscalSlider').value=cfg.fiscal;
  document.getElementById('taxSlider').value=Math.round(cfg.taxRate*100);
  document.querySelectorAll('#regimeSeg button').forEach(b=>b.classList.toggle('on',b.dataset.r===cfg.regime));
  buildCharts(); pushHistory(); syncUI(); updateCharts();
  document.getElementById('startBtn').textContent='▶ START';
  log(`${cfg.tenureYears}-year tenure begins over a ${fmtGdpShort(cfg.gdppc*cfg.population/1000)} economy (${cfg.population}M people). Starting inflation ${cfg.infl.toFixed(1)}%, unemployment ${cfg.unemp.toFixed(1)}%, reserves $${cfg.reserves}B, public debt ${cfg.govDebtRatio}% of GDP, under a ${cfg.regime} regime vs the ${PEG_CURRENCIES[cfg.pegCurrency]?.label||cfg.pegCurrency}. Good luck.`);
}

/* boot */
initState(CFG_DEFAULT); buildCharts(); pushHistory(); syncUI(); updateCharts();
applyScenario('advanced');
showIntro('newrun');
