'use strict';
/**
 * Hardware Developer scenarios. Both read a "hardware design": a list of parametric parts (see ../cad.js), the other parts you buy (bom),
 * and print settings. Material prices, machine rates and moulding costs are ASSUMPTIONS you replace with your own.
 *  - print_run: what it takes to print the design: filament, hours, cost per unit, parts that do not fit, and print problems.
 *  - build_economics: unit cost across volumes, printing against injection moulding, break-even and margin.
 */
const cad = require('../cad');
const { round } = require('../util');

const DEFAULT_DESIGN = () => ({
  name: 'Robot arm kit (illustrative)', units: 'mm',
  parts: [
    { id: 'p1', name: 'Base plate', type: 'mounting_plate', params: { width: 100, depth: 80, thickness: 4, corner: 6, cols: 4, rows: 3, hole: 3.4, margin: 8 }, qty: 1 },
    { id: 'p2', name: 'Arm link', type: 'robot_link', params: { length: 100, width: 24, thickness: 6, hole: 6, slot: 50 }, qty: 2 },
    { id: 'p3', name: 'Gripper finger', type: 'gripper_finger', params: { length: 60, baseWidth: 22, tipWidth: 8, thickness: 6, pivot: 4 }, qty: 2 },
    { id: 'p4', name: 'Drive gear', type: 'spur_gear', params: { module: 1.5, teeth: 24, thickness: 8, bore: 5 }, qty: 2 },
    { id: 'p5', name: 'Controller box', type: 'enclosure_box', params: { width: 90, depth: 60, height: 30, wall: 2.4, floor: 2.4 }, qty: 1 },
    { id: 'p6', name: 'Controller lid', type: 'enclosure_lid', params: { width: 90, depth: 60, thickness: 2.4, wall: 2.4, lip: 4, fit: 0.3 }, qty: 1 },
  ],
  bom: [{ item: 'Hobby servo', qty: 4, unitCost: 9 }, { item: 'Microcontroller board', qty: 1, unitCost: 12 }, { item: 'Battery pack', qty: 1, unitCost: 14 }, { item: 'Screws, nuts and wire', qty: 1, unitCost: 4 }],
  printSettings: { material: 'PLA', printer: 'standard', layerHeight: 0.2, infillPct: 20, perimeters: 2, solidLayers: 4, nozzle: 0.4 },
  price: 120,
});
const num = (v, d) => (Number.isFinite(Number(v)) && v !== '' && v !== null && v !== undefined ? Number(v) : d);

function partResults(design, st) {
  return design.parts.map((p) => {
    const base = { id: p.id, name: p.name, type: p.type, qty: Math.max(1, Math.round(num(p.qty, 1))) };
    try { if (p._error) throw new Error(p._error); const part = p.type === 'imported' ? p._built : cad.buildPart(p.type, p.params); if (!part) throw new Error('This imported model could not be read.'); const c = cad.printCheck(part, st); return { ...base, fits: c.fits, size: c.size, orientation: c.orientation, grams: c.estimate.grams, hours: c.estimate.hours, materialCost: c.estimate.materialCost, volumeMm3: c.estimate.volumeMm3, warnings: c.warnings }; }
    catch (e) { return { ...base, error: e.message, fits: false, grams: 0, hours: 0, materialCost: 0, warnings: [e.message] }; }
  });
}
function run({ design, params = {} }) {
  const st = cad.cleanSettings(design.printSettings || {}); const qty = Math.min(Math.max(Math.round(num(params.quantity, 10)), 1), 100000), printers = Math.min(Math.max(Math.round(num(params.printers, 1)), 1), 200);
  const rate = num(params.machineRatePerHour, 1.5), power = num(params.electricityPerHour, 0.12), fail = Math.min(Math.max(num(params.failurePct, 5), 0), 60) / 100; const inflate = 1 / (1 - fail);
  const parts = partResults(design, st); const unit = parts.reduce((a, p) => ({ grams: a.grams + p.grams * p.qty, hours: a.hours + p.hours * p.qty, material: a.material + p.materialCost * p.qty }), { grams: 0, hours: 0, material: 0 });
  const unitMachine = unit.hours * (rate + power); const unitCost = (unit.material + unitMachine) * inflate;
  // spread the jobs over the printers, longest first
  const jobs = []; for (const p of parts) for (let i = 0; i < p.qty * qty; i++) jobs.push(p.hours * inflate); jobs.sort((a, b) => b - a); const load = Array(printers).fill(0); for (const j of jobs) { let k = 0; for (let i = 1; i < printers; i++) if (load[i] < load[k]) k = i; load[k] += j; }
  const warnings = parts.reduce((s, p) => s + p.warnings.length, 0); const misfit = parts.filter((p) => !p.fits).length;
  return { settings: st, quantity: qty, printers, parts, perUnit: { grams: round(unit.grams, 1), hours: round(unit.hours, 2), material: round(unit.material, 2), machine: round(unitMachine, 2), cost: round(unitCost, 2) },
    totals: { hours: round(unit.hours * qty * inflate, 1), materialCost: round(unit.material * qty * inflate, 2), cost: round(unitCost * qty, 2), daysToFinish: round(Math.max(...load) / 8, 1), grams: round(unit.grams * qty * inflate, 0) },
    partCount: parts.reduce((s, p) => s + p.qty, 0), partsNotFitting: misfit, warningCount: warnings,
    assumptions: { machineRatePerHour: rate, electricityPerHour: power, failurePct: fail * 100, hoursPerDay: 8, note: 'Material prices and print times are estimates from the settings in the design. Replace the machine rate, electricity and failure rate with your own, and check one part in your slicer.' } };
}
const headline = (r) => ({ unitCost: r.perUnit.cost, totalHours: r.totals.hours, daysToFinish: r.totals.daysToFinish, partsNotFitting: r.partsNotFitting, warnings: r.warningCount });
const DIRECTION = { unitCost: 'lower', totalHours: 'lower', daysToFinish: 'lower', partsNotFitting: 'lower', warnings: 'lower' };

const VOLUMES = [1, 10, 50, 100, 500, 1000, 5000];
function economics({ design, params = {} }) {
  const pr = run({ design, params: { quantity: 1, printers: 1, machineRatePerHour: params.machineRatePerHour, electricityPerHour: params.electricityPerHour, failurePct: params.failurePct } });
  const bomPerUnit = (design.bom || []).reduce((s, b) => s + num(b.qty, 1) * num(b.unitCost, 0), 0); const price = num(params.price ?? design.price, 0), labour = num(params.assemblyMinutes, 30) / 60 * num(params.labourPerHour, 6);
  const tooling = num(params.toolingPerPart, 4000), mouldFactor = num(params.mouldedMaterialFactor, 0.6), cycle = num(params.mouldedCyclePerPart, 0.35); const nTypes = design.parts.filter((p) => !pr.parts.find((x) => x.id === p.id && x.error)).length; const pcs = pr.partCount;
  const printUnit = pr.perUnit.cost; const mouldUnit = pr.perUnit.material * mouldFactor + pcs * cycle;
  const rows = VOLUMES.map((v) => { const mould = mouldUnit + tooling * nTypes / v; const method = mould < printUnit ? 'moulding' : 'printing'; const parts = Math.min(printUnit, mould); const cost = parts + bomPerUnit + labour; return { volume: v, printed: round(printUnit + bomPerUnit + labour, 2), moulded: round(mould + bomPerUnit + labour, 2), method, cost: round(cost, 2), marginPct: price ? round(100 * (price - cost) / price, 1) : null, profit: price ? round((price - cost) * v, 0) : null }; });
  const diff = printUnit - mouldUnit; const breakEven = diff > 0 ? Math.ceil(tooling * nTypes / diff) : null; const at100 = rows.find((r) => r.volume === 100), at1000 = rows.find((r) => r.volume === 1000);
  return { price, bomPerUnit: round(bomPerUnit, 2), labourPerUnit: round(labour, 2), printPartsPerUnit: round(printUnit, 2), mouldPartsPerUnit: round(mouldUnit, 2), toolingTotal: round(tooling * nTypes, 0), partTypes: nTypes, rows, breakEvenUnits: breakEven, bestAt1000: at1000.method,
    assumptions: { toolingPerPart: tooling, mouldedMaterialFactor: mouldFactor, mouldedCyclePerPart: cycle, assemblyMinutes: num(params.assemblyMinutes, 30), labourPerHour: num(params.labourPerHour, 6), note: 'Moulding costs are rough assumptions. Ask a moulder for a quote before you decide. Tooling here is per different part, and the same for every part.' }, printSettings: pr.settings };
}
const economicsHeadline = (r) => { const a = r.rows.find((x) => x.volume === 100); return { unitCostAt100: a.cost, marginPctAt100: a.marginPct, breakEvenUnits: r.breakEvenUnits, bestMethodAt1000: r.bestAt1000 === 'moulding' ? 1 : 0 }; };
const economicsDirection = { unitCostAt100: 'lower', marginPctAt100: 'higher', breakEvenUnits: 'info', bestMethodAt1000: 'info' };

/** The Coach only drafts. It looks for cheaper print settings that do not add problems. */
function coachPrint(design, params, seed, base) {
  const nozzle = (design.printSettings || {}).nozzle || 0.4; const cands = []; for (const infill of [10, 15, 20, 30, 40]) for (const lh of [0.12, 0.16, 0.2, 0.24, 0.28]) { if (lh > nozzle * 0.75) continue; const d = { ...design, printSettings: { ...design.printSettings, infillPct: infill, layerHeight: lh } }; const r = run({ design: d, params }); cands.push({ infill, lh, cost: r.perUnit.cost, hours: r.totals.hours, warn: r.warningCount, misfit: r.partsNotFitting, design: d }); }
  const ok = cands.filter((c) => c.warn <= base.warningCount && c.misfit <= base.partsNotFitting).sort((a, b) => a.cost + a.hours * 0.05 - (b.cost + b.hours * 0.05));
  const best = ok[0]; if (!best || best.cost >= base.perUnit.cost * 0.98) return { suggestions: [], message: `Checked ${cands.length} combinations of infill and layer height. The current settings are already about as cheap as they get without adding problems.` };
  return { suggestions: [{ title: 'Cheaper print settings', changes: [`Infill ${best.infill}% (now ${base.settings.infillPct}%)`, `Layer height ${best.lh} mm (now ${base.settings.layerHeight} mm)`], expected: { unitCost: { from: base.perUnit.cost, to: best.cost }, totalHours: { from: base.totals.hours, to: best.hours } }, confidence: 'Strength is not modelled. Print one part and test it before you commit to lower infill.', draft: { kind: 'hardware_design', data: best.design } }], message: `Checked ${cands.length} combinations.` };
}
function coachEconomics(design, params, seed, base) {
  const target = num(params.targetMarginPct, 40); const bom = base.bomPerUnit, at = (p) => base.rows.find((r) => r.volume === 100); void at;
  const cost100 = base.rows.find((r) => r.volume === 100).cost; const price = Math.ceil(cost100 / (1 - target / 100)); if (base.price && base.price >= price) return { suggestions: [], message: `At 100 units the price already gives a margin of at least ${target}%.` };
  return { suggestions: [{ title: `Price for a ${target}% margin at 100 units`, changes: [`Set the price to ${price} (now ${base.price || 'not set'})`], expected: { marginPctAt100: { from: base.rows.find((r) => r.volume === 100).marginPct, to: round(100 * (price - cost100) / price, 1) } }, confidence: `Unit cost at 100 is ${cost100}, with ${bom} of bought parts. Check that buyers will pay this.`, draft: { kind: 'hardware_design', data: { ...design, price } } }], message: 'Priced from the unit cost at 100 units.' };
}
module.exports = { printRun: { run, headline, DIRECTION, DEFAULT_DESIGN, coach: coachPrint }, economics: { run: economics, headline: economicsHeadline, DIRECTION: economicsDirection, DEFAULT_DESIGN, coach: coachEconomics }, DEFAULT_DESIGN };
